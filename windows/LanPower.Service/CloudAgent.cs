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
    private readonly SemaphoreSlim _tokensLock = new(1, 1);
    private string? _accessToken;
    private long _accessExpiresAt;
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
        var deviceId = result.GetProperty("device_id").GetString()!;
        var access = result.GetProperty("access_token").GetString()!;
        var refresh = result.GetProperty("refresh_token").GetString()!;
        var expires = result.GetProperty("access_expires_at").GetInt64();
        if (!Guid.TryParse(deviceId, out _) || access.Length is < 32 or > 128 || refresh.Length is < 32 or > 128 ||
            expires <= DateTimeOffset.UtcNow.ToUnixTimeSeconds())
            throw new InvalidDataException("Cloud 配对响应无效");
        await _tokensLock.WaitAsync(token);
        try
        {
            credentials.Save(new CloudCredentials(origin, deviceId, refresh));
            Volatile.Write(ref _cloudUrl, origin);
            _accessToken = access;
            _accessExpiresAt = expires;
            Volatile.Write(ref _state, "连接中");
        }
        finally { _tokensLock.Release(); }
        log.Write("Windows 设备已完成 Cloud 配对");
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
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
                var (saved, access) = await EnsureAccessAsync(stoppingToken);
                Volatile.Write(ref _cloudUrl, saved.CloudUrl);
                var network = networkStatus?.Invoke() ?? LocalNetworkStatus.Read(lanConfig);
                using (var heartbeat = await AuthenticatedPostAsync(saved.CloudUrl + "/api/v2/windows/heartbeat", access,
                    new { device_id = saved.DeviceId, version = "1.4.0", state = "online",
                          uptime = Environment.TickCount64 / 1000, lan_ip = network.LanIp, wol_capable = network.WolCapable }, stoppingToken))
                {
                    if (heartbeat.StatusCode == HttpStatusCode.Unauthorized) throw new UnauthorizedAccessException();
                    heartbeat.EnsureSuccessStatusCode();
                    using var presence = await heartbeat.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: stoppingToken);
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
                using var response = await client.SendAsync(poll, stoppingToken);
                if (response.StatusCode == HttpStatusCode.Unauthorized) throw new UnauthorizedAccessException();
                response.EnsureSuccessStatusCode();
                using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: stoppingToken)
                    ?? throw new InvalidDataException("Cloud 命令响应无效");
                var command = data.RootElement.GetProperty("command");
                if (command.ValueKind != JsonValueKind.Null)
                    await ProcessCommandAsync(saved, access, command, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (UnauthorizedAccessException)
            {
                _accessToken = null;
                Volatile.Write(ref _state, "需要重新连接");
                await Task.Delay(5000, stoppingToken);
            }
            catch (Exception error)
            {
                Volatile.Write(ref _state, "连接中断");
                log.Write("Cloud 连接失败：" + error.GetType().Name);
                await Task.Delay(5000, stoppingToken);
            }
        }
    }

    private async Task<(CloudCredentials Credentials, string Access)> EnsureAccessAsync(CancellationToken token)
    {
        await _tokensLock.WaitAsync(token);
        try
        {
            // Read the credential identity while holding the same lock as enrollment.
            // A newly issued token must never be sent to a previous Cloud address.
            var saved = credentials.Load() ?? throw new InvalidDataException("Cloud 未配置");
            if (_accessToken is not null && _accessExpiresAt > DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 60)
                return (saved, _accessToken);
            using var response = await client.PostAsJsonAsync(saved.CloudUrl + "/api/v2/windows/token",
                new { device_id = saved.DeviceId, refresh_token = saved.RefreshToken }, token);
            if (response.StatusCode == HttpStatusCode.Unauthorized) throw new UnauthorizedAccessException();
            response.EnsureSuccessStatusCode();
            using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token)
                ?? throw new InvalidDataException("Cloud 凭据响应无效");
            var result = data.RootElement;
            var refresh = result.GetProperty("refresh_token").GetString()!;
            var access = result.GetProperty("access_token").GetString()!;
            if (result.GetProperty("device_id").GetString() != saved.DeviceId || refresh.Length < 32 || access.Length < 32)
                throw new InvalidDataException("Cloud 凭据响应无效");
            credentials.Save(saved with { RefreshToken = refresh });
            _accessToken = access;
            _accessExpiresAt = result.GetProperty("access_expires_at").GetInt64();
            return (saved, access);
        }
        finally { _tokensLock.Release(); }
    }

    private async Task ProcessCommandAsync(CloudCredentials saved, string access, JsonElement payload, CancellationToken token)
    {
        var current = credentials.Load();
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
