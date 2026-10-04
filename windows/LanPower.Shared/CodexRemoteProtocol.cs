using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace LanPower.Shared;

public static class CodexRemoteProtocol
{
    public static readonly JsonSerializerOptions JsonOptions = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<StreamReader, BoundedReader> Readers = new();
    public const int MaxFrame = 1024 * 1024;
    public const string PipeName = "LanPower.CodexHost";
    public const string WebSocketProtocol = "lanpower.codex.v1";
    public static readonly IReadOnlyDictionary<string, string[]> Fields = new Dictionary<string, string[]>
    {
        ["lanpower/status"] = [], ["lanpower/session/release"] = ["threadId"], ["model/list"] = ["cursor", "limit"],
        ["lanpower/chat/start"] = ["model"], ["skills/list"] = ["cwd", "cursor", "limit", "refresh"], ["lanpower/automations/list"] = [],
        ["lanpower/files/list"] = ["cwd", "path", "cursor"], ["lanpower/files/read"] = ["cwd", "path"],
        ["lanpower/files/search"] = ["cwd", "query"],
        ["lanpower/library/update"] = ["revision", "preferences"], ["lanpower/image/read"] = ["threadId", "path"],
        ["lanpower/library/list"] = ["query", "cursor", "limit", "archived", "refresh"], ["lanpower/library/check"] = ["threadIds", "archived"],
        ["lanpower/submission/read"] = ["threadId", "submissionId"], ["lanpower/history/item/read"] = ["threadId", "reference", "offset"],
        ["lanpower/history/action"] = ["threadId", "turnId", "expectedTailTurnId", "action"],
        ["plugin/list"] = ["cwd", "cursor", "limit", "refresh"], ["app/list"] = ["cursor", "limit", "threadId"], ["mcpServerStatus/list"] = ["cursor", "limit"],
        ["config/mcpServer/reload"] = [], ["account/rateLimits/read"] = [], ["collaborationMode/list"] = [],
        ["thread/list"] = ["cursor", "limit", "cwd", "archived"],
        ["thread/start"] = ["cwd", "model"], ["thread/resume"] = ["threadId"],
        ["thread/read"] = ["threadId", "includeTurns", "historyLimit"], ["thread/name/set"] = ["threadId", "name"],
        ["thread/turns/list"] = ["threadId", "cursor", "limit"],
        ["thread/fork"] = ["threadId"], ["thread/rollback"] = ["threadId", "numTurns"],
        ["thread/archive"] = ["threadId"], ["thread/unarchive"] = ["threadId"],
        ["thread/queue/add"] = ["threadId", "input", "clientUserMessageId", "submissionId"],
        ["thread/queue/list"] = ["threadId", "cursor", "limit"],
        ["thread/queue/update"] = ["threadId", "queuedSubmissionId", "input", "submissionId"],
        ["thread/queue/delete"] = ["threadId", "queuedSubmissionId"],
        ["thread/queue/start"] = ["threadId", "queuedSubmissionId"],
        ["thread/queue/reorder"] = ["threadId", "queuedSubmissionIds"],
        ["turn/start"] = ["threadId", "input", "model", "effort", "mode", "submissionId"],
        ["turn/interrupt"] = ["threadId", "turnId"],
        ["turn/steer"] = ["threadId", "expectedTurnId", "input", "submissionId"]
    };
    public static readonly HashSet<string> ApprovalMethods = ["item/commandExecution/requestApproval",
        "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput",
        "mcpServer/elicitation/request"];

