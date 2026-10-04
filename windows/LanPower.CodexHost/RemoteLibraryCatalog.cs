using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace LanPower.CodexHost;

// Authorized metadata only. Complete snapshots make archive reconciliation safe
// without confusing a missing first-page entry with a deleted conversation.
public sealed class RemoteLibraryCatalog
{
    public const int MaxThreads = 100000;
    private Dictionary<string, (JsonObject Thread, bool Archived)> _threads = new();
    private string _digest = "";
    private readonly object _gate = new();
    public long Revision { get; private set; }
    public void Replace(IEnumerable<(JsonObject Thread, bool Archived)> entries)
    {
        var next = new Dictionary<string, (JsonObject, bool)>();
        foreach (var entry in entries)
        {
            next[entry.Thread["id"]!.GetValue<string>()] = ((JsonObject)entry.Thread.DeepClone(), entry.Archived);
            if (next.Count > MaxThreads) throw new InvalidDataException("library_catalog_too_large");
        }
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', next.OrderBy(p => p.Key).Select(p => p.Value.Item2 + p.Value.Item1.ToJsonString())))));
        lock (_gate) if (_digest != digest) { _threads = next; _digest = digest; Revision++; }
    }
    public JsonObject Page(string query, bool archived, IEnumerable<string> pinned, string? cursor, int limit, JsonObject? aliases = null)
    {
        lock (_gate) return PageCore(query, archived, pinned, cursor, limit, aliases);
    }
    private JsonObject PageCore(string query, bool archived, IEnumerable<string> pinned, string? cursor, int limit, JsonObject? aliases)
    {
        var offset = 0;
        if (cursor is not null)
        {
            var parts = cursor.Split(':');
            if (parts.Length != 2 || !long.TryParse(parts[0], out var revision) || revision != Revision || !int.TryParse(parts[1], out offset) || offset < 0)
                throw new InvalidDataException("library_cursor_changed");
        }
        bool Matches(JsonObject thread) => query.Length == 0 || string.Join(' ', new[] { "name", "preview", "cwd", "projectName", "projectPath" }.Select(key => thread[key]?.GetValue<string>() ?? ""))
            .Contains(query, StringComparison.OrdinalIgnoreCase) || aliases?[(thread["projectPath"]?.GetValue<string>() ?? "").Replace('\\','/').TrimEnd('/').ToLowerInvariant()]?.GetValue<string>()?.Contains(query, StringComparison.OrdinalIgnoreCase) == true;
        var rows = _threads.Values.Where(p => p.Archived == archived && Matches(p.Thread)).Select(p => p.Thread)
            .OrderByDescending(t => long.TryParse(t["updatedAt"]?.ToString(), out var timestamp) ? timestamp : 0).ThenBy(t => t["id"]!.GetValue<string>(), StringComparer.Ordinal).ToArray();
        return new() { ["data"] = new JsonArray(rows.Skip(offset).Take(limit).Select(t => t.DeepClone()).ToArray()),
            ["nextCursor"] = offset + limit < rows.Length ? $"{Revision}:{offset + limit}" : null, ["revision"] = Revision,
            ["pinned"] = new JsonArray(pinned.Where(id => _threads.TryGetValue(id, out var entry) && entry.Archived == archived && Matches(entry.Thread)).Select(id => _threads[id].Thread.DeepClone()).ToArray()) };
    }
    public JsonObject Check(IEnumerable<string> ids, bool archived)
    {
        lock (_gate) return new() {
        ["revision"] = Revision, ["data"] = new JsonArray(ids.Where(id => _threads.TryGetValue(id, out var item) && item.Archived == archived)
            .Select(id => _threads[id].Thread.DeepClone()).ToArray()) };
    }
    public void Clear() { lock (_gate) { _threads.Clear(); _digest = ""; Revision++; } }
}
