using System.Text.Json.Nodes;
using LanPower.CodexHost;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class CodexOriginalInputsTests
{
    [TestMethod]
    public async Task OrdinaryFilesKeepOriginalBytesOnTheTargetAndRejectPathEscapes()
    {
        var root = Path.Combine(Path.GetTempPath(), "LanPowerUploads", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try {
            var scope = new CodexHostSettings(true,[root],AutoDiscover:false);
            var bytes = new byte[21 * 1024 * 1024]; new Random(1234).NextBytes(bytes);
            var data = Convert.ToBase64String(bytes); var staging = Path.Combine(root,"uploads");
            var result = await RemoteWorkspace.UploadAsync(scope,root,"original.bin",data,CancellationToken.None,staging);
            Assert.IsTrue(System.Security.Cryptography.SHA256.HashData(bytes).SequenceEqual(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(result["path"]!.GetValue<string>()))));
            foreach (var name in new[] { "../escape.txt", "..\\escape.txt", "D:\\escape.txt", "file:stream" })
                await Assert.ThrowsAsync<InvalidDataException>(() => RemoteWorkspace.UploadAsync(scope,root,name,data,CancellationToken.None,staging));
            await Assert.ThrowsAsync<InvalidDataException>(() => RemoteWorkspace.UploadAsync(scope,Path.GetTempPath(),"outside.bin",data,CancellationToken.None,staging));
        } finally { Directory.Delete(root,true); }
    }

    private static JsonObject Request() => new() { ["type"] = "rpc", ["session"] = Guid.NewGuid().ToString("D"),
        ["payload"] = new JsonObject { ["id"] = "original", ["method"] = "turn/start", ["params"] = new JsonObject {
            ["threadId"] = "chat", ["input"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = string.Concat(Enumerable.Repeat("中🎨", 20000)) }) } } };

    [TestMethod]
    public void ManyOriginalImagesAndSkillsSurviveOrderedRequestPieces()
    {
        var frame = Request(); var input = frame["payload"]!["params"]!["input"]!.AsArray();
        for (var i=0;i<10;i++) input.Add(new JsonObject { ["type"] = "image", ["url"] = "data:image/png;base64," + new string('A', 3000000) });
        for (var i=0;i<20;i++) input.Add(new JsonObject { ["type"] = "skill", ["name"] = "skill-"+i, ["path"] = "D:/Skills/"+i });
        var raw = frame.ToJsonString(CodexRemoteProtocol.JsonOptions);
        var parts = CodexRemoteRequests.Encode(raw).ToArray();
        Assert.IsGreaterThan(400, parts.Length);
        var uploads = new CodexRemoteRequests(); JsonObject? result = null;
        for (var i=0;i<parts.Length;i++)
        {
            result = uploads.Accept(CodexRemoteProtocol.Parse(parts[i]));
            if (i+1 < parts.Length) Assert.IsNull(result);
        }
        Assert.IsNotNull(result);
        Assert.IsTrue(JsonNode.DeepEquals(frame, result));
        Assert.AreEqual("turn/start", CodexRemoteProtocol.ValidateRequest(result["payload"]!.AsObject()));
    }

    [TestMethod]
    public void IncompleteOutOfOrderAndMismatchedRequestsCannotExecute()
    {
        var raw = Request().ToJsonString(CodexRemoteProtocol.JsonOptions);
        var frames = CodexRemoteRequests.Encode(raw).Select(part => CodexRemoteProtocol.Parse(part)).ToArray();
        var uploads = new CodexRemoteRequests();
        Assert.IsNull(uploads.Accept(frames[0])); uploads.Clear();
        Assert.Throws<InvalidDataException>(() => uploads.Accept(frames[1]));
        uploads.Clear(); Assert.IsNull(uploads.Accept(frames[0]));
        var duplicate = (JsonObject)frames[0].DeepClone();
        Assert.Throws<InvalidDataException>(() => uploads.Accept(duplicate));
        uploads.Clear(); foreach (var frame in frames) frame["id"] = "wrong";
        Assert.Throws<InvalidDataException>(() => { foreach (var frame in frames) uploads.Accept(frame); });
    }

    [TestMethod]
    public void LargeResultsQueuesAndWorkspaceFilesRetainAllContent()
    {
        var raw = new JsonObject { ["type"] = "rpc", ["session"] = Guid.NewGuid().ToString("D"), ["payload"] = new JsonObject {
            ["id"] = "result", ["result"] = new JsonObject { ["text"] = new string('x', 34 * 1024 * 1024) } } }.ToJsonString(CodexRemoteProtocol.JsonOptions);
        var parts = CodexRemoteFrames.Encode(raw).ToArray(); Assert.IsGreaterThan(512, parts.Length);
        var body = string.Concat(parts.Select(part => CodexRemoteProtocol.Parse(part)["data"]!.GetValue<string>()));
        Assert.AreEqual(34 * 1024 * 1024, JsonNode.Parse(body)!["result"]!["text"]!.GetValue<string>().Length);
        var ids = new JsonArray(Enumerable.Range(0,100).Select(i => (JsonNode)JsonValue.Create("queue-"+i)!).ToArray());
        Assert.AreEqual("thread/queue/reorder", CodexRemoteProtocol.ValidateRequest(new() { ["id"] = "q", ["method"] = "thread/queue/reorder", ["params"] = new JsonObject { ["threadId"] = "chat", ["queuedSubmissionIds"] = ids } }));
        var root = Path.Combine(Path.GetTempPath(), "LanPowerOriginal", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try {
            var content = new string('x', 2 * 1024 * 1024); File.WriteAllText(Path.Combine(root,"large.txt"), content);
            var scope = new CodexHostSettings(true,[root],AutoDiscover:false);
            Assert.AreEqual(content.Length, RemoteWorkspace.Read(scope,root,"large.txt")["content"]!.GetValue<string>().Length);
        } finally { Directory.Delete(root,true); }
    }
}
