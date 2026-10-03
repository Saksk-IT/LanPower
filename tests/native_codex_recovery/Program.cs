using System.Text.Json.Nodes;
using System.Threading.Channels;
using LanPower.CodexHost;
using LanPower.Shared;

var workspace = Path.Combine(Path.GetTempPath(), "LanPowerP0Acceptance", Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(workspace);
using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(150)); var token = timeout.Token;
var events = Channel.CreateUnbounded<JsonObject>();
var settings = new CodexHostSettings(true,[workspace],AutoDiscover:false,DesktopControl:true);
var receipts = new RemoteSubmissionStore(Path.Combine(workspace,"receipts.json"));
RemoteRuntime NewRemote() { var value = new RemoteRuntime(()=>settings,submissions:receipts);value.Message += item=>events.Writer.TryWrite(item);return value; }
var remote = NewRemote(); RuntimeClient? native = null; string? threadId = null;
var report = new JsonObject { ["originalWindow"] = false, ["isolatedProject"] = true, ["network"] = "local desktop loopback; no physical sleep or 5G" };
JsonObject Call(string method,JsonObject? p=null) => new() { ["id"] = Guid.NewGuid().ToString("N"), ["method"] = method, ["params"] = p ?? new() };
JsonArray Input(string text) => new(new JsonObject { ["type"] = "text", ["text"] = text });
async Task<JsonObject> Request(string method,JsonObject? p=null)
{
    var response = await remote.HandleAsync(Call(method,p),token) ?? throw new Exception("missing_response");
    if (response["error"] is not null) throw new Exception(response["error"]?["code"]?.GetValue<int>() == -32601 ? "unsupported_native_method" : "native_rejected");
    return response["result"]!.AsObject();
}
async Task<JsonObject> Until(string method)
{
    while (true) {
        var message = await events.Reader.ReadAsync(token);var p = message["params"];
        if (p?["threadId"]?.GetValue<string>() != threadId) continue;
        if (message["method"]?.GetValue<string>() == "error" || message["method"]?.GetValue<string>() == "turn/completed" && p?["turn"]?["status"]?.GetValue<string>() == "failed")
            throw new Exception(p?.ToJsonString().Contains("quota",StringComparison.OrdinalIgnoreCase) == true || p?.ToJsonString().Contains("usage",StringComparison.OrdinalIgnoreCase) == true ? "native_quota_or_usage_blocked" : "native_task_failed");
        if (message["method"]?.GetValue<string>() == method) return message;
    }
}
try
{
    native = await RuntimeClient.ConnectDesktopAsync(token);await native.InitializeAsync(token);
    await remote.OpenAsync(token);report["originalWindow"] = true;
    var models = (await Request("model/list",new() { ["limit"] = 50 }))["data"]!.AsArray().OfType<JsonObject>().ToArray();
    var model = (models.FirstOrDefault(m=>m["isDefault"]?.GetValue<bool>()==true) ?? models[0]);
    var modelName = (model["model"] ?? model["id"])!.GetValue<string>();
    var created = await Request("thread/start",new() { ["cwd"] = workspace, ["model"] = modelName });threadId = created["thread"]!["id"]!.GetValue<string>();
    await Request("thread/read",new() { ["threadId"] = threadId, ["includeTurns"] = true });
    var submitId = Guid.NewGuid().ToString("N");
    var started = await Request("turn/start",new() { ["threadId"] = threadId, ["submissionId"] = submitId, ["mode"] = "plan", ["model"] = modelName,
        ["input"] = Input("这是隔离项目的控制恢复验收。请使用 request_user_input 工具询问颜色偏好，给出蓝色和绿色两个选项，收到答复后只回复验收完成。不要运行命令、联网、访问其他项目或修改文件。") });
    report["submissionAccepted"] = started["receipt"]?["state"]?.GetValue<string>() == "accepted";
    var turnId = started["turn"]!["id"]!.GetValue<string>();
    var question = await Until("item/tool/requestUserInput");report["nativeUserApprovalObserved"] = true;
    var added = await Request("thread/queue/add",new() { ["threadId"] = threadId, ["clientUserMessageId"] = Guid.NewGuid().ToString("N"), ["submissionId"] = Guid.NewGuid().ToString("N"), ["input"] = Input("仅回复排队已收到，不运行工具。") });
    var queue = (await Request("thread/queue/list",new() { ["threadId"] = threadId, ["limit"] = 32 }))["data"]!.AsArray();
    var queueId = queue[0]!["id"]!.GetValue<string>();
    await Request("thread/queue/update",new() { ["threadId"] = threadId, ["queuedSubmissionId"] = queueId, ["submissionId"] = Guid.NewGuid().ToString("N"), ["input"] = Input("仅回复修改后的排队，不运行工具。") });
    var nativeQueue = await native.CallAsync("thread/queue/list",new() { ["threadId"] = threadId, ["limit"] = 32 },token);
    report["queueAddUpdateMatchesDesktop"] = nativeQueue["result"]?["data"]?.AsArray().Count == 1 && nativeQueue["result"]!["data"]![0]!["input"]![0]!["text"]!.GetValue<string>() == "仅回复修改后的排队，不运行工具。";
    await Request("thread/queue/delete",new() { ["threadId"] = threadId, ["queuedSubmissionId"] = queueId });
    nativeQueue = await native.CallAsync("thread/queue/list",new() { ["threadId"] = threadId, ["limit"] = 32 },token);
    report["queueDeleteMatchesDesktop"] = nativeQueue["result"]?["data"]?.AsArray().Count == 0;
    // Drop only our transport. The original window remains responsible for the task.
    await remote.DisposeAsync();remote = NewRemote();await remote.OpenAsync(token);
    await Request("thread/read",new() { ["threadId"] = threadId, ["includeTurns"] = true });
    var restored = await Request("lanpower/status");report["restoredApprovalCount"] = restored["pendingApprovals"]!.AsArray().Count; report["restoredActiveCount"] = restored["activeTurns"]!.AsArray().Count;
    report["approvalAndTurnRestored"] = restored["pendingApprovals"]!.AsArray().Count == 1 && restored["activeTurns"]!.AsArray().Any(t=>t?["turnId"]?.GetValue<string>() == turnId);
    var nativeHistory = await native.CallAsync("thread/turns/list",new() { ["threadId"] = threadId,["limit"] = 1,["itemsView"] = "full",["sortDirection"] = "desc" },token);
    report["nativeLastStatus"] = nativeHistory["result"]?["data"]?[0]?["status"]?.DeepClone();
    var originalQuestion = restored["pendingApprovals"]![0]!.AsObject();
    await native.RefreshApprovalsAsync(token);
    var nativeQuestion = native.PendingApprovals.OfType<JsonObject>().First(p=>p["params"]?["threadId"]?.GetValue<string>()==threadId);
    var answerId = nativeQuestion["params"]!["questions"]![0]!["id"]!.GetValue<string>();
    await native.DecideAsync(new() { ["id"] = nativeQuestion["id"]!.DeepClone(), ["result"] = new JsonObject { ["answers"] = new JsonObject { [answerId] = new JsonObject { ["answers"] = new JsonArray("蓝色") } } } },token);
    restored = await Request("lanpower/status");report["desktopResolvedApprovalRemoved"] = restored["pendingApprovals"]!.AsArray().Count == 0;
    try { await remote.HandleAsync(new() { ["id"] = originalQuestion["id"]!.DeepClone(), ["result"] = new JsonObject { ["answers"] = new JsonObject() } },token); report["duplicateApprovalRejected"] = false; }
    catch (InvalidDataException) { report["duplicateApprovalRejected"] = true; }
    var done = await Until("turn/completed");report["nativeTaskCompleted"] = done["params"]!["turn"]!["status"]!.GetValue<string>() == "completed";
    started = await Request("turn/start",new() { ["threadId"] = threadId, ["submissionId"] = Guid.NewGuid().ToString("N"), ["mode"] = "plan", ["model"] = modelName,
        ["input"] = Input("隔离暂停验收：先使用 request_user_input 请求继续确认，在收到回答前保持等待。不要运行命令、联网、读取其他目录或修改文件。") });
    turnId = started["turn"]!["id"]!.GetValue<string>();await Until("item/tool/requestUserInput");
    await Request("turn/interrupt",new() { ["threadId"] = threadId, ["turnId"] = turnId });
    done = await Until("turn/completed");report["stopCorrectNativeTurn"] = done["params"]!["turn"]!["id"]!.GetValue<string>() == turnId && done["params"]!["turn"]!["status"]!.GetValue<string>() == "interrupted";
    report["receiptAfterReconnect"] = (await Request("lanpower/submission/read",new() { ["threadId"] = threadId, ["submissionId"] = submitId }))["state"]!.GetValue<string>() == "accepted";
    await Request("thread/archive",new() { ["threadId"] = threadId });report["archivedIsolatedThread"] = true;
    if (report.Any(pair => pair.Value is JsonValue value && value.TryGetValue<bool>(out var passed) && !passed))
        throw new Exception("native_validation_failed");
}
catch (Exception error) { report["failure"] = error is OperationCanceledException ? "native_validation_timeout" : error.Message.Length < 90 ? error.Message : "native_validation_failed";Environment.ExitCode = 1; }
finally
{
    if (threadId is not null && native?.Running == true) {
        try {using var cleanup=new CancellationTokenSource(8000);var history=await native.CallAsync("thread/turns/list",new() { ["threadId"] = threadId,["limit"] = 1,["itemsView"] = "full",["sortDirection"] = "desc" },cleanup.Token);
            var active=(history["result"]?["data"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault(t=>t["status"]?.GetValue<string>()=="inProgress")?["id"]?.GetValue<string>();
            if(active is not null)await native.CallAsync("turn/interrupt",new() { ["threadId"] = threadId,["turnId"] = active },cleanup.Token);
            await native.CallAsync("thread/archive",new() { ["threadId"] = threadId },cleanup.Token);
        }catch {report["cleanupNeedsCheck"] = true;}
    }
    await remote.DisposeAsync();if(native is not null)await native.DisposeAsync();
    var reportDirectory = Path.Combine("private","codex-remote-p0");Directory.CreateDirectory(reportDirectory);
    File.WriteAllText(Path.Combine(reportDirectory,"native-result.json"),report.ToJsonString());Console.WriteLine(report.ToJsonString());
}
