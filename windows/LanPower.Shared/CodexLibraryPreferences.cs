using System.Text;
using System.Text.Json.Nodes;

namespace LanPower.Shared;

public static class CodexLibraryPreferences
{
    public static JsonObject Defaults() => new() {
        ["collapsed"] = new JsonArray(), ["pinned"] = new JsonArray(), ["hidden"] = new JsonArray(),
        ["order"] = new JsonArray(), ["aliases"] = new JsonObject(),
        ["sections"] = new JsonObject { ["projects"] = true, ["chats"] = true, ["pinned"] = true },
        ["sort"] = "updated", ["chatsFirst"] = false
    };

    public static JsonObject Validate(JsonNode? value)
    {
        if (value is not JsonObject input || Encoding.UTF8.GetByteCount(input.ToJsonString()) > 128 * 1024 ||
            input.Any(p => p.Key is not ("collapsed" or "pinned" or "hidden" or "order" or "aliases" or "sections" or "sort" or "chatsFirst")))
            throw new InvalidDataException("invalid_library");
        var result = Defaults();
        foreach (var name in new[] { "collapsed", "pinned", "hidden", "order" })
        {
            if (!input.ContainsKey(name)) continue;
            var max = name == "pinned" ? 64 : 1024;
            if (input[name] is not JsonArray list || list.Count > max || list.Any(v =>
                v is not JsonValue s || !s.TryGetValue<string>(out var text) || text.Length is < 1 || text.Length > (name == "pinned" ? 100 : 1000)) ||
                list.Select(v => v!.GetValue<string>()).Distinct().Count() != list.Count) throw new InvalidDataException("invalid_library");
            result[name] = list.DeepClone();
        }
        if (input.ContainsKey("aliases"))
        {
            if (input["aliases"] is not JsonObject { Count: <= 1024 } aliases || aliases.Any(p => p.Key.Length is < 1 or > 1000 ||
                p.Value is not JsonValue s || !s.TryGetValue<string>(out var name) || name.Length is < 1 or > 120)) throw new InvalidDataException("invalid_library");
            result["aliases"] = aliases.DeepClone();
        }
        if (input.ContainsKey("sections"))
        {
            if (input["sections"] is not JsonObject sections || sections.Any(p => p.Key is not ("projects" or "chats" or "pinned") ||
                p.Value is not JsonValue s || !s.TryGetValue<bool>(out _))) throw new InvalidDataException("invalid_library");
            foreach (var section in sections) result["sections"]![section.Key] = section.Value?.DeepClone();
        }
        if (input.ContainsKey("sort"))
        {
            if (input["sort"]?.GetValue<string>() is not ("updated" or "created")) throw new InvalidDataException("invalid_library");
            result["sort"] = input["sort"]!.DeepClone();
        }
        if (input.ContainsKey("chatsFirst"))
        {
            if (input["chatsFirst"] is not JsonValue s || !s.TryGetValue<bool>(out _)) throw new InvalidDataException("invalid_library");
            result["chatsFirst"] = input["chatsFirst"]!.DeepClone();
        }
        return result;
    }
}
