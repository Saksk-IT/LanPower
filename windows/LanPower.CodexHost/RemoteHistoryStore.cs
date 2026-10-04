using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.CodexHost;

// Body eviction never revokes a published locator. Rehydrate from native history
// and check its fingerprint; neither the relay nor disk stores these bodies.
public sealed class RemoteHistoryStore
{
    public const int MaxLocalBytes = 64 * 1024 * 1024;
    public const int InlineBytes = 512 * 1024;
    public record Locator(string TurnId, string? ItemId, int ItemIndex, bool WholeTurn);
    private sealed class Entry(string thread, Locator locator, string fingerprint, string body, DateTimeOffset time)
    {
        public string Thread = thread, Fingerprint = fingerprint;
        public Locator Source = locator;
        public string? Body = body;
        public DateTimeOffset Time = time;
    }
    private readonly Dictionary<string, Entry> _items = new();
    private readonly object _gate = new();
    private readonly SemaphoreSlim _loading = new(1, 1);
    private readonly Func<DateTimeOffset> _now;
    private long _bytes;
    public RemoteHistoryStore(Func<DateTimeOffset>? now = null) => _now = now ?? (() => DateTimeOffset.UtcNow);
    public long CachedBytes { get { lock (_gate) return _bytes; } }

    public JsonArray Pack(string threadId, JsonArray turns)
    {
        lock (_gate)
        {
            Expire();
            var visible = RemoteHistory.VisibleTurns(turns);
            foreach (var turn in visible.OfType<JsonObject>())
            {
                if (turn["items"] is not JsonArray items) continue;
                var original = (JsonObject)turn.DeepClone();
                var turnId = turn["id"]!.GetValue<string>();
                for (var i = 0; i < items.Count; i++)
                    if (items[i] is JsonObject item && Encoding.UTF8.GetByteCount(item.ToJsonString(CodexRemoteProtocol.JsonOptions)) > InlineBytes)
                        items[i] = Store(threadId, item, new(turnId, item["id"]?.GetValue<string>(), i, false));
                if (Encoding.UTF8.GetByteCount(turn.ToJsonString(CodexRemoteProtocol.JsonOptions)) > 8 * 1024 * 1024)
                    turn["items"] = new JsonArray(Store(threadId, original, new(turnId, null, -1, true)));
            }
            return visible;
        }
    }

    private static string Fingerprint(string body) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body)));
    private JsonObject Store(string threadId, JsonObject item, Locator source)
    {
        var body = item.ToJsonString(CodexRemoteProtocol.JsonOptions);
        var fingerprint = Fingerprint(body);
        var reference = _items.FirstOrDefault(p => p.Value.Thread == threadId && p.Value.Source == source && p.Value.Fingerprint == fingerprint).Key;
        if (reference is null)
        {
            // Live reference leases are never evicted to make room for another page.
            reference = Guid.NewGuid().ToString("N");
            _items[reference] = new(threadId, source, fingerprint, body, _now());
            _bytes += body.Length * 2L; TrimBodies(reference);
        }
        else _items[reference].Time = _now();
        return new() { ["id"] = item["id"]?.DeepClone(), ["type"] = "lanpowerLargeItem",
            ["originalType"] = source.WholeTurn ? "turn" : item["type"]?.DeepClone(), ["reference"] = reference,
            ["characters"] = body.Length, ["bytes"] = Encoding.UTF8.GetByteCount(body), ["wholeTurn"] = source.WholeTurn,
            ["leaseSeconds"] = 600 };
    }

    private Entry Require(string threadId, string reference)
    {
        if (!_items.TryGetValue(reference, out var entry) || entry.Thread != threadId || _now() - entry.Time > TimeSpan.FromMinutes(10))
            throw new InvalidDataException("history_reference_expired");
        entry.Time = _now(); return entry;
    }
    public JsonObject Read(string threadId, string reference, int offset)
    {
        lock (_gate) return Chunk(Require(threadId, reference).Body ?? throw new InvalidDataException("history_body_unavailable"), offset);
    }
    public async Task<JsonObject> ReadAsync(string threadId, string reference, int offset,
        Func<Locator, CancellationToken, Task<JsonObject>> load, CancellationToken token)
    {
        await _loading.WaitAsync(token);
        try
        {
            Entry entry;
            lock (_gate) { entry = Require(threadId, reference); if (entry.Body is { } cached) return Chunk(cached, offset); }
            var value = await load(entry.Source, token); token.ThrowIfCancellationRequested();
            var body = value.ToJsonString(CodexRemoteProtocol.JsonOptions);
            if (Fingerprint(body) != entry.Fingerprint) throw new InvalidDataException("history_reference_changed");
            lock (_gate)
            {
                if (Require(threadId, reference) != entry) throw new InvalidDataException("history_reference_expired");
                if (entry.Body is null) { entry.Body = body; _bytes += body.Length * 2L; TrimBodies(reference); }
                return Chunk(body, offset);
            }
        }
        finally { _loading.Release(); }
    }
    private static JsonObject Chunk(string body, int offset)
    {
        if (offset < 0 || offset >= body.Length) throw new InvalidDataException("invalid_history_offset");
        var length = Math.Min(64 * 1024, body.Length - offset);
        if (offset + length < body.Length && char.IsHighSurrogate(body[offset + length - 1])) length--;
        return new() { ["data"] = body.Substring(offset, length), ["offset"] = offset,
            ["nextOffset"] = offset + length < body.Length ? offset + length : null, ["characters"] = body.Length };
    }
    private void TrimBodies(string keep)
    {
        foreach (var pair in _items.OrderBy(p => p.Value.Time))
        {
            if (_bytes <= MaxLocalBytes) break;
            if (pair.Key == keep || pair.Value.Body is not { } body) continue;
            _bytes -= body.Length * 2L; pair.Value.Body = null;
        }
    }
    private void Expire()
    {
        foreach (var key in _items.Where(p => _now() - p.Value.Time > TimeSpan.FromMinutes(10)).Select(p => p.Key).ToArray())
        { if (_items[key].Body is { } body) _bytes -= body.Length * 2L; _items.Remove(key); }
    }
    public void Clear() { lock (_gate) { _items.Clear(); _bytes = 0; } }
}
