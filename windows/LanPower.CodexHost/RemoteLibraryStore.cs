using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.CodexHost;

// Organization belongs to the interactive host, so a new browser restores the same library.
// Keep it separate from the official desktop state, whose in-process cache owns that file.
public sealed class RemoteLibraryStore(string? file = null)
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private readonly string _file = file ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LanPower", "codex-library.json");

    private JsonObject ReadFile()
    {
        if (!File.Exists(_file)) return new() { ["revision"] = 0L, ["preferences"] = CodexLibraryPreferences.Defaults() };
        var saved = JsonNode.Parse(File.ReadAllText(_file))?.AsObject() ?? throw new InvalidDataException("invalid_library");
        return new() { ["revision"] = saved["revision"]!.GetValue<long>(), ["preferences"] = CodexLibraryPreferences.Validate(saved["preferences"]) };
    }

    public async Task<JsonObject> ReadAsync(CancellationToken token)
    {
        await Gate.WaitAsync(token);
        try { return ReadFile(); } finally { Gate.Release(); }
    }

    public async Task<JsonObject> UpdateAsync(long revision, JsonObject preferences, CancellationToken token)
    {
        var validated = CodexLibraryPreferences.Validate(preferences);
        await Gate.WaitAsync(token);
        try
        {
            var saved = ReadFile();
            if (saved["revision"]!.GetValue<long>() != revision) { saved["conflict"] = true; return saved; }
            var next = new JsonObject { ["revision"] = checked(revision + 1), ["preferences"] = validated };
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            var temporary = _file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try { await File.WriteAllTextAsync(temporary, next.ToJsonString(CodexRemoteProtocol.JsonOptions), token); File.Move(temporary, _file, true); }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            return next;
        }
        finally { Gate.Release(); }
    }
}
