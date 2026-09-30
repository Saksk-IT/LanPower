using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Service;

public sealed class CloudAgent(
    LanConfig lanConfig, CloudCredentialStore credentials, ReplayStore replay,
    HttpClient client, PowerGate gate, PowerExecutor power, ServiceLog log,
    Func<LocalNetworkSnapshot>? networkStatus = null, WakeProfileService? wakeProfiles = null,
    Func<LanConfig>? currentConfig = null) : BackgroundService
{
    private readonly CloudTokenSession _tokens = new(client, credentials);
    private readonly object _connectionSync = new();
    private CancellationTokenSource _connection = new();
    private readonly SemaphoreSlim _heartbeatWakeup = new(0, 1);
    private readonly SemaphoreSlim _heartbeatSend = new(1, 1);
    private bool _legacyHeartbeat;
    private bool _wakeSetupSupported;
    private string _deviceId = "";
    private string _gatewayHint = "";
    private long _powerPendingUntil;
    private long _lastHeartbeat;
    private string _state = "未配置";
    private string _gatewayState = "状态未知";
    private string _cloudUrl = "";
    private CloudEnrollment? _enrollment;
    private CloudEnrollment Enrollment => LazyInitializer.EnsureInitialized(ref _enrollment,
        () => new CloudEnrollment(client, SaveTokensAsync));
    public string State => Volatile.Read(ref _state) == "已连接" && Environment.TickCount64 - Volatile.Read(ref _lastHeartbeat) > 35000
        ? "连接中断" : Volatile.Read(ref _state);
    public string CloudUrl => Volatile.Read(ref _cloudUrl);
    public string DeviceId => Volatile.Read(ref _deviceId);
    public string GatewayHint => State == "已连接" ? Volatile.Read(ref _gatewayHint) : "";
    public string GatewayState => State == "未配置" ? "未配置" : State == "已连接" ? Volatile.Read(ref _gatewayState) : "等待云端连接";

    public WakeProfile? ReadWakeProfile(string? authorization) => State != "已连接" ? null :
        wakeProfiles?.Read(authorization, CloudUrl, DeviceId, currentConfig?.Invoke() ?? lanConfig,
            networkStatus?.Invoke() ?? LocalNetworkStatus.Read(lanConfig));

    public Task<CloudPairing> BeginEnrollmentAsync(string cloudUrl, CancellationToken token) =>
        Enrollment.BeginAsync(cloudUrl, token);

    public Task<string> PollEnrollmentAsync(Guid id, CancellationToken token) => Enrollment.PollAsync(id, token);

    public Task CancelEnrollmentAsync(Guid id, CancellationToken token) => Enrollment.CancelAsync(id, token);

    public async Task<bool> DisconnectAsync(CancellationToken token)
    {
        await Enrollment.CancelAsync(null, token);
        ResetConnection();
        var removed = await _tokens.ClearAsync(token);
        wakeProfiles?.Clear();
        Volatile.Write(ref _deviceId, "");
        Volatile.Write(ref _gatewayHint, "");
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
            new { code, name = Environment.MachineName, version = "1.5.0", protocol_version = "2" }, token);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("配对失败，请检查地址和配对码");
        using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token)
            ?? throw new InvalidDataException("Cloud 配对响应无效");
        await SaveTokensAsync(origin, data.RootElement, token);
    }

    private async Task SaveTokensAsync(string origin, JsonElement result, CancellationToken token)
    {
        await _tokens.SaveEnrollmentAsync(origin, result, token);
        wakeProfiles?.Clear();
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
                token.ThrowIfCancellationRequested();
                Volatile.Write(ref _deviceId, saved.DeviceId);
                Volatile.Write(ref _cloudUrl, saved.CloudUrl);
                await RunConnectionAsync(saved, token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { continue; }
            catch (UnauthorizedAccessException)
            {
                if (token.IsCancellationRequested) continue;
                Volatile.Write(ref _state, "需要重新连接");
                await Task.Delay(5000, stoppingToken);
            }
            catch (Exception error)
            {
                if (token.IsCancellationRequested) continue;
                Volatile.Write(ref _state, "连接中断");
                log.WriteFailure("Cloud 连接失败", error);
                await Task.Delay(5000, stoppingToken);
            }
        }
    }

    private string PresenceState => Environment.TickCount64 < Volatile.Read(ref _powerPendingUntil) ? "transitioning" : "online";

    private object HeartbeatBody(CloudCredentials saved, string state)
    {
        var network = networkStatus?.Invoke() ?? LocalNetworkStatus.Read(lanConfig);
        var body = new Dictionary<string, object>
        {
            ["device_id"] = saved.DeviceId, ["version"] = "1.5.0",
            ["state"] = _legacyHeartbeat ? "online" : state,
            ["uptime"] = Environment.TickCount64 / 1000,
            ["lan_ip"] = network.LanIp, ["wol_capable"] = network.WolCapable
        };
        if (!_legacyHeartbeat) body["heartbeat_interval"] = 10;
        if (_wakeSetupSupported && !_legacyHeartbeat)
            body["wake_profile"] = state == "online" ? wakeProfiles?.Issue(saved.CloudUrl, saved.DeviceId,
                currentConfig?.Invoke() ?? lanConfig, network)! : null!;
        return body;
    }

    private async Task RunConnectionAsync(CloudCredentials saved, CancellationToken token)
    {
        _legacyHeartbeat = false;
        _wakeSetupSupported = false;
        await SendHeartbeatAsync(saved, token);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
        var heartbeats = MaintainHeartbeatsAsync(saved, lifetime.Token);
        var commands = PollCommandsAsync(saved, lifetime.Token);
        try { await await Task.WhenAny(heartbeats, commands); }
        finally
        {
            lifetime.Cancel();
            // Observe both workers; the first failure remains the reported cause.
            try { await Task.WhenAll(heartbeats, commands); } catch { }
        }
    }

    private async Task MaintainHeartbeatsAsync(CloudCredentials saved, CancellationToken token)
    {
        while (true)
        {
            await _heartbeatWakeup.WaitAsync(TimeSpan.FromSeconds(10), token);
            await SendHeartbeatAsync(saved, token);
        }
    }

    private async Task SendHeartbeatAsync(CloudCredentials saved, CancellationToken token)
    {
        await _heartbeatSend.WaitAsync(token);
        try { await SendHeartbeatCoreAsync(saved, token); }
        finally { _heartbeatSend.Release(); }
    }

    private async Task SendHeartbeatCoreAsync(CloudCredentials saved, CancellationToken token)
    {
        // A long command poll must never postpone the next presence update.
        var heartbeat = await SendAuthorizedAsync(saved, HttpMethod.Post, "/api/v2/windows/heartbeat",
            new Func<object>(() => HeartbeatBody(saved, PresenceState)), token);
        if (heartbeat.StatusCode == HttpStatusCode.BadRequest && !_legacyHeartbeat)
        {
            using (heartbeat)
            {
                using var error = await heartbeat.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token);
                if (error?.RootElement.TryGetProperty("error", out var detail) != true || detail.GetString() != "invalid heartbeat")
                    heartbeat.EnsureSuccessStatusCode();
            }
            // Older Cloud versions reject the added presence fields before writing anything.
            _legacyHeartbeat = true;
            _wakeSetupSupported = false;
            heartbeat = await SendAuthorizedAsync(saved, HttpMethod.Post, "/api/v2/windows/heartbeat",
                new Func<object>(() => HeartbeatBody(saved, PresenceState)), token);
        }
        using var completed = heartbeat;
        heartbeat.EnsureSuccessStatusCode();
        using var presence = await heartbeat.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token);
        token.ThrowIfCancellationRequested();
        if (!_wakeSetupSupported && presence?.RootElement.TryGetProperty("wake_setup_protocol", out var setupProtocol) == true &&
            setupProtocol.TryGetInt32(out var setupVersion) && setupVersion == 1)
        {
            _wakeSetupSupported = true;
            WakeHeartbeat();
        }
        if (_legacyHeartbeat && presence?.RootElement.TryGetProperty("presence_protocol", out var protocol) == true &&
            protocol.TryGetInt32(out var version) && version >= 1)
        {
            _legacyHeartbeat = false;
            WakeHeartbeat();
        }
        var gatewayState = "状态未知";
        if (presence?.RootElement.TryGetProperty("wake_gateway", out var gateway) == true)
        {
            gatewayState = gateway.ValueKind == JsonValueKind.Null ? "未配置" :
                gateway.TryGetProperty("state", out var state) && state.GetString() == "online" ?
                presence.RootElement.TryGetProperty("wake_available", out var available) && available.ValueKind == JsonValueKind.True
                    ? "已连接，远程唤醒可用" : "已连接，待配置电脑" : "未连接";
        }
        Volatile.Write(ref _gatewayState, gatewayState);
        Volatile.Write(ref _gatewayHint, presence?.RootElement.TryGetProperty("wake_setup_message", out var hint) == true &&
            hint.ValueKind == JsonValueKind.String ? hint.GetString() ?? "" : "");
        Volatile.Write(ref _lastHeartbeat, Environment.TickCount64);
        Volatile.Write(ref _state, "已连接");
    }

    private async Task PollCommandsAsync(CloudCredentials saved, CancellationToken token)
    {
        while (true)
        {
            using var response = await SendAuthorizedAsync(saved, HttpMethod.Get, "/api/v2/windows/commands", null, token);
            using var data = await response.Content.ReadFromJsonAsync<JsonDocument>(cancellationToken: token)
                ?? throw new InvalidDataException("Cloud 命令响应无效");
            token.ThrowIfCancellationRequested();
            var command = data.RootElement.GetProperty("command");
            if (command.ValueKind != JsonValueKind.Null) await ProcessCommandAsync(saved, command, token);
        }
    }

    private async Task<HttpResponseMessage> SendAuthorizedAsync(CloudCredentials saved, HttpMethod method,
        string path, object? body, CancellationToken token)
    {
        for (var attempt = 0; ; attempt++)
        {
            var granted = await _tokens.GetAccessAsync(token);
            token.ThrowIfCancellationRequested();
            if (granted.Credentials.CloudUrl != saved.CloudUrl || granted.Credentials.DeviceId != saved.DeviceId)
                throw new InvalidOperationException("Cloud 连接已更换");
            using var request = new HttpRequestMessage(method, saved.CloudUrl + path);
            if (body is not null) request.Content = JsonContent.Create(body is Func<object> factory ? factory() : body);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", granted.Token);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            if (path is "/api/v2/windows/heartbeat" or "/api/v2/windows/results") deadline.CancelAfter(TimeSpan.FromSeconds(5));
            var response = await client.SendAsync(request, deadline.Token);
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                response.Dispose();
                var latest = await _tokens.GetCachedAccessAsync(token);
                // The heartbeat worker may have rotated while a poll was sent.
                if (attempt == 0 && latest?.Credentials.DeviceId == saved.DeviceId && latest.Token != granted.Token) continue;
                await _tokens.BlockAsync(granted.Credentials, token);
                throw new UnauthorizedAccessException();
            }
            if (path == "/api/v2/windows/heartbeat" && response.StatusCode == HttpStatusCode.BadRequest) return response;
            try { response.EnsureSuccessStatusCode(); return response; }
            catch { response.Dispose(); throw; }
        }
    }

    private void WakeHeartbeat()
    {
        try { _heartbeatWakeup.Release(); } catch (SemaphoreFullException) { }
    }

    public async Task ExecutePowerAsync(string action)
    {
        if (!LanProtocol.IsPowerAction(action)) throw new ArgumentException("未知电源动作", nameof(action));
        if (!power.DryRun)
        {
            Volatile.Write(ref _powerPendingUntil, Environment.TickCount64 + 45000);
            WakeHeartbeat();
        }
        await Task.Delay(1250);
        var success = await Task.Run(() => power.Execute(action));
        if (power.DryRun || !success || action == "sleep")
        {
            Volatile.Write(ref _powerPendingUntil, 0);
            WakeHeartbeat();
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(3));
            var granted = await _tokens.GetCachedAccessAsync(deadline.Token);
            if (granted is not null && !_legacyHeartbeat)
            {
                using var response = await AuthenticatedPostAsync(granted.Credentials.CloudUrl + "/api/v2/windows/heartbeat",
                    granted.Token, HeartbeatBody(granted.Credentials, "offline"), deadline.Token);
                response.EnsureSuccessStatusCode();
            }
        }
        catch (Exception error) { log.WriteFailure("Cloud 离线上报未完成", error); }
        Volatile.Write(ref _state, "已停止");
        wakeProfiles?.Clear();
    }

    private async Task ProcessCommandAsync(CloudCredentials saved, JsonElement payload, CancellationToken token)
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
        // Finish any older online heartbeat before acknowledging a power transition.
        await _heartbeatSend.WaitAsync(token);
        try
        {
            using var response = await SendAuthorizedAsync(saved, HttpMethod.Post, "/api/v2/windows/results",
                new { command_id = result.CommandId, ok = result.Ok, state = result.State, error = result.Error }, token);
            token.ThrowIfCancellationRequested();
            if (result.Ok && command.Action != "status" && !result.Executed)
            {
                replay.MarkExecuted(result);
                log.Write("已接收 Cloud 电源命令：" + command.Action);
                _ = ExecutePowerAsync(command.Action);
            }
        }
        finally { _heartbeatSend.Release(); }
    }

    private async Task<HttpResponseMessage> AuthenticatedPostAsync(string url, string access, object body, CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = JsonContent.Create(body) };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access);
        return await client.SendAsync(request, token);
    }
}
