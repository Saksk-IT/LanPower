using System.Text;
using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.CodexHost;

// Bounded target-computer cache; each RPC still respects the relay's result limit.
public sealed class RemoteHistoryStore
{
    public const int MaxLocalBytes = 64 * 1024 * 1024;
    public const int InlineBytes = 512 * 1024;
    private readonly Dictionary<string, (string Thread, string Body, DateTimeOffset Time)> _items = new();
    private long _bytes;

    public JsonArray Pack(string threadId, JsonArray turns)
    {
        var visible = RemoteHistory.VisibleTurns(turns);
        foreach (var turn in visible.OfType<JsonObject>())
        {
            if (turn["items"] is not JsonArray items) continue;
            for (var i = 0; i < items.Count; i++)
                if (items[i] is JsonObject item && Encoding.UTF8.GetByteCount(item.ToJsonString(CodexRemoteProtocol.JsonOptions)) > InlineBytes)
                    items[i] = Store(threadId, item);
            if (Encoding.UTF8.GetByteCount(turn.ToJsonString(CodexRemoteProtocol.JsonOptions)) > 8 * 1024 * 1024)
            {
                // A very large turn made of many small items also needs a complete download.
                var original = turns.OfType<JsonObject>().First(t => t["id"]?.GetValue<string>() == turn["id"]?.GetValue<string>());
                turn["items"] = new JsonArray(Store(threadId, RemoteHistory.VisibleTurns(new JsonArray(original.DeepClone()))[0]!.AsObject(), true));
            }
        }
        return visible;
    }

    private JsonObject Store(string threadId, JsonObject item, bool wholeTurn = false)
    {
        var body = item.ToJsonString(CodexRemoteProtocol.JsonOptions);
        var size = body.Length * 2L;
        if (size > MaxLocalBytes) throw new InvalidDataException("history_item_too_large");
        foreach (var key in _items.Where(p => DateTimeOffset.UtcNow - p.Value.Time > TimeSpan.FromMinutes(10)).Select(p => p.Key).ToArray()) Drop(key);
        while (_bytes + size > MaxLocalBytes && _items.Count > 0) Drop(_items.Keys.First());
        var reference = Guid.NewGuid().ToString("N");
        _items[reference] = (threadId, body, DateTimeOffset.UtcNow); _bytes += size;
        return new() { ["id"] = item["id"]?.DeepClone(), ["type"] = "lanpowerLargeItem", ["originalType"] = wholeTurn ? "turn" : item["type"]?.DeepClone(),
            ["reference"] = reference, ["characters"] = body.Length, ["bytes"] = Encoding.UTF8.GetByteCount(body), ["wholeTurn"] = wholeTurn };
    }

    public JsonObject Read(string threadId, string reference, int offset)
    {
        if (!_items.TryGetValue(reference, out var entry) || entry.Thread != threadId || DateTimeOffset.UtcNow - entry.Time > TimeSpan.FromMinutes(10))
            throw new InvalidDataException("history_reference_expired");
        if (offset < 0 || offset >= entry.Body.Length) throw new InvalidDataException("invalid_history_offset");
        var length = Math.Min(64 * 1024, entry.Body.Length - offset);
        if (offset + length < entry.Body.Length && char.IsHighSurrogate(entry.Body[offset + length - 1])) length--;
        _items[reference] = (entry.Thread, entry.Body, DateTimeOffset.UtcNow);
        return new() { ["data"] = entry.Body.Substring(offset, length), ["offset"] = offset,
            ["nextOffset"] = offset + length < entry.Body.Length ? offset + length : null, ["characters"] = entry.Body.Length };
    }
    private void Drop(string reference) { _bytes -= _items[reference].Body.Length * 2L; _items.Remove(reference); }
    public void Clear() { _items.Clear(); _bytes = 0; }
}
