using System.Text.Json.Nodes;
using LanPower.CodexHost;
using LanPower.Shared;
namespace LanPower.UnitTests;
[TestClass]
public sealed class CodexNativeStatusTests
{
    private static JsonObject Plugins(int count) => new() { ["result"] = new JsonObject { ["marketplaces"] = new JsonArray(new JsonObject {
        ["name"] = "fixture", ["plugins"] = new JsonArray(Enumerable.Range(0,count).Select(index => (JsonNode)new JsonObject {
            ["id"] = $"plugin-{index}", ["name"] = $"Plugin {index}", ["interface"] = new JsonObject { ["displayName"] = $"能力 {index}", ["logo"] = "data:image/png;base64," + new string('x',10000) },
            ["installed"] = index % 2 == 0, ["enabled"] = index % 3 == 0 }).ToArray()) }) } };
    [TestMethod]
    public async Task PluginPagesAreCompactAndOnlyNativeParamsLeaveTheHost()
    {
        var pager = new RemoteCapabilityCatalog(); var calls = 0;
        Task<JsonObject> Native(string method, JsonObject args, CancellationToken token) { calls++; Assert.AreEqual("plugin/list",method); Assert.AreEqual(1,args.Count); Assert.IsNotNull(args["cwds"]); return Task.FromResult(Plugins(55)); }
        var first = await pager.ReadAsync("plugin/list",["D:/Fixture"],new() { ["limit"] = 24 },Native,CancellationToken.None);
        Assert.AreEqual(24,first["result"]!["marketplaces"]![0]!["plugins"]!.AsArray().Count);
        Assert.IsFalse(first.ToJsonString().Contains("data:image")); Assert.IsLessThan(10000,first.ToJsonString().Length);
        var cursor = first["result"]!["nextCursor"]!.GetValue<string>();
        var next = await pager.ReadAsync("plugin/list",["D:/Fixture"],new() { ["limit"] = 24,["cursor"] = cursor },Native,CancellationToken.None);
        Assert.AreEqual("plugin-24",next["result"]!["marketplaces"]![0]!["plugins"]![0]!["id"]!.GetValue<string>()); Assert.AreEqual(1,calls);
        await Assert.ThrowsAsync<InvalidDataException>(() => pager.ReadAsync("plugin/list",["D:/Other"],new() { ["limit"] = 24,["cursor"] = cursor },Native,CancellationToken.None));
        pager.Clear(); await Assert.ThrowsAsync<InvalidDataException>(() => pager.ReadAsync("plugin/list",["D:/Fixture"],new() { ["limit"] = 24,["cursor"] = cursor },Native,CancellationToken.None));
    }
    [TestMethod]
    public async Task SkillPagesKeepMissingEnabledUnknownAndRefreshNativeData()
    {
        var pager = new RemoteCapabilityCatalog(); var calls = 0;
        Task<JsonObject> Native(string method, JsonObject args, CancellationToken token) { calls++; return Task.FromResult(new JsonObject { ["result"] = new JsonObject { ["data"] = new JsonArray(new JsonObject {
            ["cwd"] = "D:/Fixture", ["skills"] = new JsonArray(new JsonObject { ["name"] = "unknown", ["path"] = "D:/Fixture/SKILL.md" }), ["errors"] = new JsonArray() }) } }); }
        var first = await pager.ReadAsync("skills/list",["D:/Fixture"],new() { ["limit"] = 24 },Native,CancellationToken.None);
        Assert.IsNull(first["result"]!["data"]![0]!["skills"]![0]!["enabled"]);
        await pager.ReadAsync("skills/list",["D:/Fixture"],new() { ["limit"] = 24 },Native,CancellationToken.None); Assert.AreEqual(1,calls);
        await pager.ReadAsync("skills/list",["D:/Fixture"],new() { ["limit"] = 24,["refresh"] = true },Native,CancellationToken.None); Assert.AreEqual(2,calls);
    }
    [TestMethod]
    public async Task ErrorsAreExplicitAndInvalidationRejectsInFlightSnapshots()
    {
        var pager = new RemoteCapabilityCatalog();
        var error = await pager.ReadAsync("plugin/list",[],new() { ["limit"] = 24 },(_,_,_) => Task.FromResult(new JsonObject { ["result"] = new JsonObject {
            ["marketplaces"] = new JsonArray(), ["marketplaceLoadErrors"] = new JsonArray(new JsonObject { ["message"] = "原生市场未授权" }) } }),CancellationToken.None);
        Assert.AreEqual("原生市场未授权",error["result"]!["unavailableReason"]!.GetValue<string>());
        var release = new TaskCompletionSource<JsonObject>();
        var pending = pager.ReadAsync("plugin/list",[],new() { ["limit"] = 24 },(_,_,_) => release.Task,CancellationToken.None);
        pager.Clear(); release.SetResult(Plugins(1)); await Assert.ThrowsAsync<InvalidDataException>(async () => await pending);
    }
    [TestMethod]
    public void CatalogMethodsAcceptOnlyBoundedPaginationParams()
    {
        foreach (var method in new[] { "skills/list", "plugin/list" })
        {
            JsonObject Request(int limit) => new() { ["id"] = "page", ["method"] = method, ["params"] = new JsonObject { ["cwd"] = "D:/Fixture", ["limit"] = limit, ["refresh"] = true } };
            Assert.AreEqual(method,CodexRemoteProtocol.ValidateRequest(Request(24)));
            Assert.Throws<InvalidDataException>(() => CodexRemoteProtocol.ValidateRequest(Request(25)));
        }
    }
}
