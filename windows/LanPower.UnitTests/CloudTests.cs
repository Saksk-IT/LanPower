using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using LanPower.Service;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class CloudTests
{
    [TestMethod]
    public void CloudCommandRequiresExactDeviceActionAndExpiry()
    {
        var now = DateTimeOffset.UtcNow;
        var id = Guid.NewGuid();
        var target = Guid.NewGuid().ToString();
        JsonElement Payload(string action, string device, long expires) => JsonSerializer.SerializeToElement(new
        {
            command_id = id.ToString(), target_device_id = device, action,
            issued_at = now.ToUnixTimeSeconds(), expires_at = expires, nonce = new string('a', 32)
        });
        Assert.AreEqual("shutdown", CloudCommand.Parse(Payload("shutdown", target, now.ToUnixTimeSeconds() + 40), target, now).Action);
        Assert.ThrowsExactly<InvalidDataException>(() => CloudCommand.Parse(Payload("cmd", target, now.ToUnixTimeSeconds() + 40), target, now));
        Assert.ThrowsExactly<InvalidDataException>(() => CloudCommand.Parse(Payload("shutdown", Guid.NewGuid().ToString(), now.ToUnixTimeSeconds() + 40), target, now));
        Assert.ThrowsExactly<InvalidDataException>(() => CloudCommand.Parse(Payload("shutdown", target, now.ToUnixTimeSeconds() - 1), target, now));
    }

    [TestMethod]
    public void ReplayStoreSurvivesRestartAndPreventsSecondExecution()
    {
        var folder = Path.Combine(Path.GetTempPath(), "LanPowerReplayTests", Guid.NewGuid().ToString("N"));
        try
        {
            var command = new CloudCommand(Guid.NewGuid(), Guid.NewGuid().ToString(), "shutdown", 1, 20, new string('b', 32));
            var first = new ReplayStore(folder);
            var entry = first.Prepare(command, true);
            first.MarkExecuted(entry);
            var restored = new ReplayStore(folder).Find(command);
            Assert.IsNotNull(restored);
            Assert.IsTrue(restored.Executed);
            Assert.ThrowsExactly<InvalidDataException>(() => new ReplayStore(folder).Find(command with { Nonce = new string('c', 32) }));
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }

    [TestMethod]
    public void CorruptReplayStoreRefusesCloudCommandsWithoutCrashing()
    {
        var folder = Path.Combine(Path.GetTempPath(), "LanPowerReplayTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            File.WriteAllText(Path.Combine(folder, "cloud-replay.jsonl"), "{incomplete");
            var store = new ReplayStore(folder);
            var command = new CloudCommand(Guid.NewGuid(), Guid.NewGuid().ToString(), "shutdown", 1, 20, new string('b', 32));
            Assert.ThrowsExactly<InvalidDataException>(() => store.Prepare(command, true));
        }
        finally { Directory.Delete(folder, true); }
    }

    [TestMethod]
    [DataRow("legacy", "状态未知")]
    [DataRow("none", "未配置")]
    [DataRow("offline", "未连接")]
    [DataRow("online", "已连接，远程唤醒可用")]
    [DataRow("unconfigured", "已连接，待配置电脑")]
    public async Task AgentReportsCommandsAndActualGatewayState(string gatewayState, string expectedState)
    {
        var folder = Path.Combine(Path.GetTempPath(), "LanPowerCloudTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            var deviceId = Guid.NewGuid().ToString();
            var commandId = Guid.NewGuid();
            var handler = new FakeCloudHandler(deviceId, commandId, gatewayState);
            using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(3) };
            var config = new LanConfig { Token = new string('a', 64), HostIp = "127.0.0.1", AllowedNetworks = ["127.0.0.0/8"] };
            var agent = new CloudAgent(config, new CloudCredentialStore(folder), new ReplayStore(folder),
                http, new PowerGate(), new PowerExecutor(true, new ServiceLog(Path.Combine(folder, "service.log"))),
                new ServiceLog(Path.Combine(folder, "service.log")),
                () => new LocalNetworkSnapshot("192.168.1.20", "02:00:00:00:00:01", "已连接", "系统允许唤醒", true));
            await agent.EnrollAsync("https://cloud.example.test", new string('x', 24), CancellationToken.None);
            await agent.StartAsync(CancellationToken.None);
            try
            {
                await handler.ResultReported.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Assert.AreEqual("status", handler.ReportedAction);
                Assert.AreEqual("已连接", agent.State);
                Assert.AreEqual(expectedState, agent.GatewayState);
                Assert.AreEqual("https://cloud.example.test", agent.CloudUrl);
                Assert.IsTrue(handler.WolCapable);
                Assert.IsNotNull(new CloudCredentialStore(folder).Load());
            }
            finally { await agent.StopAsync(CancellationToken.None); }
        }
        finally { Directory.Delete(folder, true); }
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task HeartbeatsContinueDuringLongPollAndServiceStopReportsOfflineWithoutRevokingCredentials(bool legacyHeartbeat)
    {
        var folder = Path.Combine(Path.GetTempPath(), "LanPowerPresenceTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            using var handler = new FakeCloudHandler(Guid.NewGuid().ToString(), Guid.NewGuid(), "none",
                stalledPoll: true, legacyHeartbeat: legacyHeartbeat);
            using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
            var config = new LanConfig { Token = new string('a', 64), HostIp = "127.0.0.1", AllowedNetworks = ["127.0.0.0/8"] };
            var store = new CloudCredentialStore(folder);
            var log = new ServiceLog(Path.Combine(folder, "service.log"));
            using var agent = new CloudAgent(config, store, new ReplayStore(folder), http,
                new PowerGate(), new PowerExecutor(true, log), log,
                () => new LocalNetworkSnapshot("192.168.1.20", "", "已连接", "需检查", false));
            await agent.EnrollAsync("https://cloud.example.test", new string('x', 24), CancellationToken.None);
            var saved = store.Load();
            await agent.StartAsync(CancellationToken.None);
            try
            {
                await handler.SecondHeartbeat.Task.WaitAsync(TimeSpan.FromSeconds(15));
                Assert.AreEqual(1, handler.Polls);
                Assert.AreEqual("已连接", agent.State);
                Assert.AreEqual(legacyHeartbeat ? 0 : 10, handler.HeartbeatInterval);
                Assert.AreEqual(legacyHeartbeat ? 1 : 0, handler.RejectedHeartbeats);
            }
            finally { await agent.StopAsync(CancellationToken.None); }
            Assert.AreEqual(legacyHeartbeat ? "online" : "offline", handler.LastHeartbeatState);
            Assert.AreEqual(saved, store.Load());
            Assert.IsFalse(handler.Revoked);
        }
        finally { Directory.Delete(folder, true); }
    }

    [TestMethod]
    public async Task AgentRenewsRejectedAccessAndRestoresHeartbeatAndCommandsWithoutPairing()
    {
        var folder = Path.Combine(Path.GetTempPath(), "LanPowerResumeTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            using var handler = new FakeCloudHandler(Guid.NewGuid().ToString(), Guid.NewGuid(), "none", rejectOldAccess: true);
            using var http = new HttpClient(handler);
            var store = new CloudCredentialStore(folder);
            var log = new ServiceLog(Path.Combine(folder, "service.log"));
            using var agent = new CloudAgent(new LanConfig { Token = new string('a', 64) }, store,
                new ReplayStore(folder), http, new PowerGate(), new PowerExecutor(true, log), log,
                () => new LocalNetworkSnapshot("192.168.1.20", "", "已连接", "需检查", false));
            await agent.EnrollAsync("https://cloud.example.test", new string('x', 24), CancellationToken.None);
            var paired = store.Load();
            await agent.StartAsync(CancellationToken.None);
            try
            {
                await handler.ResultReported.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Assert.AreEqual(1, handler.Renewals);
                Assert.AreEqual("已连接", agent.State);
                Assert.IsTrue(agent.CloudConnected);
                Assert.AreEqual(paired, store.Load());
                Assert.IsFalse(handler.Revoked);
            }
            finally { await agent.StopAsync(CancellationToken.None); }
        }
        finally { Directory.Delete(folder, true); }
    }

    private sealed class FakeCloudHandler(string deviceId, Guid commandId, string gatewayState,
        bool stalledPoll = false, bool legacyHeartbeat = false, bool rejectOldAccess = false) : HttpMessageHandler
    {
        private int _polls;
        private int _heartbeats;
        public int Polls => Volatile.Read(ref _polls);
        public string? LastHeartbeatState;
        public int HeartbeatInterval;
        public int RejectedHeartbeats;
        public int Renewals;
        public TaskCompletionSource SecondHeartbeat { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string? ReportedAction { get; private set; }
        public bool WolCapable { get; private set; }
        public bool Revoked { get; private set; }
        public TaskCompletionSource ResultReported { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (rejectOldAccess && (path is "/api/v2/windows/heartbeat" or "/api/v2/windows/commands" or "/api/v2/windows/results")
                && request.Headers.Authorization?.Parameter == new string('a', 43))
                return new HttpResponseMessage(HttpStatusCode.Unauthorized);
            object result;
            if (path.EndsWith("/enroll"))
            {
                result = new { device_id = deviceId, access_token = new string('a', 43),
                    refresh_token = new string('r', 43), access_expires_at = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 900 };
            }
            else if (path.EndsWith("/renew"))
            {
                Interlocked.Increment(ref Renewals);
                result = new { device_id = deviceId, access_token = new string('b', 43),
                    refresh_token = new string('r', 43), access_expires_at = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 900 };
            }
            else if (path.EndsWith("/heartbeat"))
            {
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
                if (legacyHeartbeat && body.RootElement.TryGetProperty("heartbeat_interval", out _))
                {
                    Interlocked.Increment(ref RejectedHeartbeats);
                    return new HttpResponseMessage(HttpStatusCode.BadRequest)
                    {
                        Content = new StringContent("{\"error\":\"invalid heartbeat\"}", Encoding.UTF8, "application/json")
                    };
                }
                if (legacyHeartbeat) Assert.AreEqual("online", body.RootElement.GetProperty("state").GetString());
                WolCapable = body.RootElement.GetProperty("wol_capable").GetBoolean();
                LastHeartbeatState = body.RootElement.GetProperty("state").GetString();
                HeartbeatInterval = body.RootElement.TryGetProperty("heartbeat_interval", out var interval) ? interval.GetInt32() : 0;
                if (Interlocked.Increment(ref _heartbeats) == 2) SecondHeartbeat.TrySetResult();
                result = gatewayState == "legacy" ? new { ok = true } : (object)new
                {
                    ok = true, wake_available = gatewayState == "online",
                    wake_gateway = gatewayState == "none" ? null : new { state = gatewayState == "offline" ? "offline" : "online" }
                };
            }
            else if (path.EndsWith("/commands"))
            {
                if (stalledPoll)
                {
                    Interlocked.Increment(ref _polls);
                    await Task.Delay(Timeout.Infinite, cancellationToken);
                }
                if (Interlocked.Increment(ref _polls) == 1)
                    result = new { command = new { command_id = commandId.ToString(), target_device_id = deviceId,
                        action = "status", issued_at = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                        expires_at = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 45, nonce = new string('f', 32) } };
                else
                {
                    await Task.Delay(1000, cancellationToken);
                    result = new { command = (object?)null };
                }
            }
            else if (path.EndsWith("/revoke"))
            {
                Revoked = true;
                Assert.AreEqual("Bearer", request.Headers.Authorization?.Scheme);
                Assert.AreEqual(new string('a', 43), request.Headers.Authorization?.Parameter);
                result = new { ok = true };
            }
            else if (path.EndsWith("/results"))
            {
                var body = await request.Content!.ReadAsStringAsync(cancellationToken);
                if (body.Contains(commandId.ToString()) && body.Contains("\"ok\":true"))
                {
                    ReportedAction = "status";
                    ResultReported.TrySetResult();
                }
                result = new { ok = true };
            }
            else throw new InvalidOperationException("Unexpected Cloud request: " + path);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(result), Encoding.UTF8, "application/json")
            };
        }
    }

    [TestMethod]
    public async Task DisconnectStopsCloudAndClearsCredentialsWithoutChangingLanPairing()
    {
        var folder = Path.Combine(Path.GetTempPath(), "LanPowerDisconnectTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            using var handler = new FakeCloudHandler(Guid.NewGuid().ToString(), Guid.NewGuid(), "none");
            using var http = new HttpClient(handler);
            var config = new LanConfig { Token = new string('a', 64), HostIp = "127.0.0.1", AllowedNetworks = ["127.0.0.0/8"] };
            var credentials = new CloudCredentialStore(folder);
            var log = new ServiceLog(Path.Combine(folder, "service.log"));
            using var agent = new CloudAgent(config, credentials, new ReplayStore(folder), http,
                new PowerGate(), new PowerExecutor(true, log), log);
            await agent.EnrollAsync("https://cloud.example.test", new string('x', 24), CancellationToken.None);
            await agent.StartAsync(CancellationToken.None);
            try
            {
                await handler.ResultReported.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Assert.IsTrue(await agent.DisconnectAsync(CancellationToken.None));
                Assert.IsTrue(handler.Revoked);
                Assert.IsNull(credentials.Load());
                Assert.AreEqual("未配置", agent.State);
                Assert.AreEqual("", agent.CloudUrl);
                Assert.IsTrue(config.IsAuthorized("Bearer " + new string('a', 64)));
            }
            finally { await agent.StopAsync(CancellationToken.None); }
        }
        finally { Directory.Delete(folder, true); }
    }
}
