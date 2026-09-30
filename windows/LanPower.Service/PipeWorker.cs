using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Service;

public sealed class PipeWorker(CloudAgent cloud, ServiceLog log, LanNetworkManager network) : BackgroundService
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
                    "network_settings" => JsonSerializer.Serialize(new { ok = true, settings = network.Settings() }),
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
            if (request.ValueKind != JsonValueKind.Object)
                return JsonSerializer.Serialize(new { ok = false, error = "unknown request" });
            var operation = request.GetProperty("op").GetString();
            if (operation == "network_save" && request.EnumerateObject().Count() == 3)
            {
                await network.ConfigureAsync(request.GetProperty("adapter_id").GetString() ?? "",
                    request.GetProperty("automatic").GetBoolean(), token);
                return JsonSerializer.Serialize(new { ok = true, settings = network.Settings() });
            }
            if (operation == "network_refresh" && request.EnumerateObject().Count() == 1)
            {
                await network.RefreshAsync(token);
                return JsonSerializer.Serialize(new { ok = true, settings = network.Settings() });
            }
            if (operation == "enroll_start" && request.EnumerateObject().Count() == 2)
            {
                var pairing = await cloud.BeginEnrollmentAsync(request.GetProperty("cloud_url").GetString() ?? "", token);
                return JsonSerializer.Serialize(new { ok = true, pairing });
            }
            if (operation == "enroll_poll" && request.EnumerateObject().Count() == 2)
            {
                var state = await cloud.PollEnrollmentAsync(request.GetProperty("enrollment_id").GetGuid(), token);
                return JsonSerializer.Serialize(new { ok = true, state });
            }
            if (operation == "enroll_cancel" && request.EnumerateObject().Count() == 2)
            {
                await cloud.CancelEnrollmentAsync(request.GetProperty("enrollment_id").GetGuid(), token);
                return JsonSerializer.Serialize(new { ok = true });
            }
            if (operation == "cloud_disconnect" && request.EnumerateObject().Count() == 1)
            {
                var revoked = await cloud.DisconnectAsync(token);
                return JsonSerializer.Serialize(new { ok = true, revoked });
            }
            if (operation != "enroll" || request.EnumerateObject().Count() != 3)
                return JsonSerializer.Serialize(new { ok = false, error = "unknown request" });
            await cloud.EnrollAsync(request.GetProperty("cloud_url").GetString() ?? "",
                request.GetProperty("code").GetString() ?? "", token);
            return JsonSerializer.Serialize(new { ok = true });
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException or
                                     ArgumentException or HttpRequestException or IOException or FormatException or
                                     System.Security.Cryptography.CryptographicException or UnauthorizedAccessException or
                                     System.Runtime.InteropServices.COMException or System.ComponentModel.Win32Exception)
        {
            return JsonSerializer.Serialize(new { ok = false, error = "无法完成操作，请检查服务、Cloud 地址和连接状态" });
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
        var status = network.ReadStatus();
        return new ServiceStatus(Environment.MachineName, status.LanIp, status.Mac,
            status.WolState, status.LanState, cloud.State, cloud.GatewayState, "1.4.0", cloud.CloudUrl);
    }
}
