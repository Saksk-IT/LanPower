using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.CodexHost;

// The official skill/plugin interfaces have no cursor. Keep compact snapshots on
// the selected computer, never on Cloud; pagination metadata is not sent upstream.
public sealed class RemoteCapabilityCatalog
{
    private sealed record Row(JsonObject Group, JsonObject Item);
    private sealed record Snapshot(string Id, DateTimeOffset Expires, Row[] Rows);
    private readonly Dictionary<string, Snapshot> _snapshots = new();
    private readonly SemaphoreSlim _gate = new(1);
    private long _revision;
    public void Clear() { Interlocked.Increment(ref _revision); lock (_snapshots) _snapshots.Clear(); }

    public async Task<JsonObject> ReadAsync(string method, string[] roots, JsonObject parameters,
        Func<string, JsonObject, CancellationToken, Task<JsonObject>> readNative, CancellationToken token)
    {
        var native = new JsonObject { ["cwds"] = new JsonArray(roots.Select(root => (JsonNode)JsonValue.Create(root)!).ToArray()) };
        if (!parameters.ContainsKey("limit") && !parameters.ContainsKey("cursor") && !parameters.ContainsKey("refresh"))
            return await readNative(method, native, token); // Existing composer / old clients retain their contract.
        var limit = parameters["limit"]?.GetValue<int>() ?? 24;
        if (limit is < 1 or > 24) throw new InvalidDataException("invalid_params");
        var cursor = parameters["cursor"]?.GetValue<string>();
        var key = method + ":" + native.ToJsonString();
        await _gate.WaitAsync(token);
        try
        {
            var revision = Interlocked.Read(ref _revision);
            Snapshot? snapshot;
            lock (_snapshots)
            {
                foreach (var expired in _snapshots.Where(pair => pair.Value.Expires <= DateTimeOffset.UtcNow).Select(pair => pair.Key).ToArray()) _snapshots.Remove(expired);
                if (parameters["refresh"]?.GetValue<bool>() == true && cursor is null) _snapshots.Remove(key);
                _snapshots.TryGetValue(key, out snapshot);
            }
            var offset = 0;
            if (cursor is not null)
            {
                var parts = cursor.Split(':');
                if (snapshot is null || parts.Length != 2 || parts[0] != snapshot.Id || !int.TryParse(parts[1], out offset) || offset < 0 || offset > snapshot.Rows.Length)
                    throw new InvalidDataException("capability_cursor_expired");
            }
            else if (snapshot is null)
            {
                var response = await readNative(method, native, token);
                if (response["error"] is not null) return response;
                if (response["result"] is not JsonObject result) return Unavailable("原生接口未返回能力目录对象。");
                var errors = method == "plugin/list" ? result["marketplaceLoadErrors"] as JsonArray :
                    new JsonArray((result["data"] as JsonArray ?? []).SelectMany(entry => entry?["errors"] as JsonArray ?? []).Select(error => error?.DeepClone()).ToArray());
                if (errors is { Count: > 0 }) return Unavailable(Limit(string.Join("；", errors.Select(error =>
                    error is JsonObject detail ? detail["message"]?.ToString() ?? detail["error"]?.ToString() ?? "原生目录加载失败。" : error?.ToString() ?? "原生目录加载失败。"))));
                if (result[method == "plugin/list" ? "marketplaces" : "data"] is not JsonArray) return Unavailable("原生接口未提供完整目录字段。");
                Row[] rows;
                try { rows = Compact(method, result); }
                catch (InvalidDataException failure) { return Unavailable(failure.Message); }
                snapshot = new(Guid.NewGuid().ToString("N"), DateTimeOffset.UtcNow.AddMinutes(2), rows);
                lock (_snapshots)
                {
                    if (revision != Interlocked.Read(ref _revision)) throw new InvalidDataException("capability_cursor_expired");
                    _snapshots[key] = snapshot;
                    while (_snapshots.Count > 4) _snapshots.Remove(_snapshots.Keys.First());
                }
            }
            var array = new JsonArray();
            foreach (var group in snapshot.Rows.Skip(offset).Take(limit).GroupBy(row => row.Group.ToJsonString()))
            {
                var item = (JsonObject)group.First().Group.DeepClone();
                item[method == "plugin/list" ? "plugins" : "skills"] = new JsonArray(group.Select(row => (JsonNode)row.Item.DeepClone()).ToArray());
                if (method == "skills/list") item["errors"] = new JsonArray();
                array.Add(item);
            }
            return new() { ["result"] = new JsonObject {
                [method == "plugin/list" ? "marketplaces" : "data"] = array,
                ["nextCursor"] = offset + limit < snapshot.Rows.Length ? $"{snapshot.Id}:{offset + limit}" : null } };
        }
        finally { _gate.Release(); }
    }
    private static JsonObject Unavailable(string reason) => new() { ["result"] = new JsonObject { ["unavailableReason"] = reason } };
    private static Row[] Compact(string method, JsonObject result)
    {
        var rows = new List<Row>();
        foreach (var value in result[method == "plugin/list" ? "marketplaces" : "data"]!.AsArray())
        {
            if (value is not JsonObject group || group[method == "plugin/list" ? "plugins" : "skills"] is not JsonArray entries)
                throw new InvalidDataException("原生能力目录分组字段不完整。");
            var meta = Select(group, method == "plugin/list" ? ["name", "path"] : ["cwd"]);
            foreach (var valueEntry in entries)
            {
                if (valueEntry is not JsonObject entry) throw new InvalidDataException("原生能力目录条目字段不完整。");
                var summary = Select(entry, ["id", "name", "path", "description", "shortDescription", "scope", "installed", "enabled", "installPolicy", "authPolicy"]);
                if (entry["interface"] is JsonObject iface) summary["interface"] = Select(iface, ["displayName", "shortDescription", "longDescription", "developerName", "category"]);
                rows.Add(new(meta, summary));
            }
        }
        return rows.ToArray();
    }
    private static JsonObject Select(JsonObject source, string[] keys)
    {
        var result = new JsonObject();
        foreach (var key in keys)
        {
            if (source[key] is not JsonValue value) continue;
            if (value.TryGetValue<bool>(out var flag)) result[key] = flag;
            else if (value.TryGetValue<string>(out var text) && !text.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) result[key] = Limit(text);
        }
        return result;
    }
    private static string Limit(string text) => text;
}
