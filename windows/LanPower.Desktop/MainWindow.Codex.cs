using System.Diagnostics;
using System.IO;
using System.Windows;
using LanPower.Shared;

namespace LanPower.Desktop;

public partial class MainWindow
{
    private CodexHostSettings _codexSettings = new(false, []);
    private void LoadCodexRemoteSettings()
    {
        try { _codexSettings = CodexHostSettings.Load(); }
        catch { _codexSettings = new(false, []); }
        CodexRemoteEnabled.IsChecked = _codexSettings.Enabled;
        ShowCodexWorkspaces();
    }
    private void ShowCodexWorkspaces() => CodexWorkspaces.Text = _codexSettings.Workspaces.Length > 0
        ? string.Join(Environment.NewLine, _codexSettings.Workspaces) : "尚未选择项目";

    private void AddCodexWorkspace(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "选择允许远程开发的项目", Multiselect = false };
        if (dialog.ShowDialog(this) != true) return;
        if (_codexSettings.Workspaces.Length >= 32)
        { CodexRemoteState.Text = "最多允许 32 个项目，请先清理不再使用的目录。"; return; }
        var candidate = _codexSettings with { Enabled = true, Workspaces = [dialog.FolderName] };
        if (!candidate.Allows(dialog.FolderName))
        { CodexRemoteState.Text = "请选择本机普通目录，不能使用网络路径、符号链接或目录联接。"; return; }
        _codexSettings = _codexSettings with { Workspaces = _codexSettings.Workspaces.Append(dialog.FolderName)
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray() };
        ShowCodexWorkspaces();
    }
    private void ClearCodexWorkspaces(object sender, RoutedEventArgs e)
    { _codexSettings = _codexSettings with { Workspaces = [] }; ShowCodexWorkspaces(); }

    private void SaveCodexRemote(object sender, RoutedEventArgs e)
    {
        _codexSettings = _codexSettings with { Enabled = CodexRemoteEnabled.IsChecked == true };
        if (_codexSettings.Enabled && !_codexSettings.Workspaces.Any(_codexSettings.Allows))
        { CodexRemoteState.Text = "请先添加一个允许远程开发的项目目录。"; return; }
        try { _codexSettings.Save(); StartCodexHost(); CodexRemoteState.Text = "已保存，正在同步本机授权。"; }
        catch { CodexRemoteState.Text = "无法保存授权，请检查当前用户的目录权限。"; }
    }
    internal static void StartCodexHost()
    {
        var executable = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "CodexHost", "LanPower.CodexHost.exe"));
        if (!File.Exists(executable)) return;
        Process.Start(new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true });
    }
    private void OpenCodexRemote(object sender, RoutedEventArgs e)
    {
        if (_codexRemoteUri is null) { CodexRemoteState.Text = "请先连接 Cloud。"; return; }
        try { Process.Start(new ProcessStartInfo(_codexRemoteUri.AbsoluteUri) { UseShellExecute = true }); }
        catch { CodexRemoteState.Text = "无法打开远程开发页面，请检查默认浏览器。"; }
    }
}
