using System.Text.Json.Nodes;
using LanPower.CodexHost;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class DesktopCdpTests
{
    [TestMethod]
    public void DesktopEndpointMustBeOriginalLoopbackPage()
    {
        JsonArray Targets(string url, string page = "app://-/index.html") => new(new JsonObject { ["type"] = "page", ["url"] = page, ["webSocketDebuggerUrl"] = url });
        Assert.AreEqual("127.0.0.1", DesktopCdp.ValidateTarget(9222, Targets("ws://127.0.0.1:9222/devtools/page/native")).Host);
        foreach (var url in new[] { "ws://example.com:9222/devtools/page/native", "ws://127.0.0.1:9223/devtools/page/native", "ws://user:pass@127.0.0.1:9222/devtools/page/native", "ws://127.0.0.1:9222/devtools/page/native?token=private", "ws://127.0.0.1:9222/devtools/browser/native", "wss://127.0.0.1:9222/devtools/page/native" })
            Assert.Throws<IOException>(() => DesktopCdp.ValidateTarget(9222, Targets(url)));
        Assert.Throws<IOException>(() => DesktopCdp.ValidateTarget(9222, Targets("ws://127.0.0.1:9222/devtools/page/native", "https://unrelated.example")));
    }

    [TestMethod]
    public void NativeApprovalsKeepIdentityAndResolveAcrossClients()
    {
        var request = JsonNode.Parse("{\"kind\":\"notification\",\"payload\":{\"method\":\"server/request\",\"params\":{\"id\":42,\"method\":\"item/commandExecution/requestApproval\",\"params\":{\"threadId\":\"chat\",\"turnId\":\"turn\"}}}}")!.AsObject();
        var mapped = DesktopCdp.NormalizeEvent(request)!;
        Assert.AreEqual(42, mapped["id"]!.GetValue<int>());
        Assert.AreEqual("item/commandExecution/requestApproval", mapped["method"]!.GetValue<string>());
        Assert.AreEqual("chat", mapped["params"]!["threadId"]!.GetValue<string>());
        mapped["params"]!["threadId"] = "changed";
        Assert.AreEqual("chat", request["payload"]!["params"]!["params"]!["threadId"]!.GetValue<string>());
        var resolved = DesktopCdp.NormalizeEvent(JsonNode.Parse("{\"kind\":\"notification\",\"payload\":{\"method\":\"server/request/resolved\",\"params\":{\"id\":42}}}")!.AsObject())!;
        Assert.AreEqual("serverRequest/resolved", resolved["method"]!.GetValue<string>());
        Assert.AreEqual(42, resolved["params"]!["requestId"]!.GetValue<int>());
        Assert.IsNull(DesktopCdp.NormalizeEvent(new() { ["kind"] = "conversationState", ["payload"] = new JsonObject() }));
    }

    [TestMethod]
    public void HistoryRollbackAndImagesCannotBypassRelayBounds()
    {
        JsonObject Request(string method, JsonObject p) => new() { ["id"] = "one", ["method"] = method, ["params"] = p };
        Assert.AreEqual("thread/turns/list", CodexRemoteProtocol.ValidateRequest(Request("thread/turns/list", new() { ["threadId"] = "chat", ["limit"] = 8, ["cursor"] = "page" })));
        foreach (var value in new object[] { 0, 51, "2" })
            Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request("thread/rollback", new() { ["threadId"] = "chat", ["numTurns"] = JsonValue.Create(value) })));
        foreach (var url in new[] { "file:///private", "https://example.com/image.png", "data:image/svg+xml;base64,QQ==", "data:image/jpeg;base64," })
            Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request("turn/start", new() { ["threadId"] = "chat", ["input"] = new JsonArray(new JsonObject { ["type"] = "image", ["url"] = url }) })));
        Assert.AreEqual("turn/start", CodexRemoteProtocol.ValidateRequest(Request("turn/start", new() { ["threadId"] = "chat", ["input"] = new JsonArray(new JsonObject { ["type"] = "image", ["url"] = "data:image/jpeg;base64,QQ==" }) })));
    }
}
