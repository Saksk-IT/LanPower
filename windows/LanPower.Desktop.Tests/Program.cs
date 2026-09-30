using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Windows.Threading;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using LanPower.Desktop;
using LanPower.Shared;

namespace LanPower.Desktop.Tests;

internal static class Program
{
    private static int _checks;
    private static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            // Dispatcher pumping must not launch or activate the installed app.
            var app = new App { LaunchShell = false };
            app.InitializeComponent();
            SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(Dispatcher.CurrentDispatcher));
            var available = true;
            var status = new ServiceStatus("我的电脑", "192.168.1.100", "02:11:22:33:44:55", "系统允许唤醒",
                "已连接", "未配置", "未配置", "1.5.0");
            var settings = new NetworkSettings("ethernet", true, "192.168.1.100", "192.168.1.0/24", 48211,
                [new("ethernet", "以太网", "192.168.1.100", 24, false, true)]);
            var window = new MainWindow((command, _) =>
            {
                if (!available) return Task.FromException<JsonDocument>(new IOException("Test service disconnected"));
                return Task.FromResult(JsonDocument.Parse(command == "status"
                    ? JsonSerializer.Serialize(new { ok = true, status })
                    : command == "logs" ? JsonSerializer.Serialize(new { ok = true, logs = "[09:30:00] LAN 服务已启动\n[09:30:05] 等待手机配对" })
                    : JsonSerializer.Serialize(new { ok = true, settings })));
            });
            app.MainWindow = window;
            InvokeTask(window, "LoadStatusAsync");
            Check(Text(window, "DeviceState") == "服务运行中" && Text(window, "LanState") == "已连接", "LAN status displayed");
            Check(Text(window, "CloudRoute") == "尚未配置" && Text(window, "WakeRoute") == "需要唤醒网关", "optional Cloud and wake routes are explicit");
            var refreshTimer = (DispatcherTimer)typeof(MainWindow).GetField("_statusTimer", Private)!.GetValue(window)!;
            Check(Text(window, "LastRefresh").Contains($"{refreshTimer.Interval.TotalSeconds:0} 秒"), "refresh label matches the polling interval");
            Check(window.Icon is BitmapFrame && ((BitmapFrame)window.Icon).PixelWidth > 0, "application icon loads");

            status = status with { CloudState = "已连接", GatewayState = "已连接，远程唤醒可用", CloudUrl = "https://power.example.com" };
            InvokeTask(window, "LoadStatusAsync");
            Check(Text(window, "CloudRoute") == "在线控制可用" && Text(window, "WakeRoute") == "远程唤醒可用", "Cloud and gateway states displayed independently");
            Check(Control<Button>(window, "CloudDisconnectButton").IsEnabled, "connected Cloud can be disconnected");
            Check(MainWindow.GatewaySetupUri("https://power.example.com", "00000000-0000-0000-0000-000000000002")?.AbsoluteUri ==
                "https://power.example.com/gateways?computer=00000000-0000-0000-0000-000000000002", "gateway setup selects the current computer");
            Check(MainWindow.GatewaySetupUri("https://user@power.example.com", "") is null &&
                MainWindow.GatewaySetupUri("http://power.example.com", "") is null, "invalid setup origins rejected");
            status = status with { GatewayState = "已连接，待配置电脑", GatewayHint = "正在自动配置，请保持电脑和网关在线。" };
            InvokeTask(window, "LoadStatusAsync");
            Check(Text(window, "GatewayDetail").StartsWith("正在自动配置") &&
                Control<Button>(window, "GatewaySetupLink").Content.ToString() == "配置远程唤醒  →", "setup progress and action visible");

            available = false;
            InvokeTask(window, "LoadStatusAsync");
            Check(Text(window, "CloudState") == "状态未知" && Text(window, "WakeRoute") == "状态未知", "service loss clears stale online states");
            Check(Control<TextBox>(window, "LanIp").Text == "—" && Control<TextBox>(window, "Mac").Text == "—", "service loss clears stale network addresses");
            Check(!Control<Button>(window, "CloudConnectButton").IsEnabled && !Control<Button>(window, "CloudDisconnectButton").IsEnabled, "service actions disabled while disconnected");
            Check(!Control<Button>(window, "GatewaySetupLink").IsEnabled, "stale gateway link disabled on service loss");
            available = true;
            InvokeTask(window, "LoadStatusAsync");
            Check(Control<Button>(window, "CloudConnectButton").IsEnabled, "service recovery restores actions");

            var output = args.Length > 0 ? Path.GetFullPath(args[0]) : null;
            if (output is not null) Directory.CreateDirectory(output);
            status = status with { CloudState = "未配置", GatewayState = "未配置", CloudUrl = "" };
            InvokeTask(window, "LoadStatusAsync");
            Control<TextBox>(window, "CloudUrlBox").Text = "https://";
            InvokeTask(window, "LoadNetworkAsync", "network_settings");
            InvokeTask(window, "LoadLogsAsync");
            Check(Control<ComboBox>(window, "AdapterBox").SelectedValue?.ToString() == "ethernet", "configured adapter selected");

            var pages = new[] { "overview", "pairing", "cloud", "network", "logs", "settings" };
            foreach (var width in new[] { 1140, 960 })
            foreach (var page in pages)
            {
                window.NavigateTo(page);
                Check(pages.Count(p => Control<FrameworkElement>(window, ViewName(p)).Visibility == Visibility.Visible) == 1,
                    $"single active page: {page}/{width}");
                var root = (FrameworkElement)window.Content;
                var height = width == 960 ? 622 : 740;
                root.Measure(new Size(width, height));
                root.Arrange(new Rect(0, 0, width, height));
                root.UpdateLayout();
                if (output is not null) SaveScreenshot(root, width, height, Path.Combine(output, $"{page}-{width}.png"));
                VerifyTextFits(root);
            }

            window.NavigateTo("pairing");
            var bitmap = new WriteableBitmap(2, 2, 96, 96, PixelFormats.Bgra32, null);
            Control<Image>(window, "PairingQr").Source = bitmap;
            window.NavigateTo("overview");
            Check(Control<Image>(window, "PairingQr").Source is null, "changing page hides pairing QR");
            typeof(MainWindow).GetField("_qrExpires", Private)!.SetValue(window, DateTimeOffset.UtcNow.AddSeconds(-1));
            Control<Image>(window, "PairingQr").Source = bitmap;
            Invoke(window, "UpdateQrExpiry");
            Check(Control<Image>(window, "PairingQr").Source is null, "expired QR is removed");
            Check(window.CloseToTray, "close-to-tray defaults on");
            VerifyPairing(window, value => settings = settings with { Port = value });
            Console.WriteLine($"Desktop checks passed: {_checks}." + (output is null ? "" : $" Screenshots: {output}"));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static string ViewName(string page) => page switch
    {
        "overview" => "OverviewView", "pairing" => "PairingView", "cloud" => "CloudView",
        "network" => "NetworkView", "logs" => "LogsView", _ => "SettingsView"
    };

    private static T Control<T>(MainWindow window, string name) where T : class => (T)window.FindName(name);
    private static string Text(MainWindow window, string name) => Control<TextBlock>(window, name).Text;
    private static object? Invoke(MainWindow window, string name, params object[] args) => typeof(MainWindow).GetMethod(name, Private)!.Invoke(window, args);
    private static void InvokeTask(MainWindow window, string name, params object[] args) => Complete((Task)Invoke(window, name, args)!);

    private static void Complete(Task task)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!task.IsCompleted)
        {
            if (DateTime.UtcNow >= deadline) throw new TimeoutException("Desktop operation did not complete");
            var frame = new DispatcherFrame();
            Dispatcher.CurrentDispatcher.BeginInvoke(DispatcherPriority.Background, () => frame.Continue = false);
            Dispatcher.PushFrame(frame);
            Thread.Sleep(5);
        }
        task.GetAwaiter().GetResult();
    }

    private static void VerifyPairing(MainWindow window, Action<int> setPort)
    {
        using var server = new TcpListener(IPAddress.Loopback, 0);
        server.Start();
        setPort(((IPEndPoint)server.LocalEndpoint).Port);
        window.NavigateTo("pairing");
        byte[] image;
        using (var png = new MemoryStream())
        {
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(new WriteableBitmap(32, 32, 96, 96, PixelFormats.Bgra32, null)));
            encoder.Save(png);
            image = png.ToArray();
        }
        var response = RespondAsync(server, 200, "image/png", image);
        InvokeTask(window, "LoadPairingQrAsync");
        Complete(response);
        Check(Control<Image>(window, "PairingQr").Source is BitmapSource { PixelWidth: 32 }, "PNG is displayed inside the pairing page");
        Check(Text(window, "QrExpiry").Contains("自动收起"), "visible QR has a hide countdown");
        Invoke(window, "ClearPairingQr");
        Check(Control<Image>(window, "PairingQr").Source is null, "manual QR hide clears the image");

        response = RespondAsync(server, 404, "text/plain", []);
        InvokeTask(window, "LoadPairingQrAsync");
        Complete(response);
        Check(Text(window, "PairingNotice").Contains("浏览器配对页") && Control<Image>(window, "PairingQr").Source is null,
            "older service provides a browser fallback without stale QR");

        response = RespondAsync(server, 200, "text/html", "not a QR"u8.ToArray());
        InvokeTask(window, "LoadPairingQrAsync");
        Complete(response);
        Check(Control<Image>(window, "PairingQr").Source is null && Control<Button>(window, "ShowQrButton").IsEnabled,
            "invalid QR response keeps retry available");

        var accepted = server.AcceptTcpClientAsync();
        var pending = (Task)Invoke(window, "LoadPairingQrAsync")!;
        Complete(accepted);
        using var connection = accepted.Result;
        window.NavigateTo("overview");
        Complete(pending);
        Check(Control<Image>(window, "PairingQr").Source is null && Control<Button>(window, "ShowQrButton").IsEnabled,
            "navigating away cancels a pending QR request");
    }

    private static async Task RespondAsync(TcpListener server, int status, string contentType, byte[] body)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var connection = await server.AcceptTcpClientAsync(timeout.Token).ConfigureAwait(false);
        await using var stream = connection.GetStream();
        using var reader = new StreamReader(stream, leaveOpen: true);
        var request = await reader.ReadLineAsync(timeout.Token).ConfigureAwait(false);
        if (request != "GET /setup/qr.png HTTP/1.1") throw new InvalidOperationException("Unexpected pairing endpoint");
        while (!string.IsNullOrEmpty(await reader.ReadLineAsync(timeout.Token).ConfigureAwait(false))) { }
        var header = System.Text.Encoding.ASCII.GetBytes($"HTTP/1.1 {status} Test\r\nContent-Type: {contentType}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(header, timeout.Token).ConfigureAwait(false);
        await stream.WriteAsync(body, timeout.Token).ConfigureAwait(false);
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException("FAILED: " + message);
        _checks++;
        Console.WriteLine("PASS: " + message);
    }

    private static void VerifyTextFits(DependencyObject element)
    {
        if (element is UIElement { Visibility: not Visibility.Visible }) return;
        if (element is TextBlock { ActualWidth: > 0, TextWrapping: TextWrapping.NoWrap, TextTrimming: TextTrimming.None } text
            && text.FontFamily.Source != "Segoe Fluent Icons")
        {
            var measured = new FormattedText(text.Text, CultureInfo.CurrentCulture, text.FlowDirection,
                new Typeface(text.FontFamily, text.FontStyle, text.FontWeight, text.FontStretch), text.FontSize,
                text.Foreground, VisualTreeHelper.GetDpi(text).PixelsPerDip);
            if (measured.Width > text.ActualWidth + 3)
                throw new InvalidOperationException($"Text clipped: {text.Text} ({measured.Width:0.0} > {text.ActualWidth:0.0})");
        }
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(element); i++) VerifyTextFits(VisualTreeHelper.GetChild(element, i));
    }

    private static void SaveScreenshot(FrameworkElement root, int width, int height, string path)
    {
        var render = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        render.Render(root);
        var pixels = new byte[width * height * 4];
        render.CopyPixels(pixels, width * 4, 0);
        if (!pixels.Where((_, i) => i % 4 == 3).Any(alpha => alpha != 0)) throw new InvalidOperationException("Blank screenshot");
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(render));
        using var file = File.Create(path);
        encoder.Save(file);
    }
}
