using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using LanPower.Shared;

namespace LanPower.CodexHost;

public static class RemoteWorkspace
{
    public static async Task<JsonObject> UploadAsync(CodexHostSettings scope, string cwd, string name, string base64, CancellationToken token, string? stagingRoot = null)
    {
        if (!scope.Allows(cwd)) throw new InvalidDataException("workspace_not_allowed");
        if (string.IsNullOrWhiteSpace(name) || name is "." or ".." || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name != Path.GetFileName(name))
            throw new InvalidDataException("invalid_file_name");
        byte[] data;
        try { data = Convert.FromBase64String(base64); } catch (FormatException) { throw new InvalidDataException("invalid_file_data"); }
        var root = stagingRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LanPower", "CodexAttachments");
        Directory.CreateDirectory(root);
        if (!CodexProjects.SafeDirectory(root)) throw new InvalidDataException("workspace_not_allowed");
        var directory = Path.Combine(root, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, name);
        try
        {
            await using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous);
            await file.WriteAsync(data, token);
            return new() { ["path"] = path, ["size"] = data.Length };
        }
        catch { if (File.Exists(path)) File.Delete(path); throw; }
    }

    public static string Resolve(CodexHostSettings scope, string cwd, string? path)
    {
        if (!scope.Allows(cwd)) throw new InvalidDataException("workspace_not_allowed");
        var root = CodexHostSettings.Canonical(cwd).TrimEnd(Path.DirectorySeparatorChar);
        var resolved = Path.GetFullPath(Path.Combine(root, path ?? ""));
        if (!resolved.Equals(root, StringComparison.OrdinalIgnoreCase) && !resolved.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("workspace_not_allowed");
        for (var item = resolved; item.Length >= root.Length; item = Path.GetDirectoryName(item) ?? "")
            if ((File.Exists(item) || Directory.Exists(item)) && (File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("workspace_not_allowed");
        return resolved;
    }

    public static JsonObject List(CodexHostSettings scope, string cwd, string? path, int offset)
    {
        var directory = Resolve(scope, cwd, path);
        var rows = Directory.EnumerateFileSystemEntries(directory)
            .Select(entry => new FileInfo(entry)).Where(entry => (entry.Attributes & FileAttributes.ReparsePoint) == 0)
            .OrderBy(entry => (entry.Attributes & FileAttributes.Directory) == 0).ThenBy(entry => entry.Name, StringComparer.OrdinalIgnoreCase).ToArray();
        if (offset < 0 || offset > rows.Length) throw new InvalidDataException("invalid_cursor");
        return new() { ["path"] = Path.GetRelativePath(cwd, directory), ["branch"] = Branch(scope, cwd),
            ["data"] = new JsonArray(rows.Skip(offset).Take(100).Select(entry => (JsonNode)new JsonObject {
                ["name"] = entry.Name, ["path"] = Path.GetRelativePath(cwd, entry.FullName), ["directory"] = (entry.Attributes & FileAttributes.Directory) != 0 }).ToArray()),
            ["nextCursor"] = offset + 100 < rows.Length ? (offset + 100).ToString() : null, ["truncated"] = false };
    }

    public static JsonObject Read(CodexHostSettings scope, string cwd, string path)
    {
        var resolved = Resolve(scope, cwd, path); var info = new FileInfo(resolved);
        var data = File.ReadAllBytes(resolved);
        if (data.Contains((byte)0)) return new() { ["path"] = path, ["size"] = data.Length, ["binary"] = true };
        return new() { ["path"] = path, ["size"] = data.Length, ["content"] = Encoding.UTF8.GetString(data).TrimStart('\uFEFF') };
    }

    public static JsonObject Search(CodexHostSettings scope, string cwd, string query)
    {
        var root = Resolve(scope, cwd, ""); var pending = new Queue<(string Path, int Depth)>(); pending.Enqueue((root,0));
        var result = new JsonArray();
        while (pending.TryDequeue(out var directory))
            foreach (var path in Directory.EnumerateFileSystemEntries(directory.Path))
            {
                var info = new FileInfo(path); if ((info.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                var relative = Path.GetRelativePath(root,path);
                if ((info.Attributes & FileAttributes.Directory) != 0)
                { if (info.Name is not (".git" or "node_modules" or ".venv" or "bin" or "obj")) pending.Enqueue((path,directory.Depth+1)); }
                else if (relative.Contains(query, StringComparison.OrdinalIgnoreCase)) result.Add(new JsonObject { ["path"] = relative.Replace('\\','/'), ["fsPath"] = path });
            }
        return new() { ["data"] = result, ["truncated"] = false };
    }

    private static string? Branch(CodexHostSettings scope, string cwd)
    {
        try {
            var head = Resolve(scope, cwd, ".git/HEAD");
            if (!File.Exists(head) || new FileInfo(head).Length > 1000) return null;
            var text = File.ReadAllText(head).Trim(); return text.StartsWith("ref: refs/heads/", StringComparison.Ordinal) ? text[16..] : text.Length >= 7 ? text[..7] : null;
        } catch (IOException) { return null; }
    }

    public static JsonObject Automations(CodexHostSettings scope)
    {
        var root = Path.Combine(CodexProjects.Home,"automations"); var result = new JsonArray();
        if (!Directory.Exists(root) || (File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) return new() { ["data"] = result };
        foreach (var folder in Directory.EnumerateDirectories(root))
        {
            if ((File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) continue;
            var file = Path.Combine(folder,"automation.toml");
            if (!File.Exists(file) || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) continue;
            var text = File.ReadAllText(file);
            var match = Regex.Match(text, @"(?m)^cwds\s*=\s*(\[[^\r\n]*\])");
            JsonArray cwds; try { cwds = JsonNode.Parse(match.Groups[1].Value) as JsonArray ?? []; } catch { continue; }
            if (cwds.Count == 0 || cwds.Any(c => !scope.Allows(c?.GetValue<string>()))) continue;
            string Scalar(string name) { var m = Regex.Match(text, "(?m)^" + name + @"\s*=\s*(\""(?:[^\""\\]|\\.)*\""|'[^']*')"); if (!m.Success) return ""; var value = m.Groups[1].Value; try { return value[0] == '\'' ? value[1..^1] : JsonNode.Parse(value)?.GetValue<string>() ?? ""; } catch { return ""; } }
            result.Add(new JsonObject { ["id"] = Path.GetFileName(folder), ["name"] = Scalar("name"), ["status"] = Scalar("status"), ["rrule"] = Scalar("rrule"), ["cwds"] = cwds });
        }
        return new() { ["data"] = result, ["managedOnDesktop"] = true };
    }
}
