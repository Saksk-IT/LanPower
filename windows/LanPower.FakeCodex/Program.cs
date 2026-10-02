// Test fixture only. It never executes commands, edits files, or uses OpenAI.
using System.Text.Json.Nodes;

Console.InputEncoding = new System.Text.UTF8Encoding(false, true);
Console.OutputEncoding = new System.Text.UTF8Encoding(false);

var cwd = Environment.CurrentDirectory;
string? thread = null;
string? turn = null;
bool itemDiffOnly = false;
bool backgroundRunning = false;
JsonObject Thread(bool history = false) => new() { ["id"] = thread ?? "thread-test", ["cwd"] = cwd,
    ["name"] = "Fixture session", ["turns"] = new JsonArray(), ["status"] = new JsonObject { ["type"] = turn is null ? "idle" : "active" } };
void Send(JsonObject message) { Console.WriteLine(message.ToJsonString()); Console.Out.Flush(); }
void Notify(string method, JsonObject parameters) => Send(new() { ["method"] = method, ["params"] = parameters });
while (Console.ReadLine() is { } raw)
{
    var request = JsonNode.Parse(raw)!.AsObject();
    var method = request["method"]?.GetValue<string>();
    var p = request["params"]?.AsObject();
    if (method is null)
    {
        Notify("serverRequest/resolved", new() { ["threadId"] = thread, ["requestId"] = request["id"]!.DeepClone() });
        Notify("item/agentMessage/delta", new() { ["threadId"] = thread, ["itemId"] = "message", ["delta"] = "Fixture task complete" });
        if (itemDiffOnly) Notify("item/completed", new() { ["threadId"] = thread, ["item"] = new JsonObject { ["id"] = "file-test", ["type"] = "fileChange", ["status"] = "completed",
            ["changes"] = new JsonArray(new JsonObject { ["path"] = "sample.txt", ["diff"] = "-old\n+fixture item diff\n" }) } });
        else Notify("turn/diff/updated", new() { ["threadId"] = thread, ["diff"] = "--- a/sample.txt\n+++ b/sample.txt\n+fixture change\n" });
        Notify("turn/completed", new() { ["threadId"] = thread, ["turn"] = new JsonObject { ["id"] = turn, ["status"] = "completed" } });
        turn = null;
        continue;
    }
    if (method == "initialized") continue;
    if (p?["model"]?.GetValue<string>() == "fixture-exit") return;
    if (method == "thread/start") thread = p?["model"]?.GetValue<string>() == "fixture-second" ? "thread-second" : "thread-test";
    if (method is "thread/resume" or "thread/read" && p?["threadId"]?.GetValue<string>() is { } resumedId) thread = resumedId;
    JsonObject result = method switch
    {
        "initialize" => new() { ["userAgent"] = "fixture" },
        "account/read" => new() { ["account"] = new JsonObject { ["type"] = "fixture" } },
        "model/list" => new() { ["data"] = new JsonArray(new JsonObject { ["id"] = "fixture", ["model"] = "fixture", ["displayName"] = "Test Runtime" }), ["nextCursor"] = null },
        "project/list" => new() { ["data"] = new JsonArray(new JsonObject { ["id"] = "fixture-project", ["name"] = "Fixture project",
            ["roots"] = new JsonArray(new JsonObject { ["path"] = Path.Combine(cwd, "second-project") }) }) },
        "thread/list" when p?.ContainsKey("cwd") != true => new() { ["data"] = new JsonArray(Thread()), ["nextCursor"] = null },
        "thread/list" => new() { ["data"] = new JsonArray(Thread(), new JsonObject { ["id"] = "outside-test", ["cwd"] = Path.GetTempPath() }), ["nextCursor"] = null },
        "thread/loaded/list" => new() { ["data"] = thread is null ? new JsonArray() : new JsonArray(thread) },
        "thread/backgroundTerminals/list" => new() { ["data"] = backgroundRunning ? new JsonArray(new JsonObject { ["processId"] = "fixture-only" }) : new JsonArray() },
        "thread/read" when p?["threadId"]?.GetValue<string>() == "outside-test" => new() { ["thread"] = new JsonObject { ["id"] = "outside-test", ["cwd"] = Path.GetTempPath() } },
        "thread/start" or "thread/resume" or "thread/read" => new() { ["thread"] = Thread() },
        "turn/start" => new() { ["turn"] = new JsonObject { ["id"] = "turn-test", ["status"] = "inProgress" } },
        "turn/steer" => new() { ["turnId"] = turn },
        _ => new()
    };
    Send(new() { ["id"] = request["id"]!.DeepClone(), ["result"] = result });
    if (method == "turn/start")
    {
        thread = p!["threadId"]!.GetValue<string>(); turn = "turn-test";
        itemDiffOnly = p["model"]?.GetValue<string>() == "fixture-item-diff";
        backgroundRunning = p["model"]?.GetValue<string>() == "fixture-background";
        Notify("turn/started", new() { ["threadId"] = thread, ["turn"] = new JsonObject { ["id"] = turn, ["status"] = "inProgress" } });
        var outside = p["model"]?.GetValue<string>() == "fixture-outside-file";
        Send(new() { ["id"] = 7, ["method"] = outside ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval", ["params"] = new JsonObject {
            ["threadId"] = thread, ["turnId"] = turn, ["itemId"] = "command", ["cwd"] = cwd, ["command"] = "fixture-only",
            ["grantRoot"] = outside ? Path.GetTempPath() : null } });
    }
    if (method == "turn/interrupt")
    {
        Notify("serverRequest/resolved", new() { ["threadId"] = thread, ["requestId"] = 7 });
        Notify("turn/completed", new() { ["threadId"] = thread, ["turn"] = new JsonObject { ["id"] = turn, ["status"] = "interrupted" } });
        turn = null;
    }
}
