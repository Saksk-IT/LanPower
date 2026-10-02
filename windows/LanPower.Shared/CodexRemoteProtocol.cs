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
        ["lanpower/status"] = [], ["model/list"] = ["cursor", "limit"],
        ["thread/list"] = ["cursor", "limit", "cwd", "archived"],
        ["thread/start"] = ["cwd", "model"], ["thread/resume"] = ["threadId"],
        ["thread/read"] = ["threadId", "includeTurns"], ["thread/name/set"] = ["threadId", "name"],
        ["thread/archive"] = ["threadId"], ["thread/unarchive"] = ["threadId"],
        ["turn/start"] = ["threadId", "input", "model", "effort"],
        ["turn/interrupt"] = ["threadId", "turnId"]
    };
    public static readonly HashSet<string> ApprovalMethods = ["item/commandExecution/requestApproval",
        "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput",
        "mcpServer/elicitation/request"];

    public static JsonObject Parse(string raw)
    {
        if (Encoding.UTF8.GetByteCount(raw) > MaxFrame) throw new InvalidDataException("frame_too_large");
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
            method.StartsWith("turn/")) ValidateString(args, "threadId", 100, true);
        foreach (var name in new[] { "cwd", "model", "cursor", "name", "effort", "turnId" })
            ValidateString(args, name, 1000, method == "turn/interrupt" && name == "turnId");
        if (args.ContainsKey("limit") && (args["limit"] is not JsonValue limit ||
            !limit.TryGetValue<int>(out var count) || count is < 1 or > 50))
            throw new InvalidDataException("invalid_params");
        foreach (var name in new[] { "includeTurns", "archived" })
            if (args.ContainsKey(name) && (args[name] is not JsonValue value || !value.TryGetValue<bool>(out _)))
                throw new InvalidDataException("invalid_params");
        if (method == "turn/start")
        {
            if (args["input"] is not JsonArray { Count: 1 } input || input[0] is not JsonObject { Count: 2 } text ||
                text["type"]?.GetValue<string>() != "text") throw new InvalidDataException("invalid_input");
            ValidateString(text, "text", 16000, true);
        }
        return method;
    }

    private static void ValidateString(JsonObject args, string name, int limit, bool required = false)
    {
        if (!args.ContainsKey(name) && !required) return;
        if (args[name] is not JsonValue value || !value.TryGetValue<string>(out var text) || text.Length < 1 || text.Length > limit)
            throw new InvalidDataException("invalid_params");
    }

    // StreamReader.ReadLineAsync allocates an unbounded line; impose a bound before parsing.
    public static Task<string?> ReadLineAsync(StreamReader reader, CancellationToken token) =>
        Readers.GetValue(reader, key => new BoundedReader(key)).ReadAsync(token);

    private sealed class BoundedReader(StreamReader reader)
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
                if (result.Length + end - _offset > MaxFrame) throw new InvalidDataException("frame_too_large");
                result.Append(_buffer, _offset, end - _offset); _offset = end;
                if (newline >= 0) { _offset++; return result.ToString().TrimEnd('\r'); }
            }
        }
    }
}
