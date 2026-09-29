using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using LanPower.Shared;

namespace LanPower.Desktop;

public partial class MainWindow : Window
{
    private readonly string _welcomeMarker = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LanPower", "welcome-complete");

    public MainWindow() => InitializeComponent();

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        FirstRunPanel.Visibility = File.Exists(_welcomeMarker) ? Visibility.Collapsed : Visibility.Visible;
        await LoadStatusAsync();
    }

    private async Task LoadStatusAsync()
    {
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
        }
        catch
        {
            DeviceState.Text = "● 服务未连接";
            LanState.Text = "请检查 LanPower Service";
            CloudState.Text = "未配置";
            GatewayState.Text = "未配置";
            WolState.Text = "无法确认";
        }
    }

    private async void RefreshStatus(object sender, RoutedEventArgs e) => await LoadStatusAsync();

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
}
