using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using LanPower.Shared;

namespace LanPower.CodexHost;

public sealed class RemoteImages
{
    private readonly ConcurrentDictionary<string, HashSet<string>> _references = new();
    private static readonly Regex MarkdownImage = new(@"!\[[^\]]*\]\((?:<([^>]+)>|([^\r\n)]+))\)", RegexOptions.CultureInvariant);
    private static readonly Regex AttachmentSection = new(@"\A# Files mentioned by the user:[ \t]*\r?\n(?<files>[\s\S]*?)\r?\n## My request(?: for Codex)?:[ \t]*(?:\r?\n|$)", RegexOptions.CultureInvariant);
    private static readonly Regex Attachment = new(@"^## [^\r\n]+?:[ \t]*(?<inline>[^\r\n]*)\r?\n(?<details>[\s\S]*?)(?=^## |\z)", RegexOptions.Multiline | RegexOptions.CultureInvariant);
    private static readonly Regex ImageAttachment = new(@"^Image attachment:[ \t]*true[ \t]*\r?$", RegexOptions.Multiline | RegexOptions.CultureInvariant);

    public void Observe(string threadId, JsonNode? content)
    {
        if (_references.Count >= 128 && !_references.ContainsKey(threadId)) _references.TryRemove(_references.Keys.First(), out _);
        var paths = _references.GetOrAdd(threadId, _ => new(StringComparer.OrdinalIgnoreCase));
        lock (paths) Visit(content);
        void Add(string value)
        {
            try { var path = Normalize(value); if (Path.IsPathFullyQualified(path)) paths.Add(path); } catch (ArgumentException) { }
        }
        void Visit(JsonNode? value, string? key = null)
        {
            if (value is JsonObject obj)
            {
                if (obj["type"] is JsonValue type && type.TryGetValue<string>(out var name) && name.Equals("userMessage", StringComparison.OrdinalIgnoreCase))
                {
                    var text = obj["content"] is JsonArray blocks ? string.Join("\n", blocks.OfType<JsonObject>()
                        .Where(block => block["type"]?.GetValue<string>() is "text" or "Text" or "input_text").Select(block => block["text"]?.GetValue<string>() ?? "")) : "";
                    var section = AttachmentSection.Match(text);
                    if (section.Success) foreach (Match attachment in Attachment.Matches(section.Groups["files"].Value))
                    {
                        var details = attachment.Groups["details"].Value;
                        if (!ImageAttachment.IsMatch(details)) continue;
                        var path = attachment.Groups["inline"].Value.Trim();
                        if (path.Length == 0) path = details.Split('\n').Select(line => line.Trim()).FirstOrDefault(line => line.Length > 0) ?? "";
                        Add(path);
                    }
                }
                foreach (var entry in obj) Visit(entry.Value, entry.Key);
            }
            else if (value is JsonArray array) { foreach (var item in array) Visit(item, key); }
            else if (value is JsonValue scalar && scalar.TryGetValue<string>(out var text))
            {
                if (key is "url" or "path" or "image_path" or "imagePath" or "image_url" or "imageUrl" or "localImage" or "savedPath") Add(text);
                if (key is "text" or "message" or "output")
                    foreach (Match match in MarkdownImage.Matches(text)) Add(match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value);
            }
        }
    }

    private static string Normalize(string path)
    {
        if (path.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) path = new Uri(path).LocalPath;
        return Path.IsPathFullyQualified(path) ? Path.GetFullPath(path) : path;
    }

    public JsonObject Read(CodexHostSettings scope, string cwd, string threadId, string path)
    {
        if (!scope.Allows(cwd)) throw new InvalidDataException("workspace_not_allowed");
        path = Normalize(path);
        string resolved;
        try { resolved = RemoteWorkspace.Resolve(scope, cwd, path); }
        catch (InvalidDataException)
        {
            if (!_references.TryGetValue(threadId, out var paths)) throw;
            lock (paths) if (!paths.Contains(path)) throw new InvalidDataException("image_not_referenced");
            resolved = path;
            for (var part = resolved; !string.IsNullOrEmpty(part); part = Path.GetDirectoryName(part))
                if ((File.Exists(part) || Directory.Exists(part)) && (File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("workspace_not_allowed");
        }
        using var stream = new FileStream(resolved, FileMode.Open, FileAccess.Read, FileShare.Read);
        var bytes = new byte[checked((int)stream.Length)]; stream.ReadExactly(bytes);
        var mime = bytes.AsSpan().StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ? "image/png" :
            bytes.AsSpan().StartsWith(new byte[] { 255, 216, 255 }) ? "image/jpeg" :
            bytes.AsSpan().StartsWith("GIF87a"u8) || bytes.AsSpan().StartsWith("GIF89a"u8) ? "image/gif" :
            bytes.Length >= 12 && bytes.AsSpan(0, 4).SequenceEqual("RIFF"u8) && bytes.AsSpan(8, 4).SequenceEqual("WEBP"u8) ? "image/webp" :
            bytes.AsSpan().StartsWith("BM"u8) ? "image/bmp" : null;
        if (mime is null) throw new InvalidDataException("unsupported_image");
        return new() { ["contentType"] = mime, ["base64"] = Convert.ToBase64String(bytes), ["size"] = bytes.Length };
    }
}
