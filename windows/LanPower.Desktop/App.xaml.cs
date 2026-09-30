using System.Windows;
using System.Security.Principal;
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
    private Drawing.Icon? _icon;
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
        CreateTray();
        window.Show();
    }

    private void CreateTray()
    {
        try
        {
            var resource = GetResourceStream(new Uri("pack://application:,,,/LanPower.Desktop;component/Assets/LanPower.ico"));
            using var stream = resource.Stream;
            using var original = new Drawing.Icon(stream);
            _icon = (Drawing.Icon)original.Clone();
            _trayMenu = new Forms.ContextMenuStrip();
            _trayMenu.Items.Add("打开 LanPower", null, (_, _) => RestoreWindow());
            _trayMenu.Items.Add("手机配对", null, (_, _) => RestoreWindow("pairing"));
            _trayMenu.Items.Add("查看日志", null, (_, _) => RestoreWindow("logs"));
            _trayMenu.Items.Add(new Forms.ToolStripSeparator());
            _trayMenu.Items.Add("退出界面", null, async (_, _) => await ExitInterfaceAsync());
            _tray = new Forms.NotifyIcon { Icon = _icon, Text = "LanPower · 正在连接服务", ContextMenuStrip = _trayMenu, Visible = true };
            _tray.DoubleClick += (_, _) => RestoreWindow();
        }
        catch
        {
            _tray?.Dispose();
            _tray = null;
            _trayMenu?.Dispose();
            _icon?.Dispose();
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

    public void UpdateTray(string state)
    {
        if (_tray is not null) _tray.Text = "LanPower · " + state;
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
        _tray?.Dispose();
        _trayMenu?.Dispose();
        _icon?.Dispose();
        _activationWait?.Unregister(null);
        _activation?.Dispose();
        if (_ownsInstance) _instance?.ReleaseMutex();
        _instance?.Dispose();
        base.OnExit(e);
    }
}
