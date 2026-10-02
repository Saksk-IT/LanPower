using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Threading.Channels;
using LanPower.Service;
using LanPower.CodexHost;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class CodexRemoteTests
{
    private static JsonObject Request(string method, JsonObject? parameters = null) => new() {
        ["id"] = Guid.NewGuid().ToString("N"), ["method"] = method, ["params"] = parameters ?? new() };
    private static string FakeExecutable()
    {
        var windows = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        return Path.Combine(windows, "LanPower.FakeCodex", "bin", "Release", "net10.0-windows", "LanPower.FakeCodex.exe");
    }

    [TestMethod]
    public void ProtocolRejectsEscapeMethodsOverridesDuplicateKeysAndOversize()
    {
        foreach (var method in new[] { "command/exec", "config/write", "account/login/start", "account/logout", "fs/writeFile", "plugin/install" })
            Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request(method)));
        Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request("thread/start", new() { ["approvalPolicy"] = "never" })));
        Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.Parse("{\"type\":\"rpc\",\"type\":\"ping\"}"));
        Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.Parse(new string('a', CodexRemoteProtocol.MaxFrame + 1)));
        Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.Id(CodexRemoteProtocol.Parse("{\"id\":true}")));
    }

    [TestMethod]
    public async Task WorkspaceScopeDefaultsOffRejectsOtherRootsAndOverrides()
    {
        var path = Path.Combine(Path.GetTempPath(), "LanPowerRemoteTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        try
        {
            var config = new CodexHostSettings(false, [path], FakeExecutable(), AutoDiscover: false);
            Assert.IsFalse(config.Allows(path));
            await using var runtime = new RemoteRuntime(() => config);
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.OpenAsync(CancellationToken.None));
            config = config with { Enabled = true };
            Assert.IsTrue(config.Allows(path)); Assert.IsFalse(config.Allows(Path.GetTempPath()));
            Assert.IsFalse(config.Allows("..")); Assert.IsFalse(config.Allows(@"\\server\share"));
            var corrupt = Path.Combine(path, "corrupt.json");
            File.WriteAllText(corrupt, "{\"Enabled\":true,\"Workspaces\":null}");
            Assert.Throws<InvalidDataException>(() => CodexHostSettings.Load(corrupt));
            await runtime.OpenAsync(CancellationToken.None);
            var list = await runtime.HandleAsync(Request("thread/list", new() { ["cwd"] = path }), CancellationToken.None);
            Assert.AreEqual(1, list!["result"]!["data"]!.AsArray().Count);
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(Request("thread/resume",
                new() { ["threadId"] = "outside-test" }), CancellationToken.None));
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(Request("thread/start",
                new() { ["cwd"] = path, ["sandbox"] = "danger-full-access" }), CancellationToken.None));
        }
        finally { Directory.Delete(path, true); }
    }

    [TestMethod]
    public async Task RuntimeStreamsApprovalDiffInterruptAndHandlesExit()
    {
        var path = Path.Combine(Path.GetTempPath(), "LanPowerRemoteTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        try
        {
            var config = new CodexHostSettings(true, [path], FakeExecutable(), AutoDiscover: false);
            await using var runtime = new RemoteRuntime(() => config);
            await runtime.OpenAsync(CancellationToken.None);
            var approval = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            var completed = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            var resolved = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            runtime.Message += message => {
                if (message["method"]?.GetValue<string>() is "item/commandExecution/requestApproval" or "item/fileChange/requestApproval") approval.TrySetResult(message);
                if (message["method"]?.GetValue<string>() == "turn/completed") completed.TrySetResult(message);
                if (message["method"]?.GetValue<string>() == "serverRequest/resolved") resolved.TrySetResult(message);
            };
            var thread = await runtime.HandleAsync(Request("thread/start", new() { ["cwd"] = path }), CancellationToken.None);
            var id = thread!["result"]!["thread"]!["id"]!.GetValue<string>();
            var task = Request("turn/start", new() { ["threadId"] = id, ["input"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "中文任务：检查文件" }) });
            await runtime.HandleAsync(task, CancellationToken.None);
            var pending = await approval.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var steer = Request("turn/steer", new() { ["threadId"] = id, ["expectedTurnId"] = "turn-test",
                ["input"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "只处理当前文件" }) });
            var steered = await runtime.HandleAsync(steer, CancellationToken.None);
            Assert.AreEqual("turn-test", steered!["result"]!["turnId"]!.GetValue<string>());
            steer["params"]!["expectedTurnId"] = "stale-turn";
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(steer, CancellationToken.None));
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(new JsonObject { ["id"] = pending["id"]!.DeepClone(),
                ["result"] = new JsonObject { ["decision"] = "acceptForSession" } }, CancellationToken.None));
            await runtime.HandleAsync(new JsonObject { ["id"] = pending["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "accept" } }, CancellationToken.None);
            Assert.AreEqual(pending["id"]!.ToJsonString(), (await resolved.Task.WaitAsync(TimeSpan.FromSeconds(5)))["params"]!["requestId"]!.ToJsonString());
            Assert.AreEqual("completed", (await completed.Task.WaitAsync(TimeSpan.FromSeconds(5)))["params"]!["turn"]!["status"]!.GetValue<string>());
            var status = await runtime.HandleAsync(Request("lanpower/status"), CancellationToken.None);
            Assert.Contains("+fixture change", status!["result"]!["diff"]!.GetValue<string>());
            Assert.AreEqual(0, status["result"]!["pendingApprovals"]!.AsArray().Count);
            approval = new(TaskCreationOptions.RunContinuationsAsynchronously); completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
            task["params"]!["model"] = "fixture-item-diff";
            await runtime.HandleAsync(task, CancellationToken.None);
            pending = await approval.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await runtime.HandleAsync(new JsonObject { ["id"] = pending["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "accept" } }, CancellationToken.None);
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            status = await runtime.HandleAsync(Request("lanpower/status"), CancellationToken.None);
            Assert.Contains("+fixture item diff", status!["result"]!["diff"]!.GetValue<string>());
            approval = new(TaskCreationOptions.RunContinuationsAsynchronously); completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
            await runtime.HandleAsync(task, CancellationToken.None);
            await approval.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await runtime.HandleAsync(Request("turn/interrupt", new() { ["threadId"] = id, ["turnId"] = "turn-test" }), CancellationToken.None);
            Assert.AreEqual("interrupted", (await completed.Task.WaitAsync(TimeSpan.FromSeconds(5)))["params"]!["turn"]!["status"]!.GetValue<string>());
            approval = new(TaskCreationOptions.RunContinuationsAsynchronously); completed = new(TaskCreationOptions.RunContinuationsAsynchronously);
            task["params"]!["model"] = "fixture-outside-file";
            await runtime.HandleAsync(task, CancellationToken.None);
            pending = await approval.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(new JsonObject { ["id"] = pending["id"]!.DeepClone(),
                ["result"] = new JsonObject { ["decision"] = "accept" } }, CancellationToken.None));
            await runtime.HandleAsync(new JsonObject { ["id"] = pending["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "decline" } }, CancellationToken.None);
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await Assert.ThrowsAsync<IOException>(() => runtime.HandleAsync(Request("thread/start", new() { ["cwd"] = path, ["model"] = "fixture-exit" }), CancellationToken.None));
        }
        finally { Directory.Delete(path, true); }
    }

    [TestMethod]
    public async Task AutoDiscoveryReadsNativeProjectsAndListsWithoutChoosingDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "LanPowerRemoteTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(path, "second-project"));
        try
        {
            var config = new CodexHostSettings(true, [path], FakeExecutable());
            await using var runtime = new RemoteRuntime(() => config);
            await runtime.OpenAsync(CancellationToken.None);
            var status = await runtime.HandleAsync(Request("lanpower/status"), CancellationToken.None);
            Assert.IsTrue(status!["result"]!["projects"]!.AsArray().Any(project =>
                project?["path"]?.GetValue<string>() == Path.Combine(path, "second-project")));
            var list = await runtime.HandleAsync(Request("thread/list"), CancellationToken.None);
            Assert.AreEqual("thread-test", list!["result"]!["data"]![0]!["id"]!.GetValue<string>());
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(Request("thread/start",
                new() { ["cwd"] = Path.GetTempPath() }), CancellationToken.None));
            var read = await runtime.HandleAsync(Request("thread/read", new() {
                ["threadId"] = "thread-test", ["includeTurns"] = true }), CancellationToken.None);
            Assert.AreEqual("available", read!["result"]!["thread"]!["control"]!.GetValue<string>());
        }
        finally { Directory.Delete(path, true); }
    }

    [TestMethod]
    public async Task SessionHandoffKeepsAnotherTaskAndItsApprovalAlive()
    {
        var path = Path.Combine(Path.GetTempPath(), "LanPowerRemoteTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        try
        {
            await using var runtime = new RemoteRuntime(() => new(true, [path], FakeExecutable(), AutoDiscover: false));
            await runtime.OpenAsync(CancellationToken.None);
            var approvals = Channel.CreateUnbounded<JsonObject>();
            var completed = Channel.CreateUnbounded<JsonObject>();
            runtime.Message += message => {
                if (message["method"]?.GetValue<string>() == "item/commandExecution/requestApproval") approvals.Writer.TryWrite(message);
                if (message["method"]?.GetValue<string>() == "turn/completed") completed.Writer.TryWrite(message);
            };
            await runtime.HandleAsync(Request("thread/start", new() { ["cwd"] = path }), CancellationToken.None);
            await runtime.HandleAsync(Request("thread/start", new() { ["cwd"] = path, ["model"] = "fixture-second" }), CancellationToken.None);
            foreach (var id in new[] { "thread-test", "thread-second" })
                await runtime.HandleAsync(Request("turn/start", new() { ["threadId"] = id,
                    ["input"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "隔离验证" }) }), CancellationToken.None);
            var first = await approvals.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            var second = await approvals.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.IsFalse(await runtime.CanSwitchModeAsync(CancellationToken.None));
            Assert.AreNotEqual(CodexRemoteProtocol.Id(first), CodexRemoteProtocol.Id(second), "Native request 7 in two workers must remain distinct.");
            var release = Request("lanpower/session/release", new() { ["threadId"] = "thread-test" });
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(release, CancellationToken.None));
            await runtime.HandleAsync(Request("turn/interrupt", new() { ["threadId"] = "thread-test", ["turnId"] = "turn-test" }), CancellationToken.None);
            await completed.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            var released = await runtime.HandleAsync(release, CancellationToken.None);
            Assert.IsTrue(released!["result"]!["released"]!.GetValue<bool>());
            var status = (await runtime.HandleAsync(Request("lanpower/status"), CancellationToken.None))!["result"]!;
            Assert.AreEqual(1, status["activeTurns"]!.AsArray().Count);
            Assert.AreEqual("thread-second", status["activeTurns"]![0]!["threadId"]!.GetValue<string>());
            Assert.AreEqual(1, status["pendingApprovals"]!.AsArray().Count);
            var remaining = status["pendingApprovals"]![0]!.AsObject();
            await runtime.HandleAsync(new JsonObject { ["id"] = remaining["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "decline" } }, CancellationToken.None);
            await completed.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.AreEqual("available", (await runtime.HandleAsync(Request("thread/read", new() { ["threadId"] = "thread-test" }), CancellationToken.None))!["result"]!["thread"]!["control"]!.GetValue<string>());
            Assert.IsTrue(await runtime.CanSwitchModeAsync(CancellationToken.None));
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(Request("lanpower/session/release", new() { ["threadId"] = "outside-test" }), CancellationToken.None));
        }
        finally { Directory.Delete(path, true); }
    }

    [TestMethod]
    public async Task CompletedChatAutomaticallyReleasesAndCanResumeAgain()
    {
        var path = Path.Combine(Path.GetTempPath(), "LanPowerRemoteTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        try
        {
            await using var runtime = new RemoteRuntime(() => new(true, [path], FakeExecutable(), AutoDiscover: false));
            await runtime.OpenAsync(CancellationToken.None);
            var approvals = Channel.CreateUnbounded<JsonObject>(); var completed = Channel.CreateUnbounded<JsonObject>();
            runtime.Message += message => {
                if (message["method"]?.GetValue<string>() == "item/commandExecution/requestApproval") approvals.Writer.TryWrite(message);
                if (message["method"]?.GetValue<string>() == "turn/completed") completed.Writer.TryWrite(message);
            };
            await runtime.HandleAsync(Request("thread/resume", new() { ["threadId"] = "thread-test" }), CancellationToken.None);
            var start = Request("turn/start", new() { ["threadId"] = "thread-test",
                ["input"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "完成验证" }) });
            await runtime.HandleAsync(start, CancellationToken.None);
            var pending = await approvals.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            var decision = new JsonObject { ["id"] = pending["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "accept" } };
            await runtime.HandleAsync(decision, CancellationToken.None);
            await completed.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            await Task.Delay(2100); await runtime.ExpireAsync(CancellationToken.None);
            var status = (await runtime.HandleAsync(Request("lanpower/status"), CancellationToken.None))!["result"]!;
            Assert.AreEqual(0, status["activeTurns"]!.AsArray().Count);
            Assert.Contains("fixture change", status["diff"]!.GetValue<string>());
            Assert.AreEqual("available", (await runtime.HandleAsync(Request("thread/read", new() { ["threadId"] = "thread-test" }), CancellationToken.None))!["result"]!["thread"]!["control"]!.GetValue<string>());
            await runtime.HandleAsync(start, CancellationToken.None);
            var next = await approvals.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.AreNotEqual(CodexRemoteProtocol.Id(pending), CodexRemoteProtocol.Id(next));
            await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(decision, CancellationToken.None));
            await runtime.HandleAsync(Request("turn/interrupt", new() { ["threadId"] = "thread-test", ["turnId"] = "turn-test" }), CancellationToken.None);
            await completed.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally { Directory.Delete(path, true); }
    }

    [TestMethod]
    public async Task HandoffPreservesBackgroundCommandsAfterTheTurnCompletes()
    {
        var path = Path.Combine(Path.GetTempPath(), "LanPowerRemoteTests", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(path);
        try
        {
            await using var runtime = new RemoteRuntime(() => new(true, [path], FakeExecutable(), AutoDiscover: false));
            await runtime.OpenAsync(CancellationToken.None);
            var approvals = Channel.CreateUnbounded<JsonObject>(); var completed = Channel.CreateUnbounded<JsonObject>();
            runtime.Message += message => {
                if (message["method"]?.GetValue<string>() == "item/commandExecution/requestApproval") approvals.Writer.TryWrite(message);
                if (message["method"]?.GetValue<string>() == "turn/completed") completed.Writer.TryWrite(message);
            };
            await runtime.HandleAsync(Request("thread/start", new() { ["cwd"] = path }), CancellationToken.None);
            await runtime.HandleAsync(Request("turn/start", new() { ["threadId"] = "thread-test", ["model"] = "fixture-background",
                ["input"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "后台验证" }) }), CancellationToken.None);
            var pending = await approvals.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            await runtime.HandleAsync(new JsonObject { ["id"] = pending["id"]!.DeepClone(), ["result"] = new JsonObject { ["decision"] = "accept" } }, CancellationToken.None);
            await completed.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            var failure = await Assert.ThrowsAsync<InvalidDataException>(() => runtime.HandleAsync(Request("lanpower/session/release", new() { ["threadId"] = "thread-test" }), CancellationToken.None));
            Assert.AreEqual("background_running", failure.Message);
            Assert.IsFalse(await runtime.CanSwitchModeAsync(CancellationToken.None), "Switching modes must preserve background commands after a turn completes.");
            await Task.Delay(2100); await runtime.ExpireAsync(CancellationToken.None);
            Assert.AreEqual("remote", (await runtime.HandleAsync(Request("thread/read", new() { ["threadId"] = "thread-test" }), CancellationToken.None))!["result"]!["thread"]!["control"]!.GetValue<string>());
        }
        finally { Directory.Delete(path, true); }
    }

    [TestMethod]
    [DoNotParallelize]
    public void DesktopOwnershipUsesLiveLockRatherThanStaleFile()
    {
        var path = Path.Combine(Path.GetTempPath(), "LanPowerRemoteTests", Guid.NewGuid().ToString("N"));
        var previous = Environment.GetEnvironmentVariable("CODEX_HOME");
        Directory.CreateDirectory(Path.Combine(path, "thread-writer-locks"));
        var id = Guid.NewGuid().ToString("D");
        try
        {
            Environment.SetEnvironmentVariable("CODEX_HOME", path);
            var file = Path.Combine(path, "thread-writer-locks", id + ".lock");
            File.WriteAllText(file, "");
            Assert.IsFalse(CodexProjects.DesktopOwns(id));
            using (var owner = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete))
            { owner.Lock(0, 1); Assert.IsTrue(CodexProjects.DesktopOwns(id)); owner.Unlock(0, 1); }
            Assert.IsFalse(CodexProjects.DesktopOwns(id));
            Assert.IsFalse(CodexProjects.DesktopOwns("../../outside"));
        }
        finally { Environment.SetEnvironmentVariable("CODEX_HOME", previous); Directory.Delete(path, true); }
    }

    [TestMethod]
    public async Task ServiceBridgeAndUserHostPipeRoundtrip()
    {
        var path = Path.Combine(Path.GetTempPath(), "LanPowerRemoteTests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        var settingsFile = Path.Combine(path, "host-settings.json");
        new CodexHostSettings(true, [path], FakeExecutable()).Save(settingsFile);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var bridge = new CodexHostBridge(true);
        var messages = Channel.CreateUnbounded<JsonObject>();
        bridge.Message += raw => messages.Writer.TryWrite(CodexRemoteProtocol.Parse(raw));
        Process? host = null;
        async Task<JsonObject> Until(Func<JsonObject, bool> matches)
        {
            while (true) { var item = await messages.Reader.ReadAsync(timeout.Token); if (matches(item)) return item; }
        }
        try
        {
            await bridge.StartAsync(timeout.Token);
            var windows = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
            host = Process.Start(new ProcessStartInfo(Path.Combine(windows, "LanPower.CodexHost", "bin", "Release", "net10.0-windows", "LanPower.CodexHost.exe")) {
                UseShellExecute = false, CreateNoWindow = true,
                ArgumentList = { "--pipe", $"{CodexRemoteProtocol.PipeName}.DryRun.{Environment.ProcessId}", "--settings", settingsFile } });
            await Until(frame => frame["type"]?.GetValue<string>() == "hello");
            var session = Guid.NewGuid().ToString("D");
            await bridge.ForwardAsync(new() { ["type"] = "open", ["session"] = session }, timeout.Token);
            await Until(frame => frame["state"]?.GetValue<string>() == "runtime_ready");
            var rejected = Request("thread/start", new() { ["cwd"] = Path.GetTempPath() });
            await bridge.ForwardAsync(new() { ["type"] = "rpc", ["session"] = session, ["payload"] = rejected }, timeout.Token);
            var failure = await Until(frame => frame["payload"]?["id"]?.GetValue<string>() == rejected["id"]!.GetValue<string>());
            Assert.AreEqual("workspace_not_allowed", failure["payload"]!["error"]!["message"]!.GetValue<string>());
            Assert.IsFalse(host!.HasExited, "A rejected operation must not stop the user Host.");
            await bridge.ForwardAsync(new() { ["type"] = "rpc", ["session"] = session, ["payload"] = Request("model/list") }, timeout.Token);
            var response = await Until(frame => frame["payload"]?["result"]?["data"] is JsonArray);
            Assert.AreEqual("fixture", response["payload"]!["result"]!["data"]![0]!["model"]!.GetValue<string>());
            Assert.AreEqual("runtime_ready", bridge.State);
            new CodexHostSettings(false, [path], FakeExecutable()).Save(settingsFile);
            await Until(frame => frame["state"]?.GetValue<string>() == "disabled");
        }
        finally
        {
            if (host is not null) { if (!host.HasExited) host.Kill(true); host.WaitForExit(); host.Dispose(); }
            await bridge.StopAsync(CancellationToken.None);
            Directory.Delete(path, true);
        }
    }
}
