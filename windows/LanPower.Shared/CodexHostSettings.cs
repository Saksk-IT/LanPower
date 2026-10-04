using System.Text.Json;
using System.Runtime.InteropServices;
using System.Text;

namespace LanPower.Shared;

public sealed record CodexHostSettings(bool Enabled, string[] Workspaces, string Executable = "", bool AutoDiscover = true, bool SharedControl = false, bool DesktopControl = false)
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetLongPathName(string path, StringBuilder result, uint size);
    public static string Canonical(string path)
    {
        var full = Path.GetFullPath(path);
        var buffer = new StringBuilder(32768);
        return GetLongPathName(full, buffer, (uint)buffer.Capacity) > 0 ? buffer.ToString() : full;
    }
    public static string DefaultPath => Path.Combine(Environment.GetFolderPath(
        Environment.SpecialFolder.LocalApplicationData), "LanPower", "codex-remote.json");
    public static CodexHostSettings Load(string? path = null)
    {
        path ??= DefaultPath;
        if (!File.Exists(path)) return new(false, []);
        var settings = JsonSerializer.Deserialize<CodexHostSettings>(File.ReadAllText(path));
        if (settings is null) return new(false, []);
        if (settings.Workspaces is null ||
            settings.Workspaces.Any(root => string.IsNullOrWhiteSpace(root)))
            throw new InvalidDataException("invalid_settings");
        return settings;
    }
    public void Save(string? path = null)
    {
        path ??= DefaultPath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this));
        File.Move(temporary, path, true);
    }
    public bool Allows(string? path)
    {
        if (!Enabled || string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)) return false;
        try
        {
            var normalized = Canonical(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (normalized.StartsWith("\\\\", StringComparison.Ordinal) || !Directory.Exists(normalized)) return false;
            // Reject junctions/symlinks in the entire path; no remote path traversal through a reparse point.
            for (var parent = new DirectoryInfo(normalized); parent is not null; parent = parent.Parent)
                if ((parent.Attributes & FileAttributes.ReparsePoint) != 0) return false;
            return Workspaces.Any(root => Canonical(root).TrimEnd(Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar).Equals(normalized, StringComparison.OrdinalIgnoreCase));
        }
        catch (Exception error) when (error is IOException or ArgumentException or UnauthorizedAccessException)
        { return false; }
    }
}