    public static JsonObject Parse(string raw, int maxFrame = MaxFrame)
    {
        if (Encoding.UTF8.GetByteCount(raw) > maxFrame) throw new InvalidDataException("frame_too_large");
        try
        {
            using var document = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 24 });
            CheckDuplicates(document.RootElement);
            return JsonNode.Parse(raw)?.AsObject() ?? throw new InvalidDataException("invalid_frame");
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or ArgumentException)
        { throw new InvalidDataException("invalid_frame"); }
    }

    private static void CheckDuplicates(JsonElement item)
    {
        if (item.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>();
            foreach (var property in item.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new InvalidDataException("invalid_frame");
                CheckDuplicates(property.Value);
            }
        }
        else if (item.ValueKind == JsonValueKind.Array)
            foreach (var child in item.EnumerateArray()) CheckDuplicates(child);
    }

    public static string Id(JsonObject message)
    {
        var id = message["id"] as JsonValue;
        if (id is not null && (id.TryGetValue<string>(out var text) && text.Length is >= 1 and <= 100 ||
            id.TryGetValue<long>(out var number) && number is >= -9007199254740991 and <= 9007199254740991))
            return id.ToJsonString();
        throw new InvalidDataException("invalid_id");
    }

    public static string ValidateRequest(JsonObject message)
    {
        Id(message);
        if (message.Count != 3 || message["method"] is not JsonValue methodValue ||
            !methodValue.TryGetValue<string>(out var method) || !Fields.TryGetValue(method, out var fields) ||
            message["params"] is not JsonObject args || args.Any(pair => !fields.Contains(pair.Key)))
            throw new InvalidDataException("method_not_allowed");
        if ((method.StartsWith("thread/") && method is not "thread/list" and not "thread/start") ||
            method.StartsWith("turn/") || method == "lanpower/session/release") ValidateString(args, "threadId", 100, true);
        foreach (var name in new[] { "cwd", "path", "query", "model", "cursor", "name", "effort", "turnId", "expectedTurnId" })
            ValidateString(args, name, 1000, method == "turn/interrupt" && name == "turnId" ||
                method == "turn/steer" && name == "expectedTurnId");
        ValidateString(args, "clientUserMessageId", 100, method == "thread/queue/add");
        if (method == "app/list") ValidateString(args, "threadId", 100);
        if (method == "lanpower/library/update")
        {
            if (args["revision"] is not JsonValue version || !version.TryGetValue<long>(out var revision) || revision < 0 || revision >= 9007199254740991)
                throw new InvalidDataException("invalid_library");
            CodexLibraryPreferences.Validate(args["preferences"]);
        }
        if (method == "lanpower/image/read") { ValidateString(args, "threadId", 100, true); ValidateString(args, "path", 1000, true); }
        if (method is "lanpower/submission/read" or "lanpower/history/item/read") ValidateString(args, "threadId", 100, true);
        ValidateString(args, "submissionId", 100, method == "lanpower/submission/read");
        if (method == "lanpower/history/item/read")
        {
            ValidateString(args, "reference", 100, true);
            if (args["offset"] is not JsonValue offset || !offset.TryGetValue<int>(out var position) || position < 0 || position > 64 * 1024 * 1024) throw new InvalidDataException("invalid_params");
        }
        if (method == "lanpower/history/action")
        {
            foreach (var key in new[] { "threadId", "turnId", "expectedTailTurnId" }) ValidateString(args, key, 100, true);
            if (args["action"]?.GetValue<string>() is not ("fork" or "rollback")) throw new InvalidDataException("invalid_params");
        }
        if (method == "lanpower/library/check" && (args["threadIds"] is not JsonArray { Count: > 0 and <= 256 } threadIds ||
            threadIds.Any(id => id is not JsonValue value || !value.TryGetValue<string>(out var text) || UnicodeLength(text) is < 1 or > 100))) throw new InvalidDataException("invalid_params");
        if (args.ContainsKey("historyLimit") && (args["historyLimit"] is not JsonValue historyLimit || !historyLimit.TryGetValue<int>(out var historyCount) || historyCount is < 1 or > 8)) throw new InvalidDataException("invalid_params");
        if (method.StartsWith("lanpower/files/")) { ValidateString(args,"cwd",1000,true); if (method == "lanpower/files/read") ValidateString(args,"path",1000,true); if (method == "lanpower/files/search") ValidateString(args,"query",256,true); }
        if (args.ContainsKey("mode") && args["mode"]?.GetValue<string>() is not ("default" or "plan")) throw new InvalidDataException("invalid_params");
        ValidateString(args, "queuedSubmissionId", 100, method is "thread/queue/delete" or "thread/queue/update" or "thread/queue/start");
        if (method == "thread/queue/reorder" && (args["queuedSubmissionIds"] is not JsonArray { Count: > 0 and <= 32 } ids ||
            ids.Any(id => id is not JsonValue value || !value.TryGetValue<string>(out var text) || text.Length is < 1 or > 100) ||
            ids.Select(id => id!.GetValue<string>()).Distinct().Count() != ids.Count)) throw new InvalidDataException("invalid_params");
        if (args.ContainsKey("limit") && (args["limit"] is not JsonValue limit ||
            !limit.TryGetValue<int>(out var count) || count is < 1 or > 50))
            throw new InvalidDataException("invalid_params");
        if (method is "skills/list" or "plugin/list" && args["limit"]?.GetValue<int>() is > 24) throw new InvalidDataException("invalid_params");
        if (method == "thread/rollback" && (args["numTurns"] is not JsonValue turns ||
            !turns.TryGetValue<int>(out var turnCount) || turnCount is < 1 or > 100000))
            throw new InvalidDataException("invalid_params");
        foreach (var name in new[] { "includeTurns", "archived", "refresh" })
            if (args.ContainsKey(name) && (args[name] is not JsonValue value || !value.TryGetValue<bool>(out _)))
                throw new InvalidDataException("invalid_params");
        if (method is "turn/start" or "turn/steer" or "thread/queue/add" or "thread/queue/update")
        {
            if (args["input"] is not JsonArray { Count: > 0 and <= 13 } input) throw new InvalidDataException("invalid_input");
            var textCount = 0; var imageCount = 0; var imageBytes = 0; var skillCount = 0;
            foreach (var entry in input)
            {
                if (entry is not JsonObject item) throw new InvalidDataException("invalid_input");
                if (item["type"]?.GetValue<string>() == "skill") { if (item.Count != 3 || ++skillCount > 8) throw new InvalidDataException("invalid_input"); ValidateString(item,"name",120,true); ValidateString(item,"path",1000,true); }
                else if (item["type"]?.GetValue<string>() == "text") { if (item.Count != 2) throw new InvalidDataException("invalid_input"); ValidateString(item, "text", 16000, true); if (++textCount > 1) throw new InvalidDataException("invalid_input"); }
                else if (item["type"]?.GetValue<string>() == "image")
                {
                    if (item.Count != 2) throw new InvalidDataException("invalid_input"); ValidateString(item, "url", 700000, true); var url = item["url"]!.GetValue<string>(); imageBytes += url.Length;
                    if (++imageCount > 4 || imageBytes > 850000 || !System.Text.RegularExpressions.Regex.IsMatch(url,
                        @"\Adata:image/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}\z", System.Text.RegularExpressions.RegexOptions.CultureInvariant))
                        throw new InvalidDataException("invalid_input");
                }
                else throw new InvalidDataException("invalid_input");
            }
        }
        return method;
    }

    private static void ValidateString(JsonObject args, string name, int limit, bool required = false)
    {
        if (!args.ContainsKey(name) && !required) return;
        if (args[name] is not JsonValue value || !value.TryGetValue<string>(out var text) || UnicodeLength(text) < 1 || UnicodeLength(text) > limit)
            throw new InvalidDataException("invalid_params");
    }

    // Protocol string limits count Unicode scalar values, not UTF-16 code units.
    public static int UnicodeLength(string text)
    {
        var count = 0;
        for (var i = 0; i < text.Length; i++, count++)
        {
            if (!char.IsSurrogate(text[i])) continue;
            if (!char.IsHighSurrogate(text[i]) || i + 1 >= text.Length || !char.IsLowSurrogate(text[++i]))
                throw new InvalidDataException("invalid_params");
        }
        return count;
    }

    // StreamReader.ReadLineAsync allocates an unbounded line; impose a bound before parsing.
    public static Task<string?> ReadLineAsync(StreamReader reader, CancellationToken token, int maxFrame = MaxFrame) =>
        Readers.GetValue(reader, key => new BoundedReader(key, maxFrame)).ReadAsync(token);

    private sealed class BoundedReader(StreamReader reader, int maxFrame)
    {
        private readonly char[] _buffer = new char[8192];
        private int _offset, _count;
        public async Task<string?> ReadAsync(CancellationToken token)
        {
            var result = new StringBuilder();
            while (true)
            {
                if (_offset == _count)
                {
                    _count = await reader.ReadAsync(_buffer.AsMemory(), token); _offset = 0;
                    if (_count == 0) return result.Length == 0 ? null : result.ToString();
                }
                var newline = Array.IndexOf(_buffer, '\n', _offset, _count - _offset);
                var end = newline < 0 ? _count : newline;
                if (result.Length + end - _offset > maxFrame) throw new InvalidDataException("frame_too_large");
                result.Append(_buffer, _offset, end - _offset); _offset = end;
                if (newline >= 0) { _offset++; return result.ToString().TrimEnd('\r'); }
            }
        }
    }
}
