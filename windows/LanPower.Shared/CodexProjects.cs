using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.Shared;

public sealed record CodexProject(string Name, string Path, string? Id = null);

public static class CodexProjects
{
    public static string Home => Environment.GetEnvironmentVariable("CODEX_HOME") is { Length: > 0 } home
        ? System.IO.Path.GetFullPath(home) : System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");

    public static bool SafeDirectory(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Length > 1000 || !System.IO.Path.IsPathFullyQualified(path)) return false;
        // Reuse the local-directory and reparse-point checks without expanding remote permissions.
        return new CodexHostSettings(true, [path], AutoDiscover: false).Allows(path);
    }

    public static IReadOnlyList<CodexProject> FromState(string? home = null)
    {
        var projects = new List<CodexProject>();
        try
        {
            var file = System.IO.Path.Combine(home ?? Home, ".codex-global-state.json");
            if (!File.Exists(file) || new FileInfo(file).Length > 4 * 1024 * 1024) return projects;
            var state = JsonNode.Parse(File.ReadAllText(file)) as JsonObject;
            // Only project paths/names are extracted. Authentication and unrelated desktop state are never read.
            if (state?["local-projects"] is JsonObject local)
                foreach (var entry in local.Take(128))
                    if (entry.Value is JsonObject item && item["rootPaths"] is JsonArray roots)
                        foreach (var root in roots.Take(8))
                            Add(projects, root?.GetValue<string>(), item["name"]?.GetValue<string>(), entry.Key);
            foreach (var key in new[] { "electron-saved-workspace-roots", "saved-workspace-roots" })
                if (state?[key] is JsonArray roots)
                    foreach (var root in roots.Take(128)) Add(projects, root?.GetValue<string>());
        }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException or
            InvalidOperationException or UnauthorizedAccessException or ArgumentException) { }
        return projects;
    }

    public static void Add(List<CodexProject> projects, string? path, string? name = null, string? id = null)
    {
        if (projects.Count >= 256 || !SafeDirectory(path)) return;
        var canonical = CodexHostSettings.Canonical(path!).TrimEnd(System.IO.Path.DirectorySeparatorChar);
        var index = projects.FindIndex(project => project.Path.Equals(canonical, StringComparison.OrdinalIgnoreCase));
        var display = string.IsNullOrWhiteSpace(name) ? System.IO.Path.GetFileName(canonical) : name;
        var project = new CodexProject(display.Length > 120 ? display[..120] : display, canonical, id);
        if (index < 0) projects.Add(project);
        else if (id is not null) projects[index] = project;
    }

    public static bool DesktopOwns(string id)
    {
        // Codex keeps lock files after exit. Only an OS-held writer lock indicates another owner.
        if (!Guid.TryParse(id, out _)) return false;
        var path = System.IO.Path.Combine(Home, "thread-writer-locks", id + ".lock");
        if (!File.Exists(path)) return false;
        try
        {
            using var file = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
            file.Lock(0, 1); file.Unlock(0, 1); return false;
        }
        catch (IOException) { return true; }
        catch (UnauthorizedAccessException) { return true; }
    }
}
