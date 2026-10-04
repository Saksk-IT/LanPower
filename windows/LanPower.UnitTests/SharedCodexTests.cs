using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using LanPower.CodexHost;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class SharedCodexTests
{
    private static JsonObject Request(string method, JsonObject? p = null) => new() { ["id"] = Guid.NewGuid().ToString("N"), ["method"] = method, ["params"] = p ?? new() };
    private static JsonArray Input(string text) => new(new JsonObject { ["type"] = "text", ["text"] = text });

    [TestMethod]
    public void SharedConnectionRejectsExternalHostsCredentialsAndInvalidGate()
    {
        var valid = new SharedCodexConnection("ws://127.0.0.1:1234/", new string('a', 64), "ws://127.0.0.1:1235/" + new string('b', 64));
        SharedCodexServer.ValidateConnection(valid);
        foreach (var invalid in new[] { valid with { Endpoint = "ws://example.com:1234/" }, valid with { Endpoint = "ws://user@127.0.0.1:1234/" },
            valid with { DesktopEndpoint = "ws://127.0.0.1:1235/short" }, valid with { Bearer = "invalid" }, valid with { Bearer = null! }, valid with { DesktopEndpoint = valid.DesktopEndpoint + "?token=leak" } })
            Assert.Throws<InvalidDataException>(() => SharedCodexServer.ValidateConnection(invalid));
    }

    [TestMethod]
    public async Task ConnectionBeforeServerReadyReturnsRecoverableStartupError()
    {
        var reserve = new TcpListener(IPAddress.Loopback, 0); reserve.Start();
        var port = ((IPEndPoint)reserve.LocalEndpoint).Port; reserve.Stop();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var error = await Assert.ThrowsAsync<IOException>(() => RuntimeClient.ConnectAsync(new Uri("ws://127.0.0.1:" + port + "/"), new string('a', 64), timeout.Token));
        Assert.AreEqual("shared_runtime_unavailable", error.Message);
    }

    [TestMethod]
    public void QueueProtocolRequiresUniqueIdentityAndRejectsPermissionOverrides()
    {
        var valid = Request("thread/queue/add", new() { ["threadId"] = "chat", ["clientUserMessageId"] = "one", ["input"] = Input("排队") });
        Assert.AreEqual("thread/queue/add", CodexRemoteProtocol.ValidateRequest(valid));
        valid["params"]!["approvalPolicy"] = "never";
        Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(valid));
        foreach (var p in new[] { new JsonObject { ["threadId"] = "chat", ["input"] = Input("missing identity") },
            new JsonObject { ["threadId"] = "chat", ["clientUserMessageId"] = "one", ["input"] = new JsonArray(new JsonObject { ["type"] = "image", ["url"] = "file:///private" }) } })
            Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request("thread/queue/add", p)));
        Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request("thread/queue/reorder", new() { ["threadId"] = "chat", ["queuedSubmissionIds"] = new JsonArray("same", "same") })));
    }

    [TestMethod]
    [DataRow("no rollout found for thread id native-chat")]
    [DataRow("invalid paginated history lineage for native-chat: missing source rollout")]
    public async Task TwoClientsControlSameTurnQueueApprovalAndReconnectWithoutStoppingServer(string missingHistory)
    {
        var root = Path.Combine(Path.GetTempPath(), "LanPowerSharedTests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            await using var server = new SharedFixture(root);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20)); var token = timeout.Token;
            await using var desktop = await RuntimeClient.ConnectAsync(server.Endpoint, server.Bearer, token); await desktop.InitializeAsync(token);
            await using var remote = new RemoteRuntime(() => new(true, [root], AutoDiscover:false, SharedControl:true), t => RuntimeClient.ConnectAsync(server.Endpoint, server.Bearer, t));
            await remote.OpenAsync(token); server.HideHistory = true; server.NoRolloutUntilStart = true;
            server.MissingHistory = "unexpected history failure";
            await Assert.ThrowsAsync<IOException>(() => remote.HandleAsync(Request("thread/read", new() { ["threadId"] = "native-chat", ["includeTurns"] = true }), token));
            server.MissingHistory = missingHistory;
            var loadedChats = (await remote.HandleAsync(Request("thread/list"), token))!["result"]!["data"]!.AsArray();
            Assert.AreEqual("native-chat", loadedChats[0]!["id"]!.GetValue<string>(), "A loaded native chat must remain visible before its first turn is persisted.");
            var idleChat = (await remote.HandleAsync(Request("thread/read", new() { ["threadId"] = "native-chat", ["includeTurns"] = true }), token))!["result"]!["thread"]!;
            Assert.AreEqual("shared", idleChat["control"]!.GetValue<string>(), "An empty shared chat has no rollout yet but must remain controllable.");
            var resumedEmpty = (await remote.HandleAsync(Request("thread/resume", new() { ["threadId"] = "native-chat" }), token))!["result"]!["thread"]!;
            Assert.AreEqual("shared", resumedEmpty["control"]!.GetValue<string>(), "Sending the first web message must be able to join the empty native chat.");
            await desktop.CallAsync("turn/start", new() { ["threadId"] = "native-chat", ["input"] = Input("桌面任务") }, token);
            server.NoRolloutUntilStart = true;
            await Assert.ThrowsAsync<IOException>(() => remote.HandleAsync(Request("thread/read", new() { ["threadId"] = "native-chat", ["includeTurns"] = true }), token));
            server.NoRolloutUntilStart = false;
            var read = (await remote.HandleAsync(Request("thread/read", new() { ["threadId"] = "native-chat", ["includeTurns"] = true }), token))!["result"]!["thread"]!;
            Assert.AreEqual("shared", read["control"]!.GetValue<string>());
            Assert.AreEqual("inProgress", read["turns"]![0]!["status"]!.GetValue<string>());
            var steer = await remote.HandleAsync(Request("turn/steer", new() { ["threadId"] = "native-chat", ["expectedTurnId"] = "same-turn", ["input"] = Input("网页引导") }), token);
            Assert.AreEqual("same-turn", steer!["result"]!["turnId"]!.GetValue<string>());
            await remote.HandleAsync(Request("thread/queue/add", new() { ["threadId"] = "native-chat", ["clientUserMessageId"] = "one", ["input"] = Input("网页队列") }), token);
            Assert.AreEqual(1, (await desktop.CallAsync("thread/queue/list", new() { ["threadId"] = "native-chat" }, token))["result"]!["data"]!.AsArray().Count);
            var approved = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            remote.Message += item => { if (item["method"]?.GetValue<string>() == "item/commandExecution/requestApproval") approved.TrySetResult(item); };
            await server.Broadcast(new() { ["id"] = 7, ["method"] = "item/commandExecution/requestApproval", ["params"] = new JsonObject { ["threadId"] = "native-chat", ["turnId"] = "same-turn", ["command"] = "fixture" } });
            var approval = await approved.Task.WaitAsync(token);
            await remote.HandleAsync(new() { ["id"] = approval["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "accept" } }, token);
            await Task.Delay(50, token);
            Assert.AreEqual(0, desktop.PendingApprovals.Count);
            await Assert.ThrowsAsync<InvalidDataException>(() => remote.HandleAsync(new() { ["id"] = approval["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "accept" } }, token));
            await Assert.ThrowsAsync<InvalidDataException>(() => remote.HandleAsync(Request("thread/queue/list", new() { ["threadId"] = "outside" }), token));
            await remote.DisposeAsync();
            Assert.IsTrue(desktop.Running); Assert.IsTrue(server.Active);
            await using var reconnected = new RemoteRuntime(() => new(true, [root], AutoDiscover:false, SharedControl:true), t => RuntimeClient.ConnectAsync(server.Endpoint, server.Bearer, t));
            await reconnected.OpenAsync(token); await reconnected.HandleAsync(Request("thread/read", new() { ["threadId"] = "native-chat", ["includeTurns"] = true }), token);
            var status = (await reconnected.HandleAsync(Request("lanpower/status"), token))!["result"]!;
            Assert.AreEqual("same-turn", status["activeTurns"]![0]!["turnId"]!.GetValue<string>());
            await desktop.CallAsync("turn/interrupt", new() { ["threadId"] = "native-chat", ["turnId"] = "same-turn" }, token);
            await Task.Delay(50, token);
            status = (await reconnected.HandleAsync(Request("lanpower/status"), token))!["result"]!;
            Assert.AreEqual(0, status["activeTurns"]!.AsArray().Count);
            Assert.IsTrue(server.ResumeParameters.All(p => p.Count == 2 && p["excludeTurns"]!.GetValue<bool>()), "Joining a native task must preserve its permissions.");
        }
        finally { Directory.Delete(root, true); }
    }

    [TestMethod]
    public async Task RestartedTransportRecoversNativeStateWithoutReplayingTaskOrQueue()
    {
        var root = Path.Combine(Path.GetTempPath(), "LanPowerRecoveryTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            await using var server = new SharedFixture(root);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var token = deadline.Token;
            var config = new CodexHostSettings(true, [root], AutoDiscover: false, SharedControl: true);
            await using var remote = new RemoteRuntime(() => config, t => RuntimeClient.ConnectAsync(server.Endpoint, server.Bearer, t));
            await remote.OpenAsync(token);
            await remote.HandleAsync(Request("thread/read", new() { ["threadId"] = "native-chat", ["includeTurns"] = true }), token);
            await remote.HandleAsync(Request("turn/start", new() { ["threadId"] = "native-chat", ["input"] = Input("existing task") }), token);
            await remote.HandleAsync(Request("thread/queue/add", new() { ["threadId"] = "native-chat", ["clientUserMessageId"] = "one", ["input"] = Input("existing queue") }), token);
            var mutations = server.Mutations;
            server.Disconnect();
            while (remote.Running) await Task.Delay(20, token);
            Assert.IsTrue(await remote.ReconnectAsync(token));
            var restored = (await remote.HandleAsync(Request("thread/read", new() { ["threadId"] = "native-chat", ["includeTurns"] = true }), token))!["result"]!["thread"]!;
            Assert.AreEqual("inProgress", restored["turns"]![0]!["status"]!.GetValue<string>());
            var queue = (await remote.HandleAsync(Request("thread/queue/list", new() { ["threadId"] = "native-chat" }), token))!["result"]!["data"]!.AsArray();
            Assert.AreEqual(1, queue.Count);
            Assert.AreEqual(mutations, server.Mutations, "Recovery must only read the existing native state.");
            Assert.IsFalse(await remote.ReconnectAsync(token), "An already-connected runtime must not create duplicate listeners.");
            server.Disconnect();
            while (remote.Running) await Task.Delay(20, token);
            config = config with { Enabled = false };
            Assert.IsFalse(await remote.ReconnectAsync(token));
        }
        finally { Directory.Delete(root, true); }
    }

    private sealed class SharedFixture : IAsyncDisposable
    {
        private readonly HttpListener _listener = new(); private readonly CancellationTokenSource _stop = new();
        private readonly ConcurrentBag<(WebSocket Socket, SemaphoreSlim Write)> _peers = new(); private readonly Task _accept;
        private readonly string _root; private readonly JsonArray _queue = new();
        public Uri Endpoint { get; }
        public string Bearer { get; } = new('a', 64);
        public bool Active { get; private set; }
        public int Mutations { get; private set; }
        public void Disconnect() { foreach (var peer in _peers) peer.Socket.Abort(); }
        public bool HideHistory { get; set; }
        public bool NoRolloutUntilStart { get; set; }
        public string MissingHistory { get; set; } = "no rollout found for thread id native-chat";
        public ConcurrentBag<JsonObject> ResumeParameters { get; } = new();
        public SharedFixture(string root)
        {
            _root = root; var reserve = new TcpListener(IPAddress.Loopback, 0); reserve.Start(); var port = ((IPEndPoint)reserve.LocalEndpoint).Port; reserve.Stop();
            Endpoint = new("ws://127.0.0.1:" + port + "/"); _listener.Prefixes.Add("http://127.0.0.1:" + port + "/"); _listener.Start(); _accept = Accept();
        }
        private async Task Accept()
        {
            try { while (!_stop.IsCancellationRequested) { var context = await _listener.GetContextAsync();
                if (context.Request.Headers["Authorization"] != "Bearer " + Bearer) { context.Response.StatusCode = 401; context.Response.Close(); continue; }
                var socket = (await context.AcceptWebSocketAsync(null)).WebSocket; var peer = (socket, new SemaphoreSlim(1)); _peers.Add(peer); _ = Read(peer); } }
            catch (Exception e) when (e is HttpListenerException or ObjectDisposedException) { }
        }
        private async Task Send((WebSocket Socket, SemaphoreSlim Write) peer, JsonObject item)
        { await peer.Write.WaitAsync(_stop.Token); try { var bytes = Encoding.UTF8.GetBytes(item.ToJsonString()); var middle = bytes.Length / 2;
            await peer.Socket.SendAsync(bytes.AsMemory(0, middle), WebSocketMessageType.Text, false, _stop.Token);
            await peer.Socket.SendAsync(bytes.AsMemory(middle), WebSocketMessageType.Text, true, _stop.Token); } finally { peer.Write.Release(); } }
        public async Task Broadcast(JsonObject item)
        { foreach (var peer in _peers.Where(p => p.Socket.State == WebSocketState.Open)) try { await Send(peer, item); } catch (WebSocketException) { } }
        private JsonObject Thread(bool outside = false) => new() { ["id"] = outside ? "outside" : "native-chat", ["cwd"] = outside ? Path.GetTempPath() : _root,
            ["status"] = new JsonObject { ["type"] = Active ? "active" : "idle" }, ["turns"] = new JsonArray(new JsonObject { ["id"] = "same-turn", ["status"] = Active ? "inProgress" : "interrupted", ["items"] = new JsonArray() }) };
        private async Task Read((WebSocket Socket, SemaphoreSlim Write) peer)
        {
            try { var buffer = new byte[65536]; while (!_stop.IsCancellationRequested) {
                using var data = new MemoryStream(); WebSocketReceiveResult frame;
                do { frame = await peer.Socket.ReceiveAsync(buffer, _stop.Token); if (frame.MessageType == WebSocketMessageType.Close) return; data.Write(buffer, 0, frame.Count); } while (!frame.EndOfMessage);
                var request = JsonNode.Parse(data.ToArray())!.AsObject(); var method = request["method"]?.GetValue<string>(); var p = request["params"]?.AsObject() ?? new(); var result = new JsonObject();
                if (method is "turn/start" or "turn/steer" or "turn/interrupt" or "thread/queue/add") Mutations++;
                if (method is null) { await Broadcast(new() { ["method"] = "serverRequest/resolved", ["params"] = new JsonObject { ["requestId"] = request["id"]!.DeepClone() } }); continue; }
                if (!request.ContainsKey("id")) continue;
                if (method == "account/read") result["account"] = new JsonObject { ["type"] = "fixture" };
                if (method == "thread/list") result["data"] = HideHistory ? new JsonArray() : new JsonArray(Thread());
                if (method == "thread/loaded/list") result["data"] = new JsonArray("native-chat");
                if (method == "thread/resume" && NoRolloutUntilStart)
                {
                    await Send(peer, new() { ["id"] = request["id"]!.DeepClone(), ["error"] = new JsonObject { ["code"] = -32600, ["message"] = MissingHistory } });
                    continue;
                }
                if (method is "thread/read" or "thread/resume") { if (method == "thread/resume") ResumeParameters.Add((JsonObject)p.DeepClone()); result["thread"] = Thread(p["threadId"]?.GetValue<string>() == "outside"); }
                if (method == "thread/turns/list") result["data"] = Thread()["turns"]!.DeepClone();
                if (method == "turn/start") { Active = true; NoRolloutUntilStart = false; result["turn"] = new JsonObject { ["id"] = "same-turn", ["status"] = "inProgress" }; }
                if (method == "turn/steer") result["turnId"] = "same-turn";
                if (method == "thread/queue/add") { var entry = new JsonObject { ["id"] = "queued-one", ["clientUserMessageId"] = p["clientUserMessageId"]!.DeepClone(), ["input"] = p["input"]!.DeepClone() }; _queue.Add(entry); result["queuedSubmission"] = entry.DeepClone(); }
                if (method == "thread/queue/list") result["data"] = _queue.DeepClone();
                if (method == "turn/interrupt") Active = false;
                await Send(peer, new() { ["id"] = request["id"]!.DeepClone(), ["result"] = result });
                if (method is "turn/start" or "turn/interrupt") await Broadcast(new() { ["method"] = method == "turn/start" ? "turn/started" : "turn/completed", ["params"] = new JsonObject { ["threadId"] = "native-chat", ["turn"] = new JsonObject { ["id"] = "same-turn", ["status"] = Active ? "inProgress" : "interrupted" } } });
                if (method == "thread/queue/add") await Broadcast(new() { ["method"] = "thread/queue/changed", ["params"] = new JsonObject { ["threadId"] = "native-chat" } });
            } } catch (Exception e) when (e is WebSocketException or OperationCanceledException or ObjectDisposedException) { }
        }
        public async ValueTask DisposeAsync() { _stop.Cancel(); _listener.Close(); foreach (var peer in _peers) { peer.Socket.Abort(); peer.Socket.Dispose(); } await _accept; _stop.Dispose(); }
    }
}
