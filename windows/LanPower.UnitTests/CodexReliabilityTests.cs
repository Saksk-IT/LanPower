using System.Text.Json.Nodes;
using LanPower.CodexHost;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class CodexReliabilityTests
{
    [TestMethod]
    public async Task RepeatedNativeApprovalKeepsOneRelayIdentity()
    {
        var root = Path.Combine(Path.GetTempPath(),"LanPowerApprovalIdentity",Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var windows = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,"..","..","..",".."));
            var executable = Path.Combine(windows,"LanPower.FakeCodex","bin","Release","net10.0-windows","LanPower.FakeCodex.exe");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using var client = new RuntimeClient(executable,root); await client.InitializeAsync(timeout.Token);
            var observed = new List<string>(); var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            client.Message += message => { if (message["method"]?.GetValue<string>() == "item/commandExecution/requestApproval") { observed.Add(CodexRemoteProtocol.Id(message)); if (observed.Count == 2) finished.TrySetResult(); } };
            await client.CallAsync("turn/start",new() { ["threadId"] = "thread", ["model"] = "fixture-duplicate-approval" },timeout.Token);
            await finished.Task.WaitAsync(timeout.Token);
            Assert.HasCount(1,client.PendingApprovals); Assert.AreEqual(observed[0],observed[1]);
            var id = client.PendingApprovals[0]!["id"]!.DeepClone();
            await client.DecideAsync(new() { ["id"] = id, ["result"] = new JsonObject { ["decision"] = "decline" } },timeout.Token);
            Assert.HasCount(0,client.PendingApprovals);
        }
        finally { Directory.Delete(root,true); }
    }
    [TestMethod]
    public async Task ReceiptsSurviveRestartAndNeverDispatchTheSameSubmissionTwice()
    {
        var root = Path.Combine(Path.GetTempPath(), "LanPowerReceipts", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var path = Path.Combine(root,"receipts.json"); var store = new RemoteSubmissionStore(path);
            var p = new JsonObject { ["threadId"] = "thread", ["input"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = "PRIVATE-BODY" }) };
            Assert.IsTrue(await store.BeginAsync("thread","submission","turn/start",p,CancellationToken.None));
            Assert.IsFalse(await store.BeginAsync("thread","submission","turn/start",p,CancellationToken.None));
            Assert.AreEqual("uncertain",new RemoteSubmissionStore(path).Read("thread","submission")["state"]!.GetValue<string>());
            var receipt = await store.FinishAsync("thread","submission",new() { ["result"] = new JsonObject { ["turn"] = new JsonObject { ["id"] = "native-turn" } } },CancellationToken.None);
            Assert.AreEqual("accepted",receipt["state"]!.GetValue<string>());
            var restored = new RemoteSubmissionStore(path);
            Assert.AreEqual("native-turn",restored.Read("thread","submission")["turnId"]!.GetValue<string>());
            Assert.IsFalse(await restored.BeginAsync("thread","submission","turn/start",p,CancellationToken.None));
            Assert.Throws<InvalidDataException>(() => restored.Read("other","submission"));
            Assert.DoesNotContain("PRIVATE-BODY",File.ReadAllText(path));
            p["input"]![0]!["text"] = "changed";
            await Assert.ThrowsAsync<InvalidDataException>(() => restored.BeginAsync("thread","submission","turn/start",p,CancellationToken.None));
        }
        finally { Directory.Delete(root,true); }
    }

    [TestMethod]
    public void SingleItemBeyondRelayLimitHasCompleteUnicodeReadAndThreadIsolation()
    {
        var text = "开始🎨" + new string('x',17 * 1024 * 1024) + "结尾";
        var item = new JsonObject { ["id"] = "large", ["type"] = "agentMessage", ["text"] = text };
        var turns = new JsonArray(new JsonObject { ["id"] = "turn", ["items"] = new JsonArray(item.DeepClone()) });
        var store = new RemoteHistoryStore(); var page = store.Pack("thread",turns); var descriptor = page[0]!["items"]![0]!;
        Assert.AreEqual("lanpowerLargeItem",descriptor["type"]!.GetValue<string>());
        Assert.IsLessThan(1024,page.ToJsonString().Length);
        var reference = descriptor["reference"]!.GetValue<string>();
        Assert.Throws<InvalidDataException>(() => store.Read("other",reference,0));
        var parts = new System.Text.StringBuilder(); var offset = 0;
        do { var part = store.Read("thread",reference,offset); parts.Append(part["data"]!.GetValue<string>()); if (part["nextOffset"] is null) break; offset = part["nextOffset"]!.GetValue<int>(); } while (true);
        Assert.AreEqual(text,JsonNode.Parse(parts.ToString())!["text"]!.GetValue<string>());
        Assert.AreEqual(reference,store.Pack("thread",turns)[0]!["items"]![0]!["reference"]!.GetValue<string>());
    }

    [TestMethod]
    public void LargeImagesKeepSmallRepliesVisibleAndStableAcrossRefresh()
    {
        var items = new JsonArray();
        for (var i = 0; i < 3; i++) items.Add(new JsonObject { ["id"] = "image-" + i, ["type"] = "imageGeneration", ["result"] = new string('x',1500000) });
        items.Add(new JsonObject { ["id"] = "final", ["type"] = "agentMessage", ["text"] = "我建议采用 A 的主界面" });
        var turns = new JsonArray(new JsonObject { ["id"] = "design", ["items"] = items });
        var store = new RemoteHistoryStore(); var first = store.Pack("thread",turns); var next = store.Pack("thread",turns);
        Assert.AreEqual(4,first[0]!["items"]!.AsArray().Count);
        Assert.AreEqual("我建议采用 A 的主界面",first[0]!["items"]![3]!["text"]!.GetValue<string>());
        for (var i = 0; i < 3; i++)
        {
            Assert.IsFalse(first[0]!["items"]![i]!["wholeTurn"]!.GetValue<bool>());
            Assert.AreEqual(first[0]!["items"]![i]!["reference"]!.GetValue<string>(),next[0]!["items"]![i]!["reference"]!.GetValue<string>());
        }
    }

    [TestMethod]
    public void NewRpcFieldsRemainStrictlyBounded()
    {
        JsonObject Request(string method,JsonObject p) => new() { ["id"] = "rpc", ["method"] = method, ["params"] = p };
        Assert.AreEqual("lanpower/submission/read",CodexRemoteProtocol.ValidateRequest(Request("lanpower/submission/read",new() { ["threadId"] = "thread", ["submissionId"] = "submission" })));
        Assert.AreEqual("lanpower/history/item/read",CodexRemoteProtocol.ValidateRequest(Request("lanpower/history/item/read",new() { ["threadId"] = "thread", ["reference"] = "ref", ["offset"] = 65536 })));
        foreach (var offset in new[] {-1,64 * 1024 * 1024 + 1}) Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request("lanpower/history/item/read",new() { ["threadId"] = "thread", ["reference"] = "ref", ["offset"] = offset })));
        Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request("thread/read",new() { ["threadId"] = "thread", ["historyLimit"] = 9 })));
    }
}
