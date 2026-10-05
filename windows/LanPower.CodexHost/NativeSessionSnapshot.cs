using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.CodexHost;

// Read-only observation of the desktop writer. Never resumes a thread or reads authentication files.
public static class NativeSessionSnapshot
{
    private const int TailBytes = 4 * 1024 * 1024;
    private const int LineBytes = 1024 * 1024;
    private static readonly Dictionary<string, (long Length, DateTime Write, JsonObject Value)> Cache = new();

    public static JsonObject? Read(string id, string? path, string cwd)
    {
        if (!Guid.TryParse(id, out _)) return null;
        try
        {
            var root = Path.GetFullPath(Path.Combine(CodexProjects.Home, "sessions"));
            // Rust's canonical Windows paths may use the extended local-drive prefix.
            if (path is not null && path.StartsWith(@"\\?\") && path.Length > 6 && char.IsAsciiLetter(path[4]) && path[5] == ':' && path[6] == '\\') path = path[4..];
            if (path is null || !SafePath(path, root, id)) return null;
            var info = new FileInfo(path);
            lock (Cache)
                if (Cache.TryGetValue(path, out var cached) && cached.Length == info.Length && cached.Write == info.LastWriteTimeUtc)
                {
                    var copy = (JsonObject)cached.Value.DeepClone();
                    if (copy["turns"]?.AsArray().LastOrDefault()?["status"]?.GetValue<string>() == "inProgress")
                        copy["live"]!["state"] = CodexProjects.DesktopOwns(id) ? "running" : "unknown";
                    return copy;
                }
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using (var header = new StreamReader(file, Encoding.UTF8, false, 4096, true))
            {
                var first = ReadLine(header);
                if (first is null || JsonNode.Parse(first) is not JsonObject meta ||
                    meta["type"]?.GetValue<string>() != "session_meta" || meta["payload"]?["id"]?.GetValue<string>() != id ||
                    meta["payload"]?["cwd"]?.GetValue<string>() is not { } recorded ||
                    !CodexHostSettings.Canonical(recorded).Equals(CodexHostSettings.Canonical(cwd), StringComparison.OrdinalIgnoreCase)) return null;
            }
            var tail = file.Length > TailBytes;
            file.Position = tail ? file.Length - TailBytes : 0;
            using var reader = new StreamReader(file, Encoding.UTF8, false, 4096, true);
            if (tail) ReadLine(reader); // A tail starts inside a UTF-8 line; discard that partial record.
            var turns = new List<JsonObject>();
            var settings = new JsonObject();
            JsonObject? current = null;
            string? action = null;
            JsonObject Turn(string turnId)
            {
                var found = turns.FirstOrDefault(t => t["id"]?.GetValue<string>() == turnId);
                if (found is not null) return found;
                var value = new JsonObject { ["id"] = turnId, ["status"] = "unknown", ["items"] = new JsonArray() };
                turns.Add(value); if (turns.Count > 8) turns.RemoveAt(0); return value;
            }
            void Add(JsonObject item)
            {
                if (current is null) return;
                var items = current["items"]!.AsArray();
                var itemId = item["id"]?.GetValue<string>();
                var old = items.FirstOrDefault(i => i?["id"]?.GetValue<string>() == itemId);
                if (old is not null) items.Remove(old);
                items.Add(item); while (items.Count > 80 || items.ToJsonString().Length > 100000) items.RemoveAt(0);
            }
            while (!reader.EndOfStream)
            {
                var line = ReadLine(reader);
                if (line is null) continue;
                JsonObject? row; try { row = JsonNode.Parse(line) as JsonObject; } catch (JsonException) { continue; }
                if (row?["payload"] is not JsonObject payload) continue;
                var kind = row["type"]?.GetValue<string>();
                var type = payload["type"]?.GetValue<string>();
                var turnId = payload["turn_id"]?.GetValue<string>();
                if (kind == "turn_context")
                {
                    if (turnId is not null) current = Turn(turnId);
                    ReadSettings(settings, payload);
                }
                if (kind == "event_msg")
                {
                    if (type == "task_started" && turnId is not null)
                    {
                        current = Turn(turnId); current["status"] = "inProgress";
                        current["startedAt"] = Seconds(payload["started_at"] ?? row["timestamp"]); action = null;
                    }
                    else if (type is "task_complete" or "turn_aborted" && turnId is not null)
                    {
                        var completed = Turn(turnId); completed["status"] = type == "turn_aborted" ? "interrupted" : "completed";
                        completed["completedAt"] = Seconds(payload["completed_at"] ?? row["timestamp"]);
                        completed["durationMs"] = payload["duration_ms"]?.DeepClone();
                    }
                    else if (type is "item_started" or "item_completed" && payload["item"] is JsonObject nativeItem)
                    {
                        if (turnId is not null) current = Turn(turnId);
                        var item = Normalize(nativeItem);
                        if (item is not null) { Add(item); if (type == "item_started") action = item["type"]?.GetValue<string>() == "commandExecution" ? "正在执行本机操作" : "正在处理任务"; }
                    }
                    else if (type == "user_message" && current is not null)
                        Add(new() { ["id"] = "user-" + current["id"]!.GetValue<string>(), ["type"] = "userMessage",
                            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = Clip(payload["message"]?.GetValue<string>() ?? "") }) });
                }
                // Old desktop versions persist public replies without item_completed; never relay reasoning or context.
                else if (kind == "response_item" && type == "message" && payload["role"]?.GetValue<string>() == "assistant" &&
                    payload["phase"]?.GetValue<string>() is "commentary" or "final_answer")
                {
                    var text = Text(payload["content"]);
                    if (!string.IsNullOrWhiteSpace(text) && current is not null && !current["items"]!.AsArray().Any(i => i?["text"]?.GetValue<string>() == text))
                        Add(new() { ["id"] = payload["id"]?.DeepClone() ?? JsonValue.Create("reply-" + turns.IndexOf(current) + "-" + current["items"]!.AsArray().Count),
                            ["type"] = "agentMessage", ["text"] = text, ["phase"] = payload["phase"]?.DeepClone() });
                }
                else if (kind == "response_item" && type is "function_call" or "custom_tool_call" && current is not null)
                {
                    var name = payload["name"]?.GetValue<string>() ?? "本机工具";
                    // Relay the tool name and lifecycle only; raw arguments can contain private runtime context.
                    name = new string(name.Where(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-').Take(80).ToArray());
                    var callId = payload["call_id"]?.GetValue<string>() ?? payload["id"]?.GetValue<string>();
                    if (callId is not null) Add(new() { ["id"] = callId, ["type"] = "toolActivity", ["text"] = "调用工具 · " + name, ["status"] = "inProgress" });
                    action = "正在调用工具 · " + name;
                }
                else if (kind == "response_item" && type is "function_call_output" or "custom_tool_call_output" && current is not null)
                {
                    var callId = payload["call_id"]?.GetValue<string>();
                    var item = current["items"]!.AsArray().OfType<JsonObject>().FirstOrDefault(i => i["id"]?.GetValue<string>() == callId);
                    if (item is not null) { item["status"] = "completed"; action = "最近活动：" + item["text"]?.GetValue<string>(); }
                }
            }
            var last = turns.LastOrDefault();
            if (tail && settings.Count == 0) settings = EarlierSettings(path);
            if (last is not null && (last["startedAt"] is null || last["status"]?.GetValue<string>() == "unknown") &&
                Lifecycle(path, last["id"]!.GetValue<string>()) is { } lifecycle)
            {
                if (last["status"]?.GetValue<string>() == "unknown") last["status"] = lifecycle["status"]?.DeepClone();
                foreach (var key in new[] { "startedAt", "completedAt", "durationMs" }) if (last[key] is null) last[key] = lifecycle[key]?.DeepClone();
                if (lifecycle["user"] is JsonObject user && !last["items"]!.AsArray().Any(i => i?["type"]?.GetValue<string>() == "userMessage")) last["items"]!.AsArray().Insert(0, user.DeepClone());
            }
            var running = last?["status"]?.GetValue<string>() == "inProgress" && CodexProjects.DesktopOwns(id);
            var live = new JsonObject { ["source"] = "localSession", ["state"] = running ? "running" :
                last?["status"]?.GetValue<string>() is "completed" or "interrupted" ? "idle" : "unknown",
                ["turnId"] = last?["id"]?.DeepClone(), ["startedAt"] = last?["startedAt"]?.DeepClone(),
                ["updatedAt"] = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeSeconds(), ["action"] = running ? action : null };
            var bounded = new JsonArray();
            foreach (var turn in turns.AsEnumerable().Reverse())
            {
                bounded.Insert(0, turn.DeepClone());
                if (bounded.ToJsonString().Length > 240000) { bounded.RemoveAt(0); break; }
            }
            var snapshot = new JsonObject { ["turns"] = bounded, ["live"] = live, ["settings"] = settings, ["historyTruncated"] = tail || turns.Count >= 8 };
            lock (Cache)
            {
                if (Cache.Count >= 32) Cache.Remove(Cache.Keys.First());
                // Ownership is dynamic even when the file is unchanged, so cache only parsed history.
                Cache[path] = (info.Length, info.LastWriteTimeUtc, (JsonObject)snapshot.DeepClone());
            }
            return snapshot;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException or InvalidOperationException) { return null; }
    }

    private static bool SafePath(string path, string root, string id)
    {
        if (!Path.IsPathFullyQualified(path)) return false;
        var full = Path.GetFullPath(path);
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(full).EndsWith("-" + id + ".jsonl", StringComparison.OrdinalIgnoreCase)) return false;
        for (var current = full; current is not null; current = Path.GetDirectoryName(current))
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return false;
            if (current.Equals(root, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string? ReadLine(StreamReader reader)
    {
        var text = new StringBuilder(); var overflow = false;
        while (reader.Read() is var next && next >= 0)
        {
            if (next == '\n') return overflow ? null : text.ToString().TrimEnd('\r');
            if (text.Length < LineBytes) text.Append((char)next); else overflow = true;
        }
        // The writer may still be appending this line; incomplete records are retried on the next observation.
        return null;
    }
    private static void ReadSettings(JsonObject settings, JsonObject payload)
    {
        if (payload["model"] is JsonValue model && model.TryGetValue<string>(out var name) && name.Length <= 256) settings["model"] = name;
        var effort = payload["effort"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
        if (payload.ContainsKey("effort") && (payload["effort"] is null || effort is "none" or "minimal" or "low" or "medium" or "high" or "xhigh" or "max" or "ultra")) settings["reasoningEffort"] = effort;
        if (payload["collaboration_mode"] is JsonObject collaboration && collaboration["mode"] is JsonValue modeValue && modeValue.TryGetValue<string>(out var mode) && mode is "default" or "plan")
            settings["collaborationMode"] = new JsonObject { ["mode"] = mode };
    }

    private static JsonObject EarlierSettings(string path)
    {
        // A large tool result can push the last send settings outside the message tail.
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var position = file.Length; var suffix = ""; var buffer = new byte[256 * 1024];
        while (position > 0)
        {
            var start = Math.Max(0, position - buffer.Length); file.Position = start;
            var count = file.Read(buffer, 0, (int)(position - start));
            var lines = (Encoding.UTF8.GetString(buffer, 0, count) + suffix).Split('\n');
            for (var index = lines.Length - 2; index >= (start == 0 ? 0 : 1); index--)
            {
                var line = lines[index]; if (line.Length > LineBytes || !line.Contains("turn_context")) continue;
                JsonObject? row; try { row = JsonNode.Parse(line) as JsonObject; } catch (JsonException) { continue; }
                if (row?["type"]?.GetValue<string>() != "turn_context" || row["payload"] is not JsonObject payload) continue;
                var settings = new JsonObject(); ReadSettings(settings, payload); if (settings.Count > 0) return settings;
            }
            suffix = lines[0].Length <= LineBytes ? lines[0] + "\n" : "\n"; position = start;
        }
        return new();
    }

    private static JsonObject? Lifecycle(string path, string turnId)
    {
        // A long running turn can outgrow the bounded message tail. Search backward for its actual
        // lifecycle record, examining only public event metadata and the original user message.
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var position = file.Length; var suffix = ""; var buffer = new byte[256 * 1024]; JsonObject? user = null;
        JsonObject? completed = null;
        while (position > 0)
        {
            var start = Math.Max(0, position - buffer.Length); file.Position = start;
            var count = file.Read(buffer, 0, (int)(position - start));
            var lines = (Encoding.UTF8.GetString(buffer, 0, count) + suffix).Split('\n');
            for (var index = lines.Length - 2; index >= (start == 0 ? 0 : 1); index--)
            {
                var line = lines[index];
                if (line.Length > LineBytes || !line.Contains("task_started") && !line.Contains("task_complete") &&
                    !line.Contains("turn_aborted") && !line.Contains("UserMessage")) continue;
                JsonObject? row; try { row = JsonNode.Parse(line) as JsonObject; } catch (JsonException) { continue; }
                if (row?["type"]?.GetValue<string>() != "event_msg" || row["payload"] is not JsonObject payload || payload["turn_id"]?.GetValue<string>() != turnId) continue;
                var type = payload["type"]?.GetValue<string>();
                if (type == "item_completed" && payload["item"] is JsonObject item && item["type"]?.GetValue<string>() == "UserMessage") user ??= Normalize(item);
                if (type is "task_complete" or "turn_aborted")
                    completed ??= new() { ["status"] = type == "turn_aborted" ? "interrupted" : "completed", ["startedAt"] = Seconds(payload["started_at"]),
                        ["completedAt"] = Seconds(payload["completed_at"] ?? row["timestamp"]), ["durationMs"] = payload["duration_ms"]?.DeepClone() };
                if (type == "task_started")
                {
                    var result = completed ?? new JsonObject { ["status"] = "inProgress" };
                    result["startedAt"] ??= Seconds(payload["started_at"] ?? row["timestamp"]); result["user"] = user?.DeepClone(); return result;
                }
            }
            suffix = lines[0].Length <= LineBytes ? lines[0] + "\n" : "\n"; position = start;
        }
        if (completed is not null) completed["user"] = user?.DeepClone(); return completed;
    }
    private static long? Seconds(JsonNode? node)
    {
        if (node is JsonValue v && v.TryGetValue<long>(out var number)) return number > 100000000000 ? number / 1000 : number;
        return node is JsonValue s && s.TryGetValue<string>(out var text) && DateTimeOffset.TryParse(text, out var date) ? date.ToUnixTimeSeconds() : null;
    }
    private static string Clip(string text) => text.Length > 8000 ? text[..8000] + "\n…内容较长，请在电脑查看完整输出" : text;
    private static string Text(JsonNode? content) => Clip(content is JsonValue value && value.TryGetValue<string>(out var text) ? text :
        string.Join("\n", (content as JsonArray ?? new()).OfType<JsonObject>().Where(c => c["type"]?.GetValue<string>() is "text" or "Text" or "output_text" or "input_text")
            .Select(c => c["text"]?.GetValue<string>() ?? "")));
    private static JsonObject? Normalize(JsonObject item)
    {
        var type = item["type"]?.GetValue<string>() ?? "";
        type = type.Length == 0 ? type : char.ToLowerInvariant(type[0]) + type[1..];
        var id = item["id"]?.GetValue<string>(); if (id is null) return null;
        var result = new JsonObject { ["id"] = id, ["type"] = type };
        if (type == "userMessage")
        {
            var blocks = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = Text(item["content"]) });
            if (item["content"] is JsonArray content) foreach (var block in content.OfType<JsonObject>())
            {
                var kind = block["type"]?.GetValue<string>()?.ToLowerInvariant();
                if (kind is not ("image" or "localimage" or "input_image" or "image_url")) continue;
                var source = block["path"] ?? block["url"] ?? (block["image_url"] is JsonObject image ? image["url"] : block["image_url"]);
                if (source is JsonValue scalar && scalar.TryGetValue<string>(out var path) && path.Length > 0)
                    blocks.Add(new JsonObject { ["type"] = kind == "localimage" ? "localImage" : "image", [kind == "localimage" ? "path" : "url"] = path });
            }
            result["content"] = blocks;
        }
        else if (type is "agentMessage" or "plan") { result["text"] = Text(item["content"] ?? item["text"]); result["phase"] = item["phase"]?.DeepClone(); }
        else if (type == "commandExecution")
        {
            result["command"] = Clip(item["command"] is JsonValue command && command.TryGetValue<string>(out var raw) ? raw : "本机命令");
            result["aggregatedOutput"] = Clip(item["aggregated_output"]?.GetValue<string>() ?? item["aggregatedOutput"]?.GetValue<string>() ?? "");
            result["status"] = item["status"]?.DeepClone();
        }
        else if (type == "fileChange")
        {
            var changes = new JsonArray();
            if (item["changes"] is JsonArray array)
                foreach (var change in array.OfType<JsonObject>().Take(32))
                    changes.Add(new JsonObject { ["path"] = Clip(change["path"]?.GetValue<string>() ?? ""), ["diff"] = Clip(change["diff"]?.GetValue<string>() ?? "") });
            else if (item["changes"] is JsonObject files)
                foreach (var change in files.Take(32))
                    changes.Add(new JsonObject { ["path"] = Clip(change.Key), ["diff"] = Clip(change.Value?["unified_diff"]?.GetValue<string>() ?? change.Value?["diff"]?.GetValue<string>() ?? "") });
            result["changes"] = changes; result["status"] = item["status"]?.DeepClone();
        }
        else return null;
        return result;
    }
}
