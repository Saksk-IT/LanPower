using System.Windows;
using System.Security.Principal;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Windows.Threading;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;

namespace LanPower.Desktop;

public partial class App : Application
{
    internal bool LaunchShell { get; init; } = true;
    private Mutex? _instance;
    private EventWaitHandle? _activation;
    private RegisteredWaitHandle? _activationWait;
    private Forms.NotifyIcon? _tray;
    private readonly Dictionary<string, Drawing.Icon> _trayIcons = new();
    private readonly DispatcherTimer _trayTimer = new() { Interval = TimeSpan.FromSeconds(30) };
    private readonly CancellationTokenSource _trayLifetime = new();
    private readonly HttpClient _trayHttp = new(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(5) };
    private bool _trayUpdating;
    private Forms.ContextMenuStrip? _trayMenu;
    private bool _ownsInstance;
    private bool _trayHintShown;
    public bool IsExiting { get; private set; }
    public bool TrayAvailable => _tray is not null;

    protected override void OnStartup(StartupEventArgs e)
    {
        if (!LaunchShell) return;
        base.OnStartup(e);
        var identity = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        var name = @"Local\LanPower.Desktop." + identity;
        _instance = new Mutex(true, name, out _ownsInstance);
        if (!_ownsInstance)
        {
            if (EventWaitHandle.TryOpenExisting(name + ".Activate", out var existing))
            {
                using (existing) existing.Set();
            }
            Shutdown();
            return;
        }
        _activation = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Activate");
        _activationWait = ThreadPool.RegisterWaitForSingleObject(_activation,
            (_, _) => Dispatcher.BeginInvoke(() => RestoreWindow()), null, Timeout.Infinite, false);
        var window = new MainWindow();
        MainWindow = window;
        try { LanPower.Desktop.MainWindow.StartCodexHost(); } catch { }
        CreateTray();
        window.Show();
    }

    private void CreateTray()
    {
        try
        {
            foreach (var color in new[] { "green", "yellow", "gray" })
            {
                var resource = GetResourceStream(new Uri($"pack://application:,,,/LanPower.Desktop;component/Resources/tray-{color}.ico"));
                using var stream = resource.Stream;
                using var original = new Drawing.Icon(stream);
                _trayIcons[color] = (Drawing.Icon)original.Clone();
            }
            _trayMenu = new Forms.ContextMenuStrip();
            _trayMenu.Items.Add("打开 LanPower", null, (_, _) => RestoreWindow());
            _trayMenu.Items.Add("手机配对", null, (_, _) => RestoreWindow("pairing"));
            _trayMenu.Items.Add("查看日志", null, (_, _) => RestoreWindow("logs"));
            _trayMenu.Items.Add(new Forms.ToolStripSeparator());
            _trayMenu.Items.Add("退出界面", null, async (_, _) => await ExitInterfaceAsync());
            _tray = new Forms.NotifyIcon { Icon = _trayIcons["gray"], Text = "LanPower · 服务未运行", ContextMenuStrip = _trayMenu, Visible = true };
            _tray.DoubleClick += (_, _) => RestoreWindow();
            _trayTimer.Tick += async (_, _) => await RefreshTrayAsync();
            _trayTimer.Start();
            _ = RefreshTrayAsync();
        }
        catch
        {
            _tray?.Dispose();
            _tray = null;
            _trayMenu?.Dispose();
            foreach (var icon in _trayIcons.Values) icon.Dispose();
            _trayIcons.Clear();
        }
    }

    public void RestoreWindow(string? page = null)
    {
        if (IsExiting || MainWindow is not MainWindow window) return;
        window.Show();
        if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
        if (page is not null) window.NavigateTo(page);
        window.Activate();
    }

    internal static (string Color, string Tooltip) TrayState(bool serviceRunning, bool cloudConnected) =>
        !serviceRunning ? ("gray", "LanPower · 服务未运行") : cloudConnected
            ? ("green", "LanPower · 已连接云端") : ("yellow", "LanPower · 未连接云端");

    private async Task RefreshTrayAsync()
    {
        if (_trayUpdating || IsExiting || _tray is null) return;
        _trayUpdating = true;
        var state = TrayState(false, false);
        try
        {
            // IPC grants only a read-only status capability, not the LAN secret.
            using var access = await PipeClient.RequestAsync("tray_status_access", _trayLifetime.Token);
            var port = access.RootElement.GetProperty("port").GetInt32();
            if (port is < 1 or > 65535) throw new InvalidOperationException("Invalid local port");
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{port}/api/status");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access.RootElement.GetProperty("token").GetString());
            using var response = await _trayHttp.SendAsync(request, _trayLifetime.Token);
            response.EnsureSuccessStatusCode();
            using var status = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: _trayLifetime.Token);
            state = TrayState(true, status?.RootElement.TryGetProperty("cloud_connected", out var connected) == true &&
                connected.ValueKind == JsonValueKind.True);
        }
        catch (Exception error) when (error is HttpRequestException or System.IO.IOException or
            OperationCanceledException or JsonException or InvalidOperationException or KeyNotFoundException) { }
        finally { _trayUpdating = false; }
        if (IsExiting || _tray is null) return;
        _tray.Icon = _trayIcons[state.Color];
        _tray.Text = state.Tooltip;
    }

    public void NotifyHidden()
    {
        if (_tray is null || _trayHintShown) return;
        _trayHintShown = true;
        _tray.ShowBalloonTip(3000, "LanPower 已收起到托盘", "双击图标即可打开。后台服务继续运行。", Forms.ToolTipIcon.Info);
    }

    public async Task ExitInterfaceAsync()
    {
        if (IsExiting) return;
        IsExiting = true;
        _trayTimer.Stop();
        _trayLifetime.Cancel();
        _trayHttp.Dispose();
        if (MainWindow is MainWindow window) await window.CancelPendingEnrollmentAsync();
        Shutdown();
    }

    protected override void OnSessionEnding(SessionEndingCancelEventArgs e)
    {
        IsExiting = true;
        base.OnSessionEnding(e);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        IsExiting = true;
        _trayTimer.Stop();
        _trayLifetime.Cancel();
        _trayHttp.Dispose();
        _tray?.Dispose();
        _trayMenu?.Dispose();
        foreach (var icon in _trayIcons.Values) icon.Dispose();
        _activationWait?.Unregister(null);
        _activation?.Dispose();
        if (_ownsInstance) _instance?.ReleaseMutex();
        _instance?.Dispose();
        base.OnExit(e);
    }
}
