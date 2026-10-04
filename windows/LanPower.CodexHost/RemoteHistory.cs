using System.Text.Json.Nodes;

namespace LanPower.CodexHost;

public static class RemoteHistory
{
    public const string CursorPrefix = "lp-history-v1:";

    public static int TailCount(IReadOnlyList<string> newestFirst, string turnId, string expectedTail, bool inclusive)
    {
        if (newestFirst.Count == 0 || newestFirst[0] != expectedTail || newestFirst.Distinct().Count() != newestFirst.Count)
            throw new InvalidDataException("history_changed");
        for (var i = 0; i < newestFirst.Count; i++) if (newestFirst[i] == turnId) return i + (inclusive ? 1 : 0);
        throw new InvalidDataException("history_changed");
    }

    public static JsonArray VisibleTurns(JsonArray turns) => PublicPayload(turns).AsArray();

    public static JsonNode PublicPayload(JsonNode source)
    {
        var result = source.DeepClone();
        void Sanitize(JsonNode? node)
        {
            if (node is JsonArray list) foreach (var child in list) Sanitize(child);
            else if (node is JsonObject item)
            {
                var type = item["type"] is System.Text.Json.Nodes.JsonValue value && value.TryGetValue<string>(out var name) ? name : null;
                foreach (var key in item.Select(p => p.Key).ToArray())
                    if (key is "encryptedContent" or "encrypted_content" or "reasoningContent" or "reasoning_content" ||
                        type == "reasoning" && key == "content" || type == "contextCompaction" && key is not ("id" or "type" or "status")) item.Remove(key);
                    else Sanitize(item[key]);
            }
        }
        Sanitize(result);
        return result;
    }

    public static JsonObject PageSavedTurns(JsonArray oldestFirst, string? cursor, int limit)
    {
        var offset = 0;
        if (cursor is not null && (!cursor.StartsWith(CursorPrefix, StringComparison.Ordinal) ||
            !int.TryParse(cursor[CursorPrefix.Length..], out offset) || offset < 0 || offset > oldestFirst.Count))
            throw new InvalidDataException("invalid_history_cursor");
        var page = new JsonArray(oldestFirst.Reverse().Skip(offset).Take(limit).Select(t => t?.DeepClone()).ToArray());
        return new() { ["data"] = VisibleTurns(page),
            ["nextCursor"] = offset + page.Count < oldestFirst.Count ? CursorPrefix + (offset + page.Count) : null };
    }
}
