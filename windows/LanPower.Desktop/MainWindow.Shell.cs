using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using LanPower.Shared;

namespace LanPower.Desktop;

public partial class MainWindow
{
    private readonly Func<string, CancellationToken, Task<JsonDocument>> _request;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly DispatcherTimer _qrTimer = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly HttpClient _pairingHttp = new(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(5) };
    private CancellationTokenSource? _qrRequest;
    private DateTimeOffset? _qrExpires;
    private DateTime? _lastSuccess;
    private string? _networkIdentity;
    private bool _loaded;
    private bool _serviceAvailable;
    private bool _cloudBusy;
    private bool _loadingLogs;
    public bool CloseToTray => CloseToTrayBox.IsChecked == true;

    private Task<JsonDocument> RequestAsync(string command) => _request(command, _lifetime.Token);

    private async void Navigate(object sender, RoutedEventArgs e)
    {
        if (sender is not RadioButton { Tag: string page }) return;
        foreach (var view in new[] { OverviewView, PairingView, CloudView, NetworkView, LogsView, SettingsView })
            view.Visibility = Visibility.Collapsed;
        var (selected, title, hint) = page switch
        {
            "pairing" => (PairingView, "手机配对", "让手机与这台电脑建立局域网连接。"),
            "cloud" => (CloudView, "远程连接", "连接 Cloud，在外也能管理在线电脑。"),
            "network" => (NetworkView, "网络设置", "选择局域网网卡，管理地址更新方式。"),
            "logs" => (LogsView, "日志诊断", "查看服务运行记录，排查连接问题。"),
            "settings" => (SettingsView, "应用设置", "管理窗口行为与版本更新。"),
            _ => (OverviewView, "设备总览", "这台电脑的连接状态，一目了然。")
        };
        selected.Visibility = Visibility.Visible;
        PageTitle.Text = title;
        PageHint.Text = hint;
        PageScroll.ScrollToTop();
        if (page != "pairing") ClearPairingQr();
        if (!_loaded) return;
        if (page == "network") await LoadNetworkAsync("network_settings");
        if (page == "logs") await LoadLogsAsync();
    }

    public void NavigateTo(string page)
    {
        var navigation = page switch
        {
            "pairing" => PairingNav, "cloud" => CloudNav, "network" => NetworkNav,
            "logs" => LogsNav, "settings" => SettingsNav, _ => OverviewNav
        };
        navigation.IsChecked = true;
    }

