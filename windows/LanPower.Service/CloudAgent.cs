using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Service;

public sealed class CloudAgent(
    LanConfig lanConfig, CloudCredentialStore credentials, ReplayStore replay,
    HttpClient client, PowerGate gate, PowerExecutor power, ServiceLog log,
    Func<LocalNetworkSnapshot>? networkStatus = null) : BackgroundService
{
    private readonly CloudTokenSession _tokens = new(client, credentials);
    private readonly object _connectionSync = new();
    private CancellationTokenSource _connection = new();
    private string _state = "未配置";
    private string _gatewayState = "状态未知";
    private string _cloudUrl = "";
    private CloudEnrollment? _enrollment;
    private CloudEnrollment Enrollment => LazyInitializer.EnsureInitialized(ref _enrollment,
        () => new CloudEnrollment(client, SaveTokensAsync));
    public string State => Volatile.Read(ref _state);
    public string CloudUrl => Volatile.Read(ref _cloudUrl);
    public string GatewayState => State == "未配置" ? "未配置" : State == "已连接" ? Volatile.Read(ref _gatewayState) : "等待云端连接";

    public Task<CloudPairing> BeginEnrollmentAsync(string cloudUrl, CancellationToken token) =>
        Enrollment.BeginAsync(cloudUrl, token);

    public Task<string> PollEnrollmentAsync(Guid id, CancellationToken token) => Enrollment.PollAsync(id, token);

    public Task CancelEnrollmentAsync(Guid id, CancellationToken token) => Enrollment.CancelAsync(id, token);

    public async Task<bool> DisconnectAsync(CancellationToken token)
    {
        await Enrollment.CancelAsync(null, token);
        ResetConnection();
        var removed = await _tokens.ClearAsync(token);
        Volatile.Write(ref _cloudUrl, "");
        Volatile.Write(ref _gatewayState, "未配置");
        Volatile.Write(ref _state, "未配置");
        ResetConnection();
        log.Write("已断开本机 Cloud 连接");
        if (removed.Credentials is null || removed.AccessToken is null) return false;
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(TimeSpan.FromSeconds(5));
            using var response = await AuthenticatedPostAsync(removed.Credentials.CloudUrl + "/api/v2/devices/revoke",
                removed.AccessToken, new { }, deadline.Token);
            return response.IsSuccessStatusCode;
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException)
        {
            log.Write("本机已断开，请在 Cloud 控制台移除原设备");
            return false;
        }
    }

    private void ResetConnection()
    {
        lock (_connectionSync)
        {
            var previous = _connection;
            _connection = new CancellationTokenSource();
            previous.Cancel();
            previous.Dispose();
        }
    }

    private CancellationTokenSource ConnectionToken(CancellationToken stoppingToken)
    {
        lock (_connectionSync)
            return CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, _connection.Token);
    }

    public async Task EnrollAsync(string cloudUrl, string code, CancellationToken token)
    {
        var origin = CloudEnrollment.NormalizeOrigin(cloudUrl);
        if (code.Length is < 10 or > 80) throw new ArgumentException("配对码无效");
        using var response = await client.PostAsJsonAsync(origin + "/api/v2/windows/enroll",
            new { code, name = Environment.MachineName, version = "1.4.0", protocol_version = "2" }, token);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("配对失败，请检查地址和配对码");
        using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token)
            ?? throw new InvalidDataException("Cloud 配对响应无效");
        await SaveTokensAsync(origin, data.RootElement, token);
    }

    private async Task SaveTokensAsync(string origin, JsonElement result, CancellationToken token)
    {
        await _tokens.SaveEnrollmentAsync(origin, result, token);
        Volatile.Write(ref _cloudUrl, origin);
        Volatile.Write(ref _state, "连接中");
        ResetConnection();
        log.Write("Windows 设备已完成 Cloud 配对");
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var connection = ConnectionToken(stoppingToken);
            var token = connection.Token;
            CloudCredentials? saved = null;
            try
            {
                var configured = credentials.Load();
                if (configured is null)
                {
                    Volatile.Write(ref _state, "未配置");
                    await Task.Delay(5000, stoppingToken);
                    continue;
                }
                Volatile.Write(ref _cloudUrl, configured.CloudUrl);
                var granted = await _tokens.GetAccessAsync(token);
                saved = granted.Credentials;
                var access = granted.Token;
                token.ThrowIfCancellationRequested();
                Volatile.Write(ref _cloudUrl, saved.CloudUrl);
                var network = networkStatus?.Invoke() ?? LocalNetworkStatus.Read(lanConfig);
                using (var heartbeat = await AuthenticatedPostAsync(saved.CloudUrl + "/api/v2/windows/heartbeat", access,
                    new { device_id = saved.DeviceId, version = "1.4.0", state = "online",
                          uptime = Environment.TickCount64 / 1000, lan_ip = network.LanIp, wol_capable = network.WolCapable }, token))
                {
                    if (heartbeat.StatusCode == HttpStatusCode.Unauthorized) throw new UnauthorizedAccessException();
                    heartbeat.EnsureSuccessStatusCode();
                    using var presence = await heartbeat.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token);
                    token.ThrowIfCancellationRequested();
                    var gatewayState = "状态未知";
                    if (presence?.RootElement.TryGetProperty("wake_gateway", out var gateway) == true)
                    {
                        gatewayState = gateway.ValueKind == JsonValueKind.Null ? "未配置" :
                            gateway.TryGetProperty("state", out var state) && state.GetString() == "online" ?
                            presence.RootElement.TryGetProperty("wake_available", out var available) && available.ValueKind == JsonValueKind.True
                                ? "已连接，远程唤醒可用" : "已连接，待配置电脑" : "未连接";
                    }
                    Volatile.Write(ref _gatewayState, gatewayState);
                }
                Volatile.Write(ref _state, "已连接");
                using var poll = new HttpRequestMessage(HttpMethod.Get, saved.CloudUrl + "/api/v2/windows/commands");
                poll.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
                using var response = await client.SendAsync(poll, token);
                if (response.StatusCode == HttpStatusCode.Unauthorized) throw new UnauthorizedAccessException();
                response.EnsureSuccessStatusCode();
                using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token)
                    ?? throw new InvalidDataException("Cloud 命令响应无效");
                var command = data.RootElement.GetProperty("command");
                if (command.ValueKind != JsonValueKind.Null)
                    await ProcessCommandAsync(saved, access, command, token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { continue; }
            catch (UnauthorizedAccessException)
            {
                if (saved is not null)
                {
                    try { await _tokens.BlockAsync(saved, stoppingToken); }
                    catch (Exception error) when (error is IOException or System.Security.Cryptography.CryptographicException or UnauthorizedAccessException)
                    { log.Write("无法保存 Cloud 连接状态：" + error.GetType().Name); }
                }
                if (token.IsCancellationRequested) continue;
                Volatile.Write(ref _state, "需要重新连接");
                await Task.Delay(5000, stoppingToken);
            }
            catch (Exception error)
            {
                if (token.IsCancellationRequested) continue;
                Volatile.Write(ref _state, "连接中断");
                log.Write("Cloud 连接失败：" + error.GetType().Name);
                await Task.Delay(5000, stoppingToken);
            }
        }
    }

    private async Task ProcessCommandAsync(CloudCredentials saved, string access, JsonElement payload, CancellationToken token)
    {
        var current = credentials.Load();
        token.ThrowIfCancellationRequested();
        if (current?.CloudUrl != saved.CloudUrl || current.DeviceId != saved.DeviceId) return;
        CloudCommand command;
        try { command = CloudCommand.Parse(payload, saved.DeviceId, DateTimeOffset.UtcNow); }
        catch (Exception error) when (error is InvalidDataException or KeyNotFoundException or InvalidOperationException or ArgumentException or JsonException)
        {
            log.Write("Cloud 命令被拒绝：" + error.GetType().Name);
            return;
        }
        var existing = replay.Find(command);
        var accepted = existing is not null || command.Action == "status" || gate.TryAccept();
        var result = existing ?? replay.Prepare(command, accepted);
        using var response = await AuthenticatedPostAsync(saved.CloudUrl + "/api/v2/windows/results", access,
            new { command_id = result.CommandId, ok = result.Ok, state = result.State, error = result.Error }, token);
        if (response.StatusCode == HttpStatusCode.Unauthorized) throw new UnauthorizedAccessException();
        response.EnsureSuccessStatusCode();
        token.ThrowIfCancellationRequested();
        if (result.Ok && command.Action != "status" && !result.Executed)
        {
            replay.MarkExecuted(result);
            log.Write("已接收 Cloud 电源命令：" + command.Action);
            _ = Task.Run(async () =>
            {
                await Task.Delay(1250);
                power.Execute(command.Action);
            });
        }
    }

    private async Task<HttpResponseMessage> AuthenticatedPostAsync(string url, string access, object body, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = JsonContent.Create(body) };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
        return await client.SendAsync(request, token);
    }
}
