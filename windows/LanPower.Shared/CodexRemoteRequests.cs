using System.Text.Json;
using System.Text.Json.Nodes;

namespace LanPower.Shared;

// Only complete, ordered requests can reach a runtime. No logical payload-size limit.
public sealed class CodexRemoteRequests
{
    private sealed record Upload(int Count, List<string> Parts, DateTime Updated);
    private readonly Dictionary<string, Upload> _uploads = new();
    private readonly object _gate = new();

    public void Clear() { lock (_gate) _uploads.Clear(); }

    public JsonObject? Accept(JsonObject frame)
    {
        lock (_gate) return AcceptCore(frame);
    }

    private JsonObject? AcceptCore(JsonObject frame)
    {
        if (frame["type"]?.GetValue<string>() != "rpc_upload") return frame;
        var session = frame["session"]?.GetValue<string>();
        var id = CodexRemoteProtocol.Id(frame);
        var key = session + ":" + id;
        foreach (var old in _uploads.Where(pair => DateTime.UtcNow - pair.Value.Updated > TimeSpan.FromMinutes(5)).Select(pair => pair.Key).ToArray()) _uploads.Remove(old);
        if (frame.Count != 6 || frame["index"] is not JsonValue i || !i.TryGetValue<int>(out var index) ||
            frame["count"] is not JsonValue c || !c.TryGetValue<int>(out var count) || count < 1 || index < 0 || index >= count ||
            frame["data"] is not JsonValue d || !d.TryGetValue<string>(out var data) || data.Length is < 1 or > CodexRemoteFrames.ChunkCharacters)
            throw new InvalidDataException("invalid_chunk");
        if (!_uploads.TryGetValue(key, out var upload))
        {
            if (index != 0) throw new InvalidDataException("invalid_chunk");
            upload = new(count, [], DateTime.UtcNow);
        }
        if (count != upload.Count || index != upload.Parts.Count) { _uploads.Remove(key); throw new InvalidDataException("invalid_chunk"); }
        upload.Parts.Add(data);
        _uploads[key] = upload with { Updated = DateTime.UtcNow };
        if (index + 1 != count) return null;
        _uploads.Remove(key);
        var request = CodexRemoteProtocol.Parse(string.Concat(upload.Parts), int.MaxValue);
        if (request.Count != 3 || request["type"]?.GetValue<string>() != "rpc" || request["session"]?.GetValue<string>() != session ||
            request["payload"] is not JsonObject payload || CodexRemoteProtocol.Id(payload) != id) throw new InvalidDataException("invalid_chunk");
        return request;
    }

    public static IEnumerable<string> Encode(string raw)
    {
        if (raw.Length <= CodexRemoteFrames.ChunkCharacters) { yield return raw; yield break; }
        var frame = JsonNode.Parse(raw)!.AsObject();
        var payload = frame["payload"] as JsonObject ?? throw new InvalidDataException("invalid_frame");
        CodexRemoteProtocol.Id(payload);
        var parts = new List<string>();
        for (var start = 0; start < raw.Length;)
        {
            var length = Math.Min(CodexRemoteFrames.ChunkCharacters, raw.Length - start);
            if (start + length < raw.Length && char.IsHighSurrogate(raw[start + length - 1]) && char.IsLowSurrogate(raw[start + length])) length--;
            parts.Add(raw.Substring(start, length)); start += length;
        }
        for (var index = 0; index < parts.Count; index++)
            yield return JsonSerializer.Serialize(new { type = "rpc_upload", session = frame["session"], id = payload["id"],
                index, count = parts.Count, data = parts[index] }, CodexRemoteProtocol.JsonOptions);
    }
}
