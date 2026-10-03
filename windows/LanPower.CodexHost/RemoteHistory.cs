using System.Text.Json.Nodes;

namespace LanPower.CodexHost;

public static class RemoteHistory
{
    public const string CursorPrefix = "lp-history-v1:";

    public static JsonArray VisibleTurns(JsonArray turns)
    {
        var result = (JsonArray)turns.DeepClone();
        foreach (var turn in result.OfType<JsonObject>())
            foreach (var item in (turn["items"] as JsonArray ?? []).OfType<JsonObject>())
            {
                // Preserve every displayable item, including images, search, MCP,
                // plans and full command output. Private reasoning stays local.
                if (item["type"]?.GetValue<string>() == "reasoning")
                { item.Remove("encryptedContent"); item.Remove("content"); }
            }
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
