using System.Text;
using System.Text.Json.Nodes;
using LanPower.CodexHost;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class CodexDeepReviewTests
{
    [TestMethod]
    public async Task PublishedReferencesSurviveSamePageAndBackgroundBodyEviction()
    {
        var text = new string('x', 17 * 1024 * 1024);
        var items = new JsonArray(new JsonObject { ["id"] = "first", ["type"] = "agentMessage", ["text"] = "🎨" + text },
            new JsonObject { ["id"] = "second", ["type"] = "agentMessage", ["text"] = text + "结尾" });
        var source = new JsonArray(new JsonObject { ["id"] = "turn", ["items"] = items });
        var store = new RemoteHistoryStore(); var page = store.Pack("thread", source);
        var reference = page[0]!["items"]![0]!["reference"]!.GetValue<string>();
        Task<JsonObject> Load(RemoteHistoryStore.Locator locator, CancellationToken token) => Task.FromResult((JsonObject)items[locator.ItemIndex]!.DeepClone());
        foreach (var descriptor in page[0]!["items"]!.AsArray())
        {
            var parts = new StringBuilder(); var offset = 0;
            do
            {
                var part = await store.ReadAsync("thread", descriptor!["reference"]!.GetValue<string>(), offset, Load, CancellationToken.None);
                parts.Append(part["data"]!.GetValue<string>());
                Assert.IsLessThanOrEqualTo((long)RemoteHistoryStore.MaxLocalBytes, store.CachedBytes);
                if (part["nextOffset"] is null) break;
                offset = part["nextOffset"]!.GetValue<int>();
            } while (true);
            Assert.AreEqual(descriptor!["id"]!.GetValue<string>(), JsonNode.Parse(parts.ToString())!["id"]!.GetValue<string>());
            Assert.AreEqual(items.First(i => i!["id"]!.GetValue<string>() == descriptor["id"]!.GetValue<string>())!["text"]!.GetValue<string>(), JsonNode.Parse(parts.ToString())!["text"]!.GetValue<string>());
        }
        var other = new JsonArray(new JsonObject { ["id"] = "other-turn", ["items"] = new JsonArray(new JsonObject { ["id"] = "background", ["type"] = "agentMessage", ["text"] = text }) });
        await Task.WhenAll(Task.Run(() => store.Pack("other", other)), Task.Run(async () => await store.ReadAsync("thread", reference, 0, Load, CancellationToken.None)));
        var first = await store.ReadAsync("thread", reference, 0, Load, CancellationToken.None);
        Assert.AreEqual(0, first["offset"]!.GetValue<int>());
        Assert.IsLessThanOrEqualTo((long)RemoteHistoryStore.MaxLocalBytes, store.CachedBytes);
        await Assert.ThrowsAsync<InvalidDataException>(() => store.ReadAsync("other", reference, 0, Load, CancellationToken.None));
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => store.ReadAsync("thread", reference, 0, Load, cancelled.Token));
        store.Pack("new-background", other);
        Task<JsonObject> Changed(RemoteHistoryStore.Locator locator, CancellationToken token) => Task.FromResult(new JsonObject {
            ["id"] = locator.ItemId, ["type"] = "agentMessage", ["text"] = "原生内容已变化" });
        await Assert.ThrowsAsync<InvalidDataException>(() => store.ReadAsync("thread", reference, 0, Changed, CancellationToken.None));
        var acrossTurns = new JsonArray(new JsonObject { ["id"] = "older", ["items"] = new JsonArray(items[0]!.DeepClone()) },
            new JsonObject { ["id"] = "newer", ["items"] = new JsonArray(items[1]!.DeepClone()) });
        var acrossPage = store.Pack("across-turns", acrossTurns);
        Task<JsonObject> LoadById(RemoteHistoryStore.Locator locator, CancellationToken token) =>
            Task.FromResult((JsonObject)items.First(item => item!["id"]!.GetValue<string>() == locator.ItemId)!.DeepClone());
        foreach (var turn in acrossPage.OfType<JsonObject>())
            Assert.AreEqual(0, (await store.ReadAsync("across-turns", turn["items"]![0]!["reference"]!.GetValue<string>(), 0, LoadById, CancellationToken.None))["offset"]!.GetValue<int>());
        Assert.IsLessThanOrEqualTo((long)RemoteHistoryStore.MaxLocalBytes, store.CachedBytes);
    }

    [TestMethod]
    public async Task ExpiredReferencesFailExplicitlyAndCanBeRepublished()
    {
        var now = DateTimeOffset.UtcNow; var store = new RemoteHistoryStore(() => now);
        var item = new JsonObject { ["id"] = "large", ["type"] = "agentMessage", ["text"] = new string('a', 600000) };
        var turns = new JsonArray(new JsonObject { ["id"] = "turn", ["items"] = new JsonArray(item.DeepClone()) });
        var reference = store.Pack("thread", turns)[0]!["items"]![0]!["reference"]!.GetValue<string>();
        now += TimeSpan.FromMinutes(11);
        Task<JsonObject> Load(RemoteHistoryStore.Locator _, CancellationToken token) => Task.FromResult((JsonObject)item.DeepClone());
        await Assert.ThrowsAsync<InvalidDataException>(() => store.ReadAsync("thread", reference, 0, Load, CancellationToken.None));
        var next = store.Pack("thread", turns)[0]!["items"]![0]!["reference"]!.GetValue<string>();
        Assert.AreNotEqual(reference, next); Assert.AreEqual(0, (await store.ReadAsync("thread", next, 0, Load, CancellationToken.None))["offset"]!.GetValue<int>());
    }

    [TestMethod]
    public void StableHistoryPositionsUseTheNativeTailAndRejectConcurrentChanges()
    {
        var ids = Enumerable.Range(1, 180).Reverse().Select(i => "turn-" + i).ToArray();
        Assert.AreEqual(179, RemoteHistory.TailCount(ids, "turn-1", "turn-180", false));
        Assert.AreEqual(180, RemoteHistory.TailCount(ids, "turn-1", "turn-180", true));
        Assert.AreEqual(91, RemoteHistory.TailCount(ids, "turn-90", "turn-180", true));
        Assert.AreEqual(1, RemoteHistory.TailCount(ids, "turn-180", "turn-180", true));
        Assert.Throws<InvalidDataException>(() => RemoteHistory.TailCount(["turn-181", ..ids], "turn-1", "turn-180", true));
        Assert.Throws<InvalidDataException>(() => RemoteHistory.TailCount(ids, "missing", "turn-180", false));
    }

    [TestMethod]
    public void LongInputsKeepUnicodeValidationWithoutTextCeiling()
    {
        JsonObject Request(string text) => new() { ["id"] = "rpc", ["method"] = "turn/start", ["params"] = new JsonObject {
            ["threadId"] = "thread", ["input"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }) } };
        foreach (var character in new[] { "x", "中", "🎨" })
        {
            var boundary = string.Concat(Enumerable.Repeat(character, 16000));
            Assert.AreEqual("turn/start", CodexRemoteProtocol.ValidateRequest(Request(boundary)));
            Assert.AreEqual("turn/start", CodexRemoteProtocol.ValidateRequest(Request(string.Concat(Enumerable.Repeat(character, 100000)))));
        }
        Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request("\ud800")));
        Assert.AreEqual(1, CodexRemoteProtocol.UnicodeLength("🎨"));
    }

    [TestMethod]
    public void CompleteLibraryMetadataPreservesOlderPagesAndFindsUnloadedPins()
    {
        var catalog = new RemoteLibraryCatalog();
        var entries = Enumerable.Range(0, 180).Select(i => (Thread: new JsonObject { ["id"] = "chat-" + i, ["name"] = i == 170 ? "目标聊天" : "聊天", ["cwd"] = "D:/Work/Nested", ["updatedAt"] = 180 - i }, Archived: false)).ToArray();
        catalog.Replace(entries);
        var page = catalog.Page("", false, ["chat-170"], null, 50);
        Assert.AreEqual(50, page["data"]!.AsArray().Count); Assert.AreEqual("chat-170", page["pinned"]![0]!["id"]!.GetValue<string>());
        Assert.AreEqual("chat-170", catalog.Page("目标", false, [], null, 50)["data"]![0]!["id"]!.GetValue<string>());
        Assert.AreEqual(1, catalog.Check(["chat-150"], false)["data"]!.AsArray().Count);
        var cursor = page["nextCursor"]!.GetValue<string>();
        catalog.Replace(entries.Select(e => (e.Thread, e.Thread["id"]!.GetValue<string>() == "chat-150")));
        Assert.AreEqual(0, catalog.Check(["chat-150"], false)["data"]!.AsArray().Count);
        Assert.AreEqual(1, catalog.Check(["chat-150"], true)["data"]!.AsArray().Count);
        Assert.Throws<InvalidDataException>(() => catalog.Page("", false, [], cursor, 50));
    }

    [TestMethod]
    public void NestedProjectsUseTheLongestNormalizedRoot()
    {
        var roots = new[] { new CodexProject("parent", "D:\\Work"), new CodexProject("nested", "D:\\Work\\Nested") };
        Assert.AreEqual("nested", CodexProjects.ContainingProject(roots, "d:/work/nested/src/")?.Name);
        Assert.AreEqual("parent", CodexProjects.ContainingProject(roots, "\\\\?\\D:\\Work\\Other")?.Name);
        Assert.IsNull(CodexProjects.ContainingProject(roots, "D:/Workspace/Nested"));
    }

    [TestMethod]
    public void ToolHistoryKeepsPublicResultsAndRemovesNestedPrivateReasoning()
    {
        var turns = JsonNode.Parse("""[{"id":"turn","items":[{"id":"mcp","type":"mcpToolCall","result":{"type":"reasoning","summary":["公开摘要"],"content":"private","encryptedContent":"secret"}},{"id":"compact","type":"contextCompaction","content":"private context"}]}]""")!.AsArray();
        var visible = RemoteHistory.VisibleTurns(turns).ToJsonString(CodexRemoteProtocol.JsonOptions);
        Assert.Contains("公开摘要", visible); Assert.DoesNotContain("private", visible); Assert.DoesNotContain("secret", visible);
    }
}
