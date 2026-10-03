using System.Text;
using System.Text.Json.Nodes;
using LanPower.CodexHost;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class CodexSystemTests
{
    [TestMethod]
    public void HistoryBeyond128TurnsKeepsEveryItemAndLongText()
    {
        var text = new string('长', 20000) + "END";
        var turns = new JsonArray(Enumerable.Range(0,180).Select(i => (JsonNode)new JsonObject {
            ["id"] = "turn-" + i, ["items"] = new JsonArray(Enumerable.Range(0,100).Select(j => (JsonNode)new JsonObject {
                ["type"] = "agentMessage", ["id"] = "item-" + j, ["text"] = text }).ToArray()) }).ToArray());
        var ids = new List<string>(); string? cursor = null;
        do {
            var page = RemoteHistory.PageSavedTurns(turns,cursor,8);
            foreach (var turn in page["data"]!.AsArray()) {
                ids.Add(turn!["id"]!.GetValue<string>());
                Assert.AreEqual(100,turn["items"]!.AsArray().Count);
                Assert.AreEqual(text,turn["items"]![99]!["text"]!.GetValue<string>());
            }
            cursor = page["nextCursor"]?.GetValue<string>();
        } while (cursor is not null);
        CollectionAssert.AreEqual(Enumerable.Range(0,180).Reverse().Select(i => "turn-" + i).ToArray(),ids.ToArray());
    }

    [TestMethod]
    public void LargeUnicodeResultStreamsWithoutCorruptingSurrogates()
    {
        var expected = new string('中',400000) + string.Concat(Enumerable.Repeat("🎨",60000)) + "THE-END";
        var payload = new JsonObject { ["id"] = "read-long", ["result"] = new JsonObject { ["text"] = expected } };
        var raw = new JsonObject { ["type"] = "rpc", ["session"] = Guid.NewGuid().ToString(), ["payload"] = payload }.ToJsonString(CodexRemoteProtocol.JsonOptions);
        var parts = CodexRemoteFrames.Encode(raw).Select(part => CodexRemoteProtocol.Parse(part)).ToArray();
        Assert.IsGreaterThan(1,parts.Length);
        var joined = new StringBuilder();
        for (var i = 0; i < parts.Length; i++) {
            Assert.AreEqual(i,parts[i]["index"]!.GetValue<int>()); Assert.AreEqual(parts.Length,parts[i]["count"]!.GetValue<int>());
            joined.Append(parts[i]["data"]!.GetValue<string>());
        }
        Assert.AreEqual(expected,JsonNode.Parse(joined.ToString())!["result"]!["text"]!.GetValue<string>());
    }

    [TestMethod]
    public void DesktopStateCallbacksReachRemoteClients()
    {
        var state = DesktopCdp.NormalizeEvent(new() { ["kind"] = "conversationState", ["payload"] = new JsonObject { ["threadId"] = "native", ["active"] = false, ["runtimeStatus"] = "idle" } })!;
        Assert.AreEqual("lanpower/conversation/changed",state["method"]!.GetValue<string>());
        Assert.IsFalse(state["params"]!["active"]!.GetValue<bool>());
        Assert.AreEqual("lanpower/stream/changed", DesktopCdp.NormalizeEvent(new() { ["kind"] = "streamRole", ["payload"] = new JsonObject { ["threadId"] = "native", ["state"] = "assistant" } })!["method"]!.GetValue<string>());
        Assert.AreEqual("native", DesktopCdp.NormalizeEvent(new() { ["kind"] = "turnCompleted", ["payload"] = new JsonObject { ["conversationId"] = "native" } })!["params"]!["threadId"]!.GetValue<string>());
    }

    [TestMethod]
    public async Task LibrarySurvivesNewClientAndRejectsStaleWrites()
    {
        var root = Path.Combine(Path.GetTempPath(),"LanPowerLibraryTests",Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try {
            var file = Path.Combine(root,"library.json"); var first = new RemoteLibraryStore(file); var second = new RemoteLibraryStore(file);
            var draft = CodexLibraryPreferences.Defaults(); draft["collapsed"] = new JsonArray("d:/projects/demo"); draft["aliases"]!["d:/projects/demo"] = "示例";
            Assert.AreEqual(1L,(await first.UpdateAsync(0,draft,CancellationToken.None))["revision"]!.GetValue<long>());
            var restored = await second.ReadAsync(CancellationToken.None);
            Assert.AreEqual("示例",restored["preferences"]!["aliases"]!["d:/projects/demo"]!.GetValue<string>());
            var stale = await second.UpdateAsync(0,CodexLibraryPreferences.Defaults(),CancellationToken.None);
            Assert.IsTrue(stale["conflict"]!.GetValue<bool>());
            Assert.AreEqual("示例",(await first.ReadAsync(CancellationToken.None))["preferences"]!["aliases"]!["d:/projects/demo"]!.GetValue<string>());
        } finally { Directory.Delete(root,true); }
    }

    [TestMethod]
    public void ImageReferenceIsBoundToTheNativeThreadAndFileScope()
    {
        var root = Path.Combine(Path.GetTempPath(),"LanPowerImageTests",Guid.NewGuid().ToString("N"));
        var workspace = Path.Combine(root,"workspace"); Directory.CreateDirectory(workspace);
        try {
            var external = Path.Combine(root,"image.png"); File.WriteAllBytes(external,new byte[] {137,80,78,71,13,10,26,10,1,2,3});
            var reader = new RemoteImages(); var scope = new CodexHostSettings(true,[workspace],AutoDiscover:false);
            Assert.Throws<InvalidDataException>(() => reader.Read(scope,workspace,"chat",external));
            reader.Observe("chat",new JsonObject { ["text"] = "![生成图片](<" + external + ">)" });
            Assert.AreEqual("image/png",reader.Read(scope,workspace,"chat",external)["contentType"]!.GetValue<string>());
            Assert.Throws<InvalidDataException>(() => reader.Read(scope,workspace,"other-chat",external));
            Assert.Throws<InvalidDataException>(() => RemoteWorkspace.Read(scope,workspace,"../image.png"));
            File.WriteAllText(Path.Combine(workspace,"notes.png"),"private text");
            Assert.Throws<InvalidDataException>(() => reader.Read(scope,workspace,"chat","notes.png"));
        } finally { Directory.Delete(root,true); }
    }
}
