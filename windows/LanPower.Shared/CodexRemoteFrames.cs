using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace LanPower.Shared;

// RPC results stream in bounded pieces without a logical message-size ceiling.
public static class CodexRemoteFrames
{
    public const int ChunkCharacters = 64 * 1024;

    public static IEnumerable<string> Encode(string raw)
    {
        var size = Encoding.UTF8.GetByteCount(raw);
        if (size <= CodexRemoteProtocol.MaxFrame) { yield return raw; yield break; }
        var frame = JsonNode.Parse(raw)!.AsObject();
        var payload = frame["payload"] as JsonObject;
        if (frame["type"]?.GetValue<string>() != "rpc" || payload is null)
            throw new InvalidDataException("result_too_large");
        if (payload.ContainsKey("method"))
        {
            // Long completed items are recovered through lossless paginated history.
            yield return JsonSerializer.Serialize(new { type = "rpc", session = frame["session"],
                payload = new { method = "lanpower/historyChanged", @params = new {
                    threadId = payload["params"]?["threadId"] ?? payload["params"]?["thread"]?["id"] } } }, CodexRemoteProtocol.JsonOptions);
            yield break;
        }
        CodexRemoteProtocol.Id(payload);
        var body = payload.ToJsonString(CodexRemoteProtocol.JsonOptions);
        var offsets = new List<(int Start, int Length)>();
        for (var start = 0; start < body.Length;)
        {
            var length = Math.Min(ChunkCharacters, body.Length - start);
            if (start + length < body.Length && char.IsHighSurrogate(body[start + length - 1]) && char.IsLowSurrogate(body[start + length])) length--;
            offsets.Add((start, length)); start += length;
        }
        var count = offsets.Count;
        for (var index = 0; index < count; index++)
            yield return JsonSerializer.Serialize(new { type = "rpc_chunk", session = frame["session"], id = payload["id"],
                index, count, data = body.Substring(offsets[index].Start, offsets[index].Length) }, CodexRemoteProtocol.JsonOptions);
    }
}
