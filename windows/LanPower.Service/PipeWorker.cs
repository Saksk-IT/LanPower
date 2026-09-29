using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.NetworkInformation;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Service;

public sealed class PipeWorker(LanConfig config, CloudAgent cloud, ServiceLog log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            NamedPipeServerStream? pipe = null;
            try
            {
                pipe = CreatePipe();
                await pipe.WaitForConnectionAsync(stoppingToken);
                var connected = pipe;
                pipe = null;
                _ = HandleAsync(connected, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                log.Write("桌面连接失败：" + error.GetType().Name);
                await Task.Delay(1000, stoppingToken);
            }
            finally
            {
                pipe?.Dispose();
            }
        }
    }

    private static NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.InteractiveSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(
            LanProtocol.PipeName, PipeDirection.InOut, 4, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 1024, 16384, security);
    }

    private async Task HandleAsync(NamedPipeServerStream pipe, CancellationToken token)
    {
        await using (pipe)
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
                timeout.CancelAfter(TimeSpan.FromSeconds(20));
                using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
                await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
                var line = await ReadCommandAsync(reader, timeout.Token);
                if (line is null) return;
                var response = line switch
                {
                    "status" => JsonSerializer.Serialize(new { ok = true, status = GetStatus() }),
                    "logs" => JsonSerializer.Serialize(new { ok = true, logs = log.ReadTail() }),
                    _ => await EnrollAsync(line, timeout.Token)
                };
                await writer.WriteLineAsync(response.AsMemory(), timeout.Token);
            }
            catch (Exception error) when (error is IOException or OperationCanceledException or InvalidOperationException)
            {
                log.Write("桌面连接中断：" + error.GetType().Name);
            }
        }
    }

    private async Task<string> EnrollAsync(string line, CancellationToken token)
    {
        try
        {
            using var document = JsonDocument.Parse(line);
            var request = document.RootElement;
            if (request.ValueKind != JsonValueKind.Object || request.EnumerateObject().Count() != 3 ||
                request.GetProperty("op").GetString() != "enroll")
                return JsonSerializer.Serialize(new { ok = false, error = "unknown request" });
            await cloud.EnrollAsync(request.GetProperty("cloud_url").GetString() ?? "",
                request.GetProperty("code").GetString() ?? "", token);
            return JsonSerializer.Serialize(new { ok = true });
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or
                                     ArgumentException or HttpRequestException or InvalidDataException)
        {
            return JsonSerializer.Serialize(new { ok = false, error = "Cloud 配对失败，请检查地址和配对码" });
        }
    }

    private static async Task<string?> ReadCommandAsync(StreamReader reader, CancellationToken token)
    {
        var command = new StringBuilder();
        var buffer = new char[1];
        while (command.Length <= 512)
        {
            if (await reader.ReadAsync(buffer.AsMemory(), token) == 0) return null;
            if (buffer[0] == '\n') return command.ToString().TrimEnd('\r');
            command.Append(buffer[0]);
        }
        return null;
    }

    private ServiceStatus GetStatus()
    {
        var adapter = NetworkInterface.GetAllNetworkInterfaces().FirstOrDefault(nic =>
            nic.OperationalStatus == OperationalStatus.Up &&
            nic.GetIPProperties().UnicastAddresses.Any(address => address.Address.Equals(IPAddress.Parse(config.HostIp))));
        var mac = adapter?.GetPhysicalAddress().ToString() ?? "";
        if (mac.Length == 12) mac = string.Join(":", Enumerable.Range(0, 6).Select(i => mac.Substring(i * 2, 2)));
        return new ServiceStatus(Environment.MachineName, config.HostIp, mac,
            DetectWake(adapter), "已连接", cloud.State, "未配置", "1.4.0");
    }

    private static string DetectWake(NetworkInterface? adapter)
    {
        if (adapter is null) return "未检测到网卡";
        try
        {
            using var process = Process.Start(new ProcessStartInfo(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "powercfg.exe"),
                "/devicequery wake_armed")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true
            });
            if (process is null || !process.WaitForExit(2000))
            {
                if (process is { HasExited: false }) process.Kill();
                return "无法确认";
            }
            var output = process.StandardOutput.ReadToEnd();
            return output.Contains(adapter.Name, StringComparison.OrdinalIgnoreCase) ||
                   output.Contains(adapter.Description, StringComparison.OrdinalIgnoreCase) ? "已启用" : "需检查";
        }
        catch
        {
            return "无法确认";
        }
    }
}
