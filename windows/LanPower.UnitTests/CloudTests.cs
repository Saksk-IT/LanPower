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
    public async Task AgentEnrollsPollsAndReportsWithoutGateway()
    {
        var folder = Path.Combine(Path.GetTempPath(), "LanPowerCloudTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            var deviceId = Guid.NewGuid().ToString();
            var commandId = Guid.NewGuid();
            var handler = new FakeCloudHandler(deviceId, commandId);
            using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(3) };
            var config = new LanConfig { Token = new string('a', 64), HostIp = "127.0.0.1", AllowedNetworks = ["127.0.0.0/8"] };
            var agent = new CloudAgent(config, new CloudCredentialStore(folder), new ReplayStore(folder),
                http, new PowerGate(), new PowerExecutor(true, new ServiceLog(Path.Combine(folder, "service.log"))),
                new ServiceLog(Path.Combine(folder, "service.log")));
            await agent.EnrollAsync("https://cloud.example.test", new string('x', 24), CancellationToken.None);
            await agent.StartAsync(CancellationToken.None);
            try
            {
                await handler.ResultReported.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Assert.AreEqual("status", handler.ReportedAction);
                Assert.AreEqual("已连接", agent.State);
                Assert.IsNotNull(new CloudCredentialStore(folder).Load());
            }
            finally { await agent.StopAsync(CancellationToken.None); }
        }
        finally { Directory.Delete(folder, true); }
    }

    private sealed class FakeCloudHandler(string deviceId, Guid commandId) : HttpMessageHandler
    {
        private int _polls;
        public string? ReportedAction { get; private set; }
        public TaskCompletionSource ResultReported { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            object result;
            if (path.EndsWith("/enroll"))
            {
                result = new { device_id = deviceId, access_token = new string('a', 43),
                    refresh_token = new string('r', 43), access_expires_at = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 900 };
            }
            else if (path.EndsWith("/heartbeat")) result = new { ok = true };
            else if (path.EndsWith("/commands"))
            {
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
}