    private void NavigateFromButton(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string page }) NavigateTo(page);
    }

    private static SolidColorBrush StateBrush(string state, bool ready) => new((Color)ColorConverter.ConvertFromString(
        ready ? "#147D6A" : state == "未配置" ? "#8CA0AA" : state.Contains("中断") || state.Contains("未连接") ? "#BA5748" : "#AB7A29"));

    private void ApplyStatusDisplay(ServiceStatus status)
    {
        var lan = status.LanState == "已连接";
        var cloud = status.CloudState == "已连接";
        var wake = cloud && status.GatewayState == "已连接，远程唤醒可用";
        LanDot.Fill = LanState.Foreground = LanRoute.Foreground = StateBrush(status.LanState, lan);
        CloudDot.Fill = CloudState.Foreground = CloudRoute.Foreground = StateBrush(status.CloudState, cloud);
        GatewayDot.Fill = GatewayState.Foreground = WakeRoute.Foreground = StateBrush(status.GatewayState, wake);
        DeviceDot.Fill = SidebarDot.Fill = StateBrush("已连接", true);
        SidebarState.Text = "后台服务运行中";
        DeviceBadge.Background = (Brush)FindResource("AccentLight");
        DeviceSummary.Text = lan && cloud ? "局域网与云端均已连接，手机和浏览器都能访问这台电脑。" :
            lan ? "已连接局域网，可以开始手机配对。" :
            cloud ? "云端连接可用，请检查局域网网卡与地址。" : "服务已启动，请检查网络设置后连接手机。";
        LanRoute.Text = lan ? "可以连接" : "检查网络";
        CloudRoute.Text = cloud ? "在线控制可用" : status.CloudState == "未配置" ? "尚未配置" : "等待连接";
        WakeRoute.Text = wake ? "远程唤醒可用" : status.GatewayState.Contains("待配置") ? "待配置电脑" :
            status.GatewayState == "未配置" ? "需要唤醒网关" : "等待连接";
        GatewayDetail.Text = $"当前网关：{status.GatewayState}。";
        FooterNotice.Text = $"后台服务 {status.Version} · 服务已连接";
        _lastSuccess = DateTime.Now;
        LastRefresh.Text = $"已刷新 {_lastSuccess:HH:mm:ss} · 每 {_statusTimer.Interval.TotalSeconds:0} 秒更新";
        if (_networkIdentity is not null && _networkIdentity != status.LanIp + status.Mac) ClearPairingQr();
        _networkIdentity = status.LanIp + status.Mac;
        if (Application.Current is App app) app.UpdateTray(lan ? "局域网已连接" : "服务运行中，请检查网络");
    }

    private void ApplyUnavailableDisplay()
    {
        _serviceAvailable = false;
        var unavailable = StateBrush("未连接", false);
        LanDot.Fill = CloudDot.Fill = GatewayDot.Fill = DeviceDot.Fill = SidebarDot.Fill = unavailable;
        LanState.Foreground = CloudState.Foreground = GatewayState.Foreground = unavailable;
        LanRoute.Foreground = CloudRoute.Foreground = WakeRoute.Foreground = unavailable;
        LanRoute.Text = CloudRoute.Text = WakeRoute.Text = "状态未知";
        SidebarState.Text = "后台服务未连接";
        DeviceBadge.Background = new SolidColorBrush(Color.FromRgb(246, 230, 222));
        DeviceSummary.Text = "无法联系后台服务。请在日志诊断中检查服务是否已安装并启动。";
        GatewayDetail.Text = "无法读取服务状态，暂时不能确认唤醒网关是否可用。";
        FooterNotice.Text = "服务未连接 · 可在日志诊断中检查";
        LastRefresh.Text = _lastSuccess is null ? "等待服务连接" : $"最近成功 {_lastSuccess:HH:mm:ss}";
        ClearPairingQr();
        UpdateCloudButtons();
        if (Application.Current is App app) app.UpdateTray("后台服务未连接");
    }

    private void UpdateCloudButtons()
    {
        CloudConnectButton.IsEnabled = LegacyConnectButton.IsEnabled = _serviceAvailable && !_cloudBusy;
        CloudUrlBox.IsEnabled = !_cloudBusy;
        CloudDisconnectButton.IsEnabled = _serviceAvailable && !_cloudBusy && _cloudConfigured;
    }

    private async Task<int> ReadPairingPortAsync(CancellationToken? cancellationToken = null)
    {
        using var response = await _request("network_settings", cancellationToken ?? _lifetime.Token);
        if (!response.RootElement.GetProperty("ok").GetBoolean()) throw new IOException();
        var settings = response.RootElement.GetProperty("settings").Deserialize<NetworkSettings>() ?? throw new InvalidDataException();
        return settings.Port is > 0 and <= 65535 ? settings.Port : throw new InvalidDataException();
    }

    private async void ShowPairingQr(object sender, RoutedEventArgs e) => await LoadPairingQrAsync();

    private async Task LoadPairingQrAsync()
    {
        ClearPairingQr();
        using var request = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        _qrRequest = request;
        ShowQrButton.IsEnabled = false;
        PairingNotice.Text = "正在从本机服务读取二维码…";
        try
        {
            var port = await ReadPairingPortAsync(request.Token);
            request.Token.ThrowIfCancellationRequested();
            using var response = await _pairingHttp.GetAsync($"http://127.0.0.1:{port}/setup/qr.png", request.Token);
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                PairingNotice.Text = "当前服务版本未支持界面内二维码。请打开浏览器配对页，或安装新版应用。";
                return;
            }
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentType?.MediaType != "image/png") throw new InvalidDataException();
            var bytes = await response.Content.ReadAsByteArrayAsync(request.Token);
            request.Token.ThrowIfCancellationRequested();
            using var stream = new MemoryStream(bytes);
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.StreamSource = stream;
            bitmap.EndInit();
            bitmap.Freeze();
            PairingQr.Source = bitmap;
            PairingPlaceholder.Visibility = Visibility.Collapsed;
            HideQrButton.Visibility = Visibility.Visible;
            ShowQrButton.Content = "刷新二维码";
            _qrExpires = DateTimeOffset.UtcNow.AddMinutes(2);
            PairingNotice.Text = "在 LanPower 小程序中选择扫描配对。请勿分享或截图传播二维码。";
            UpdateQrExpiry();
        }
        catch (OperationCanceledException)
        {
            if (!request.IsCancellationRequested) PairingNotice.Text = "读取二维码超时，请确认后台服务已启动。";
        }
        catch { PairingNotice.Text = "无法读取二维码，请检查服务，或打开浏览器配对页。"; }
        finally
        {
            if (ReferenceEquals(_qrRequest, request)) _qrRequest = null;
            ShowQrButton.IsEnabled = true;
        }
    }

    private void UpdateQrExpiry()
    {
        if (_qrExpires is not { } expiry) return;
        var seconds = (int)Math.Ceiling((expiry - DateTimeOffset.UtcNow).TotalSeconds);
        if (seconds <= 0) { ClearPairingQr(); PairingNotice.Text = "二维码已自动收起，可再次显示。"; }
        else QrExpiry.Text = $"{seconds / 60:D2}:{seconds % 60:D2} 后自动收起";
    }

    private void HidePairingQr(object sender, RoutedEventArgs e) => ClearPairingQr();

    private void ClearPairingQr()
    {
        _qrRequest?.Cancel();
        _qrExpires = null;
        PairingQr.Source = null;
        PairingPlaceholder.Visibility = Visibility.Visible;
        HideQrButton.Visibility = Visibility.Collapsed;
        ShowQrButton.Content = "显示配对二维码";
        QrExpiry.Text = "仅在本机显示，不保存到文件";
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (Application.Current is App { IsExiting: false, TrayAvailable: true } app && CloseToTray)
        {
            e.Cancel = true;
            Hide();
            app.NotifyHidden();
        }
        else if (Application.Current is App { IsExiting: false } exitingApp)
        {
            e.Cancel = true;
            _ = exitingApp.ExitInterfaceAsync();
        }
        base.OnClosing(e);
    }

    internal async Task CancelPendingEnrollmentAsync()
    {
        var id = _cloudPairing?.Id;
        _cloudWait?.Cancel();
        if (id is null) return;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            using var response = await _request(JsonSerializer.Serialize(new { op = "enroll_cancel", enrollment_id = id }), timeout.Token);
        }
        catch { }
    }

    private void SavePreferences(object sender, RoutedEventArgs e)
    {
        if (!_loaded) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_preferencesPath)!);
            File.WriteAllText(_preferencesPath + ".new", JsonSerializer.Serialize(new
            {
                use_system_proxy_for_updates = UpdateProxyBox.IsChecked == true,
                close_to_tray = CloseToTrayBox.IsChecked == true
            }));
            File.Move(_preferencesPath + ".new", _preferencesPath, true);
            PreferencesNotice.Text = "偏好设置已保存。";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { PreferencesNotice.Text = "无法保存偏好设置，本次选择仅在当前窗口有效。"; }
    }

    private void CopyNetworkInfo(object sender, RoutedEventArgs e)
    {
        if (!_serviceAvailable) { FooterNotice.Text = "请先连接后台服务。"; return; }
        try { Clipboard.SetText($"局域网 IP：{LanIp.Text}\n网卡 MAC：{Mac.Text}\nWake-on-LAN：{WolState.Text}"); FooterNotice.Text = "网络信息已复制。"; }
        catch { FooterNotice.Text = "无法访问剪贴板，请稍后重试。"; }
    }

    private void CopyLogs(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(LogText.Text)) return;
        try { Clipboard.SetText(LogText.Text); LogNotice.Text = "日志已复制。"; }
        catch { LogNotice.Text = "无法访问剪贴板，请稍后重试。"; }
    }

    private void OpenServices(object sender, RoutedEventArgs e)
    {
        try { Process.Start(new ProcessStartInfo("services.msc") { UseShellExecute = true }); }
        catch { LogNotice.Text = "无法打开服务管理，请在 Windows 搜索中打开“服务”。"; }
    }
}
