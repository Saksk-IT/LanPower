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
        CodexAutoDiscover.IsChecked = _codexSettings.AutoDiscover;
        ShowCodexWorkspaces();
    }
    private void ShowCodexWorkspaces()
    {
        var discovered = _codexSettings.AutoDiscover ? CodexProjects.FromState().Select(project => project.Path) : [];
        var paths = discovered.Concat(_codexSettings.Workspaces).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        CodexWorkspaces.Text = paths.Length > 0 ? string.Join(Environment.NewLine, paths)
            : _codexSettings.AutoDiscover ? "打开远程开发后，将自动读取本机 Codex 项目和最近会话。" : "尚未添加项目";
    }

    private void CodexDiscoveryChanged(object sender, RoutedEventArgs e)
    {
        if (CodexWorkspaces is null) return;
        _codexSettings = _codexSettings with { AutoDiscover = CodexAutoDiscover.IsChecked == true };
        ShowCodexWorkspaces();
    }

    private void AddCodexWorkspace(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "选择允许远程开发的项目", Multiselect = false };
        if (dialog.ShowDialog(this) != true) return;
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
        _codexSettings = _codexSettings with { Enabled = CodexRemoteEnabled.IsChecked == true, AutoDiscover = CodexAutoDiscover.IsChecked == true };
        if (_codexSettings.Enabled && !_codexSettings.AutoDiscover && !_codexSettings.Workspaces.Any(_codexSettings.Allows))
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
    private async void OpenSharedCodex(object sender, RoutedEventArgs e)
    {
        var executable = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "CodexHost", "LanPower.CodexHost.exe"));
        if (!File.Exists(executable)) { CodexRemoteState.Text = "请重新安装最新版 LanPower。"; return; }
        try
        {
            var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
            start.ArgumentList.Add("--open-shared-desktop");
            CodexRemoteState.Text = "正在连接共享服务并打开官方 Codex…";
            using var launcher = Process.Start(start) ?? throw new IOException();
            await launcher.WaitForExitAsync();
            if (launcher.ExitCode != 0)
            {
                CodexRemoteState.Text = launcher.ExitCode switch {
                    2 => "未找到官方 Codex 桌面程序，请确认当前用户已安装。",
                    3 => "缺少 Codex 共享服务，请重新安装最新版 LanPower。",
                    4 => "Codex 共享服务暂未就绪，请稍后重试。",
                    5 => "无法访问共享服务或桌面目录，请检查当前用户权限。",
                    _ => "共享窗口启动失败，请重试；原有桌面任务继续运行。" };
                return;
            }
            LoadCodexRemoteSettings(); StartCodexHost();
            CodexRemoteState.Text = "已打开官方 Codex 双端控制窗口。请在该窗口继续会话，网页会连接同一个任务。";
        }
        catch { CodexRemoteState.Text = "无法启动共享窗口，请检查 LanPower 安装和当前用户目录权限。"; }
    }

    private async void ConnectCodexDesktop(object sender, RoutedEventArgs e)
    {
        var executable = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "CodexHost", "LanPower.CodexHost.exe"));
        try
        {
            var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
            start.ArgumentList.Add("--connect-desktop");
            using var connection = Process.Start(start) ?? throw new IOException();
            CodexRemoteState.Text = "正在连接当前官方 Codex 窗口…";
            await connection.WaitForExitAsync();
            if (connection.ExitCode != 0)
            {
                CodexRemoteState.Text = "原 Codex 窗口尚未开启本机连接。请在任务完成后关闭 Codex，再用 --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 启动。";
                return;
            }
            LoadCodexRemoteSettings(); StartCodexHost();
            CodexRemoteState.Text = "已连接原 Codex 窗口，网页可以继续同一会话。";
        }
        catch { CodexRemoteState.Text = "连接失败，请确认官方 Codex 正在运行并已登录。"; }
    }
}
