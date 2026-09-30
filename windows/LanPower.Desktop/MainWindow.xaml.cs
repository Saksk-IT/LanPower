using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using LanPower.Shared;

namespace LanPower.Desktop;

public partial class MainWindow : Window
{
    private readonly string _welcomeMarker = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LanPower", "welcome-complete");
    private CancellationTokenSource? _cloudWait;
    private CloudPairing? _cloudPairing;
    private readonly DispatcherTimer _statusTimer = new() { Interval = TimeSpan.FromSeconds(20) };
    private bool _loadingStatus;
    private bool _cloudConfigured;
    private string _version = "1.4.0";
    private string? _releasePage;
    private bool _loadingSettings;
    private readonly string _preferencesPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LanPower", "desktop-settings.json");

    private sealed record AdapterChoice(string Id, string Label);

    public MainWindow() => InitializeComponent();

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            if (File.Exists(_preferencesPath))
            {
                using var saved = JsonDocument.Parse(File.ReadAllText(_preferencesPath));
                UpdateProxyBox.IsChecked = saved.RootElement.GetProperty("use_system_proxy_for_updates").GetBoolean();
            }
        }
        catch { }
        FirstRunPanel.Visibility = File.Exists(_welcomeMarker) ? Visibility.Collapsed : Visibility.Visible;
        _statusTimer.Tick += RefreshStatus;
        _statusTimer.Start();
        await LoadStatusAsync();
    }

    private async Task LoadStatusAsync()
    {
        if (_loadingStatus) return;
        _loadingStatus = true;
        try
        {
            using var response = await PipeClient.RequestAsync("status");
            if (!response.RootElement.GetProperty("ok").GetBoolean()) throw new IOException("服务返回错误");
            var status = response.RootElement.GetProperty("status").Deserialize<ServiceStatus>()!;
            DeviceName.Text = status.Device;
            DeviceState.Text = "● 在线";
            LanState.Text = status.LanState;
            CloudState.Text = status.CloudState;
            GatewayState.Text = status.GatewayState;
            LanIp.Text = status.LanIp;
            Mac.Text = string.IsNullOrEmpty(status.Mac) ? "未检测到" : status.Mac;
            WolState.Text = status.WolState;
            _version = status.Version;
            _cloudConfigured = !string.IsNullOrEmpty(status.CloudUrl) || status.CloudState != "未配置";
            if (_cloudWait is null) CloudDisconnectButton.IsEnabled = _cloudConfigured;
            if (_cloudWait is null && !CloudUrlBox.IsKeyboardFocused && CloudUrlBox.Text == "https://" && !string.IsNullOrWhiteSpace(status.CloudUrl))
                CloudUrlBox.Text = status.CloudUrl;
        }
        catch
        {
            DeviceState.Text = "● 服务未连接";
            LanState.Text = "请检查 LanPower Service";
            CloudState.Text = "状态未知";
            GatewayState.Text = "状态未知";
            WolState.Text = "无法确认";
        }
        finally { _loadingStatus = false; }
    }

    private async void RefreshStatus(object? sender, EventArgs e) => await LoadStatusAsync();

    private async void ConnectCloud(object sender, RoutedEventArgs e)
    {
        CloudConnectButton.IsEnabled = LegacyConnectButton.IsEnabled = CloudUrlBox.IsEnabled = false;
        CloudDisconnectButton.IsEnabled = false;
        CloudNotice.Text = "正在请求配对…";
        using var wait = new CancellationTokenSource();
        _cloudWait = wait;
        try
        {
            using var response = await PipeClient.RequestAsync(JsonSerializer.Serialize(new
            { op = "enroll_start", cloud_url = CloudUrlBox.Text.Trim() }));
            if (!response.RootElement.GetProperty("ok").GetBoolean())
            {
                CloudNotice.Text = response.RootElement.GetProperty("error").GetString() ?? "无法发起配对";
                return;
            }
            var pairing = response.RootElement.GetProperty("pairing").Deserialize<CloudPairing>()
                ?? throw new InvalidDataException("配对响应无效");
            _cloudPairing = pairing;
            CloudUserCode.Text = pairing.UserCode;
            CloudPairingPanel.Visibility = Visibility.Visible;
            CloudNotice.Text = "等待网页批准。请打开 Cloud 网页，输入下方配对码。";
            while (DateTimeOffset.UtcNow.ToUnixTimeSeconds() < pairing.ExpiresAt)
            {
                wait.Token.ThrowIfCancellationRequested();
                try
                {
                    using var progress = await PipeClient.RequestAsync(JsonSerializer.Serialize(new
                    { op = "enroll_poll", enrollment_id = pairing.Id }));
                    if (progress.RootElement.GetProperty("ok").GetBoolean())
                    {
                        var state = progress.RootElement.GetProperty("state").GetString();
                        if (state == "connected")
                        {
                            CloudNotice.Text = "配对成功，电脑正在连接 Cloud。";
                            await LoadStatusAsync();
                            return;
                        }
                        if (state is "denied" or "expired")
                        {
                            CloudNotice.Text = state == "denied" ? "管理员已拒绝连接。" : "配对已过期，请重新连接。";
                            return;
                        }
                        CloudNotice.Text = "等待网页批准。请核对设备名称与配对码。";
                    }
                    else CloudNotice.Text = "暂时无法完成配对，正在重试…";
                }
                catch (Exception error) when (error is IOException or OperationCanceledException)
                {
                    CloudNotice.Text = "连接暂时中断，正在重试…";
                }
                await Task.Delay(TimeSpan.FromSeconds(pairing.Interval), wait.Token);
            }
            CloudNotice.Text = "配对已过期，请重新连接。";
        }
        catch (OperationCanceledException) { CloudNotice.Text = "已停止等待。"; }
        catch { CloudNotice.Text = "无法连接服务或 Cloud，请检查地址后重试。"; }
        finally
        {
            _cloudWait = null;
            _cloudPairing = null;
            CloudPairingPanel.Visibility = Visibility.Collapsed;
            CloudConnectButton.IsEnabled = LegacyConnectButton.IsEnabled = CloudUrlBox.IsEnabled = true;
            CloudDisconnectButton.IsEnabled = _cloudConfigured;
        }
    }

    private async void CancelCloudWait(object sender, RoutedEventArgs e)
    {
        var id = _cloudPairing?.Id;
        _cloudWait?.Cancel();
        if (id is null) return;
        try
        {
            using var result = await PipeClient.RequestAsync(JsonSerializer.Serialize(new { op = "enroll_cancel", enrollment_id = id }));
            if (!result.RootElement.GetProperty("ok").GetBoolean()) CloudNotice.Text = "无法停止配对，请检查连接状态。";
        }
        catch { CloudNotice.Text = "无法联系服务，请检查连接状态。"; }
    }

    private async void DisconnectCloud(object sender, RoutedEventArgs e)
    {
        if (MessageBox.Show(this, "断开后将停止这台电脑的云端控制。局域网功能继续可用。是否断开？",
            "断开 Cloud", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
        CloudConnectButton.IsEnabled = LegacyConnectButton.IsEnabled = CloudDisconnectButton.IsEnabled = false;
        try
        {
            using var response = await PipeClient.RequestAsync("{\"op\":\"cloud_disconnect\"}");
            if (!response.RootElement.GetProperty("ok").GetBoolean())
            {
                CloudNotice.Text = response.RootElement.GetProperty("error").GetString() ?? "无法断开连接";
                return;
            }
            CloudNotice.Text = response.RootElement.GetProperty("revoked").GetBoolean()
                ? "已断开 Cloud，原设备授权已失效。"
                : "本机已断开。请在 Cloud 控制台移除原设备，清理云端授权。";
            _cloudConfigured = false;
            await LoadStatusAsync();
        }
        catch { CloudNotice.Text = "无法完成操作，请检查服务状态后重试。"; }
        finally
        {
            CloudConnectButton.IsEnabled = LegacyConnectButton.IsEnabled = true;
            CloudDisconnectButton.IsEnabled = _cloudConfigured;
        }
    }

    private void OpenCloud(object sender, RoutedEventArgs e)
    {
        var address = _cloudPairing?.VerificationUri ?? CloudUrlBox.Text.Trim().TrimEnd('/') + "/dashboard";
        if (Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && uri.UserInfo.Length == 0)
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        else CloudNotice.Text = "请先输入有效的 HTTPS Cloud 地址。";
    }

    protected override void OnClosed(EventArgs e)
    {
        _cloudWait?.Cancel();
        _statusTimer.Stop();
        base.OnClosed(e);
    }

    private async void ConnectLegacyCloud(object sender, RoutedEventArgs e)
    {
        CloudConnectButton.IsEnabled = LegacyConnectButton.IsEnabled = false;
        CloudNotice.Text = "正在连接…";
        try
        {
            var command = JsonSerializer.Serialize(new
            {
                op = "enroll",
                cloud_url = CloudUrlBox.Text.Trim(),
                code = CloudCodeBox.Password.Trim()
            });
            using var response = await PipeClient.RequestAsync(command);
            if (!response.RootElement.GetProperty("ok").GetBoolean())
            {
                CloudNotice.Text = response.RootElement.GetProperty("error").GetString() ?? "配对失败";
                return;
            }
            CloudCodeBox.Clear();
            CloudNotice.Text = "配对成功";
            await LoadStatusAsync();
        }
        catch
        {
            CloudNotice.Text = "无法连接服务或 Cloud，请稍后重试。";
        }
        finally { CloudConnectButton.IsEnabled = LegacyConnectButton.IsEnabled = true; }
    }

    private async void ShowLogs(object sender, RoutedEventArgs e)
    {
        LogPanel.Visibility = Visibility.Visible;
        try
        {
            using var response = await PipeClient.RequestAsync("logs");
            LogText.Text = response.RootElement.GetProperty("logs").GetString() ?? "暂无日志";
        }
        catch
        {
            LogText.Text = "无法连接服务，请检查服务是否正在运行。";
        }
    }

    private void OpenPairing(object sender, RoutedEventArgs e) =>
        Process.Start(new ProcessStartInfo("http://127.0.0.1:48211/setup") { UseShellExecute = true });

    private void FinishWelcome(object sender, RoutedEventArgs e)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_welcomeMarker)!);
        File.WriteAllText(_welcomeMarker, "1");
        FirstRunPanel.Visibility = Visibility.Collapsed;
    }

    private async void LoadSettings(object sender, RoutedEventArgs e) => await LoadNetworkAsync("network_settings");

    private async Task LoadNetworkAsync(string request)
    {
        if (_loadingSettings) return;
        _loadingSettings = true;
        SaveNetworkButton.IsEnabled = RefreshNetworkButton.IsEnabled = false;
        try
        {
            using var response = await PipeClient.RequestAsync(request);
            if (!response.RootElement.GetProperty("ok").GetBoolean()) throw new IOException();
            var settings = response.RootElement.GetProperty("settings").Deserialize<NetworkSettings>() ?? throw new InvalidDataException();
            AdapterBox.ItemsSource = settings.Adapters.Select(adapter => new AdapterChoice(adapter.Id,
                $"{adapter.Name} · {(adapter.Wireless ? "Wi-Fi" : "有线")} · {(adapter.Connected ? adapter.Address : "未连接")}")).ToArray();
            AdapterBox.SelectedValue = settings.AdapterId;
            AutomaticNetworkBox.IsChecked = settings.Automatic;
            NetworkNotice.Text = settings.Adapters.Length == 0 ? "未找到物理网卡。网络连接后点击重新检测。" :
                $"当前配对地址 {settings.Address}:{settings.Port}；局域网范围 {settings.Subnet}";
            VersionNotice.Text = $"当前版本 {_version}";
        }
        catch { NetworkNotice.Text = "无法读取网络设置，请检查服务后重试。"; }
        finally
        {
            SaveNetworkButton.IsEnabled = RefreshNetworkButton.IsEnabled = true;
            _loadingSettings = false;
        }
    }

    private async void RefreshNetwork(object sender, RoutedEventArgs e)
    {
        await LoadNetworkAsync("{\"op\":\"network_refresh\"}");
        await LoadStatusAsync();
    }

    private async void SaveNetwork(object sender, RoutedEventArgs e)
    {
        if (AdapterBox.SelectedValue is not string id)
        {
            NetworkNotice.Text = "请先选择物理网卡。";
            return;
        }
        await LoadNetworkAsync(JsonSerializer.Serialize(new { op = "network_save", adapter_id = id, automatic = AutomaticNetworkBox.IsChecked == true }));
        await LoadStatusAsync();
    }

    private void OpenNetworkSettings(object sender, RoutedEventArgs e)
    {
        try { Process.Start(new ProcessStartInfo("ms-settings:network-status") { UseShellExecute = true }); }
        catch { NetworkNotice.Text = "无法打开 Windows 设置，请从系统设置中检查网络。"; }
    }

    private async void CheckUpdates(object sender, RoutedEventArgs e)
    {
        CheckUpdateButton.IsEnabled = OpenReleaseButton.IsEnabled = false;
        _releasePage = null;
        VersionNotice.Text = "正在检查更新…";
        try
        {
            var useProxy = UpdateProxyBox.IsChecked == true;
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_preferencesPath)!);
                File.WriteAllText(_preferencesPath + ".new", JsonSerializer.Serialize(new { use_system_proxy_for_updates = useProxy }));
                File.Move(_preferencesPath + ".new", _preferencesPath, true);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = useProxy }) { Timeout = TimeSpan.FromSeconds(10) };
            var latest = await ReleaseChecker.CheckAsync(http, _version, CancellationToken.None);
            if (latest is null) VersionNotice.Text = "暂未找到正式发布版本。";
            else
            {
                _releasePage = latest.PageUrl;
                OpenReleaseButton.IsEnabled = true;
                VersionNotice.Text = latest.UpdateAvailable ? $"有可用更新：{latest.Version}（当前 {_version}）" :
                    $"当前 {_version}；最新已发布 {latest.Version}，无需更新。";
            }
        }
        catch { VersionNotice.Text = "暂时无法检查更新。请检查网络与系统代理设置后重试。"; }
        finally { CheckUpdateButton.IsEnabled = true; }
    }

    private void OpenRelease(object sender, RoutedEventArgs e)
    {
        if (_releasePage is null) return;
        try { Process.Start(new ProcessStartInfo(_releasePage) { UseShellExecute = true }); }
        catch { VersionNotice.Text = "无法打开下载页面，请检查默认浏览器设置。"; }
    }
}
