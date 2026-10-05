using System.Text.Json.Nodes;
using LanPower.CodexHost;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace LanPower.UnitTests;

[TestClass]
[DoNotParallelize]
public class NativeSessionSnapshotTests
{
    [TestMethod]
    public void LiveDesktopProgressSurvivesHistoricalInterruptAndUpdatesWithoutResume()
    {
        WithSession((id,file,root) =>
        {
            Append(file,"event_msg",new() { ["type"]="task_started",["turn_id"]="old",["started_at"]="2026-10-02T10:00:00Z" });
            Append(file,"event_msg",new() { ["type"]="turn_aborted",["turn_id"]="old" });
            Append(file,"event_msg",new() { ["type"]="task_started",["turn_id"]="current",["started_at"]="2026-10-02T10:01:00Z" });
            Append(file,"event_msg",new() { ["type"]="item_completed",["turn_id"]="current",["item"]=new JsonObject { ["type"]="AgentMessage",["id"]="reply",["content"]=new JsonArray(new JsonObject { ["type"]="Text",["text"]="正在检查" }),["phase"]="commentary" } });
            var lockPath=Path.Combine(root,"thread-writer-locks",id+".lock");
            using var owner=new FileStream(lockPath,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete); owner.Lock(0,1);
            var snapshot=NativeSessionSnapshot.Read(id,file,root)!;
            Assert.AreEqual("running",snapshot["live"]!["state"]!.GetValue<string>());
            Assert.AreEqual("current",snapshot["live"]!["turnId"]!.GetValue<string>());
            Assert.AreEqual("正在检查",snapshot["turns"]![1]!["items"]![0]!["text"]!.GetValue<string>());
            Append(file,"event_msg",new() { ["type"]="item_completed",["turn_id"]="current",["item"]=new JsonObject { ["type"]="AgentMessage",["id"]="reply2",["content"]="新进度" } });
            Assert.AreEqual(2,NativeSessionSnapshot.Read(id,file,root)!["turns"]![1]!["items"]!.AsArray().Count);
            // An older completion must never finish the newer active turn.
            Append(file,"event_msg",new() { ["type"]="task_complete",["turn_id"]="old" });
            Assert.AreEqual("running",NativeSessionSnapshot.Read(id,file,root)!["live"]!["state"]!.GetValue<string>());
            Append(file,"event_msg",new() { ["type"]="task_complete",["turn_id"]="current",["duration_ms"]=125000,["completed_at"]="2026-10-02T10:03:05Z" });
            snapshot=NativeSessionSnapshot.Read(id,file,root)!;
            Assert.AreEqual("idle",snapshot["live"]!["state"]!.GetValue<string>());
            Assert.AreEqual(125000,snapshot["turns"]![1]!["durationMs"]!.GetValue<int>());
            owner.Unlock(0,1);
        });
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public void SavedSendSettingsRemainReadableWithoutWritingOrRelayingPrivateContext(bool largeTail)
    {
        WithSession((id,file,root) =>
        {
            Append(file,"turn_context",new() { ["turn_id"]="turn", ["model"]="gpt-6", ["effort"]="high",
                ["developer_instructions"]="private instructions", ["collaboration_mode"]=new JsonObject { ["mode"]="plan", ["settings"]=new JsonObject { ["developer_instructions"]="private context" } } });
            if (largeTail) File.AppendAllText(file,new string('x',5*1024*1024)+"\n");
            Append(file,"event_msg",new() { ["type"]="task_complete", ["turn_id"]="turn" });
            var length=new FileInfo(file).Length; var updated=File.GetLastWriteTimeUtc(file);
            for (var repeat=0;repeat<3;repeat++)
            {
                var snapshot=NativeSessionSnapshot.Read(id,file,root)!;
                Assert.AreEqual("gpt-6",snapshot["settings"]!["model"]!.GetValue<string>());
                Assert.AreEqual("high",snapshot["settings"]!["reasoningEffort"]!.GetValue<string>());
                Assert.AreEqual("plan",snapshot["settings"]!["collaborationMode"]!["mode"]!.GetValue<string>());
                Assert.DoesNotContain("private",snapshot.ToJsonString());
            }
            Assert.AreEqual(length,new FileInfo(file).Length); Assert.AreEqual(updated,File.GetLastWriteTimeUtc(file));
        });
    }

    [TestMethod]
    public void SnapshotRejectsWrongThreadWorkspaceAndOutsidePaths()
    {
        WithSession((id,file,root) =>
        {
            Assert.IsNull(NativeSessionSnapshot.Read(Guid.NewGuid().ToString(),file,root));
            Assert.IsNull(NativeSessionSnapshot.Read(id,file,Path.GetTempPath()));
            Assert.IsNull(NativeSessionSnapshot.Read(id,Path.Combine(root,"auth.json"),root));
            Assert.IsNull(NativeSessionSnapshot.Read("../../outside",file,root));
            Assert.IsNotNull(NativeSessionSnapshot.Read(id,@"\\?\"+file,root));
        });
    }

    [TestMethod]
    public void SnapshotOmitsReasoningAndRetriesPartialWriterRecords()
    {
        WithSession((id,file,root) =>
        {
            Append(file,"event_msg",new() { ["type"]="task_started",["turn_id"]="turn" });
            Append(file,"response_item",new() { ["type"]="reasoning",["summary"]="private reasoning",["encrypted_content"]="private content" });
            File.AppendAllText(file,"{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"turn_id\":\"turn\",\"item\":");
            var first=NativeSessionSnapshot.Read(id,file,root)!;
            Assert.AreEqual(0,first["turns"]![0]!["items"]!.AsArray().Count);
            File.AppendAllText(file,"{\"type\":\"AgentMessage\",\"id\":\"reply\",\"content\":\"visible\"}}}\n");
            var second=NativeSessionSnapshot.Read(id,file,root)!;
            Assert.AreEqual("visible",second["turns"]![0]!["items"]![0]!["text"]!.GetValue<string>());
            Assert.DoesNotContain("private",second.ToJsonString());
        });
    }

    [TestMethod]
    public void LongActiveTurnKeepsRealStartTimeOutsideTheMessageTail()
    {
        WithSession((id,file,root) =>
        {
            Append(file,"event_msg",new() { ["type"]="task_started",["turn_id"]="long-turn",["started_at"]=1790928000 });
            Append(file,"event_msg",new() { ["type"]="item_completed",["turn_id"]="long-turn",["item"]=new JsonObject { ["type"]="UserMessage",["id"]="user",["content"]=new JsonArray(new JsonObject { ["type"]="Text",["text"]="原始任务" }) } });
            File.AppendAllText(file,new string('x',5*1024*1024)+"\n");
            Append(file,"turn_context",new() { ["turn_id"]="long-turn" });
            Append(file,"event_msg",new() { ["type"]="item_completed",["turn_id"]="long-turn",["item"]=new JsonObject { ["type"]="AgentMessage",["id"]="reply",["content"]="最新进度" } });
            using var owner=new FileStream(Path.Combine(root,"thread-writer-locks",id+".lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete); owner.Lock(0,1);
            var snapshot=NativeSessionSnapshot.Read(id,file,root)!;
            Assert.AreEqual("running",snapshot["live"]!["state"]!.GetValue<string>());
            Assert.AreEqual(1790928000L,snapshot["live"]!["startedAt"]!.GetValue<long>());
            Assert.AreEqual("userMessage",snapshot["turns"]![0]!["items"]![0]!["type"]!.GetValue<string>());
            Assert.IsTrue(snapshot.ToJsonString().Length<250000); owner.Unlock(0,1);
        });
    }

    [TestMethod]
    public void ReleasingDesktopLockDoesNotLeaveCachedRunningState()
    {
        WithSession((id,file,root) =>
        {
            Append(file,"event_msg",new() { ["type"]="task_started",["turn_id"]="turn" });
            using var owner=new FileStream(Path.Combine(root,"thread-writer-locks",id+".lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete);
            owner.Lock(0,1);
            Assert.AreEqual("running",NativeSessionSnapshot.Read(id,file,root)!["live"]!["state"]!.GetValue<string>());
            owner.Unlock(0,1);
            Assert.AreEqual("unknown",NativeSessionSnapshot.Read(id,file,root)!["live"]!["state"]!.GetValue<string>());
        });
    }

    private static void Append(string file,string kind,JsonObject payload) => File.AppendAllText(file,new JsonObject { ["type"]=kind,["timestamp"]="2026-10-02T10:02:00Z",["payload"]=payload }.ToJsonString()+"\n");
    [TestMethod]
    public void UserAttachmentsSurviveNativeHistoryFallback()
    {
        WithSession((id, file, root) =>
        {
            Append(file, "event_msg", new() { ["type"] = "task_started", ["turn_id"] = "images" });
            Append(file, "event_msg", new() { ["type"] = "item_completed", ["turn_id"] = "images", ["item"] = new JsonObject {
                ["type"] = "UserMessage", ["id"] = "user", ["content"] = new JsonArray(new JsonObject { ["type"] = "Text", ["text"] = "查看图片" },
                    new JsonObject { ["type"] = "LocalImage", ["path"] = "C:/Fixture/screenshot.png" },
                    new JsonObject { ["type"] = "image_url", ["image_url"] = new JsonObject { ["url"] = "data:image/png;base64,YQ==" } }) } });
            var content = NativeSessionSnapshot.Read(id, file, root)!["turns"]![0]!["items"]![0]!["content"]!.AsArray();
            Assert.AreEqual(3, content.Count); Assert.AreEqual("查看图片", content[0]!["text"]!.GetValue<string>());
            Assert.AreEqual("C:/Fixture/screenshot.png", content[1]!["path"]!.GetValue<string>()); Assert.AreEqual("localImage", content[1]!["type"]!.GetValue<string>());
            Assert.AreEqual("data:image/png;base64,YQ==", content[2]!["url"]!.GetValue<string>());
        });
    }

    private static void WithSession(Action<string,string,string> action)
    {
        var original=Environment.GetEnvironmentVariable("CODEX_HOME");
        var root=Path.Combine(Path.GetTempPath(),"LanPowerSnapshotTests",Guid.NewGuid().ToString("N")); var id=Guid.NewGuid().ToString();
        Directory.CreateDirectory(Path.Combine(root,"sessions","2026","10","02")); Directory.CreateDirectory(Path.Combine(root,"thread-writer-locks"));
        var file=Path.Combine(root,"sessions","2026","10","02","rollout-test-"+id+".jsonl");
        try { Environment.SetEnvironmentVariable("CODEX_HOME",root); Append(file,"session_meta",new() { ["id"]=id,["cwd"]=root }); action(id,file,root); }
        finally { Environment.SetEnvironmentVariable("CODEX_HOME",original); Directory.Delete(root,true); }
    }
}
