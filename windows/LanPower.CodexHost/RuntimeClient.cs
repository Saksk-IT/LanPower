using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Net.WebSockets;
using System.Text;
using LanPower.Shared;

namespace LanPower.CodexHost;

public sealed class RuntimeClient : IAsyncDisposable
{
    private readonly Process? _process;
    private readonly RuntimeJob? _job;
    private readonly ClientWebSocket? _socket;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _write = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonObject>> _calls = new();
    private readonly ConcurrentDictionary<string, (JsonObject Request, DateTimeOffset Time, JsonNode NativeId)> _approvals = new();
    private readonly ConcurrentDictionary<string, JsonObject> _resolvedApprovals = new();
    private readonly Dictionary<string, Dictionary<string, string>> _fileDiffs = new();
    private readonly HashSet<string> _aggregatedDiffs = new();
    private readonly Task _reader;
    private readonly Task _stderr;
    // Local history may be larger than a Relay frame; RemoteRuntime returns a bounded recent view.
    private const int LocalFrameLimit = 8 * 1024 * 1024;
    public event Action<JsonObject>? Message;
    public string? ActiveThread { get; private set; }
    public string? ActiveTurn { get; private set; }
    public ConcurrentDictionary<string, string> ActiveTurns { get; } = new();
    public ConcurrentDictionary<string, string> ThreadDiffs { get; } = new();
    public string Diff { get; private set; } = "";
    public bool Shared => _socket is not null;
    public bool Running => (_socket?.State == WebSocketState.Open || _process is { HasExited: false }) && !_reader.IsCompleted;
    public JsonArray PendingApprovals => new(_approvals.Values.Select(value => value.Request.DeepClone()).ToArray());
    private static readonly HashSet<string> Notifications = ["thread/started", "thread/status/changed", "turn/started",
        "turn/completed", "turn/diff/updated", "turn/plan/updated", "item/started", "item/completed",
        "item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta",
        "item/fileChange/outputDelta", "serverRequest/resolved", "thread/queue/changed", "error"];

    private RuntimeClient(ClientWebSocket socket)
    {
        _socket = socket; _stderr = Task.CompletedTask; _reader = ReadAsync();
    }

    public static async Task<RuntimeClient> ConnectAsync(Uri endpoint, string bearer, CancellationToken token)
    {
        if (endpoint.Scheme != "ws" || endpoint.Host != "127.0.0.1" || !string.IsNullOrEmpty(endpoint.UserInfo) ||
            bearer.Length != 64 || !bearer.All(Uri.IsHexDigit)) throw new InvalidDataException("invalid_shared_endpoint");
        var socket = new ClientWebSocket(); socket.Options.SetRequestHeader("Authorization", "Bearer " + bearer);
        try { await socket.ConnectAsync(endpoint, token); return new(socket); }
        catch (WebSocketException error) { socket.Dispose(); throw new IOException("shared_runtime_unavailable", error); }
        catch { socket.Dispose(); throw; }
    }

    public RuntimeClient(string executable, string cwd)
    {
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
            WorkingDirectory = cwd, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new System.Text.UTF8Encoding(false),
            StandardOutputEncoding = new System.Text.UTF8Encoding(false, true),
            StandardErrorEncoding = new System.Text.UTF8Encoding(false) };
        start.ArgumentList.Add("app-server"); start.ArgumentList.Add("--listen"); start.ArgumentList.Add("stdio://");
        foreach (var option in new[] { "approval_policy=\"on-request\"", "sandbox_mode=\"workspace-write\"" })
        { start.ArgumentList.Add("-c"); start.ArgumentList.Add(option); }
        _process = Process.Start(start) ?? throw new IOException("runtime_unavailable");
        try { _job = new RuntimeJob(_process.Handle); }
        catch { if (!_process.HasExited) _process.Kill(true); _process.Dispose(); throw; }
        _reader = ReadAsync();
        // Consume stderr in bounded buffers; do not store it or log it.
        _stderr = Task.Run(async () =>
        {
            var buffer = new char[4096];
            try { while (await _process.StandardError.ReadAsync(buffer.AsMemory(), _lifetime.Token) > 0) { } }
            catch (OperationCanceledException) { }
        });
    }

    public static string FindExecutable(CodexHostSettings settings)
    {
        var custom = string.IsNullOrWhiteSpace(settings.Executable) ? Environment.GetEnvironmentVariable("LANPOWER_CODEX_BIN") : settings.Executable;
        if (!string.IsNullOrEmpty(custom) && Path.IsPathFullyQualified(custom) && File.Exists(custom) &&
            Path.GetExtension(custom).Equals(".exe", StringComparison.OrdinalIgnoreCase)) return custom;
        foreach (var folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            var path = Path.Combine(folder, "codex.exe");
            if (File.Exists(path)) return Path.GetFullPath(path);
        }
        var installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenAI", "Codex", "bin");
        if (Directory.Exists(installed))
        {
            var found = Directory.EnumerateFiles(installed, "codex.exe", SearchOption.AllDirectories)
                .OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
            if (found is not null) return found;
        }
        throw new IOException("codex_not_installed");
    }

    public async Task InitializeAsync(CancellationToken token)
    {
        var response = await CallAsync("initialize", new JsonObject { ["clientInfo"] = new JsonObject {
            ["name"] = "lanpower_remote", ["title"] = "LanPower Remote", ["version"] = LanProtocol.Version },
            ["capabilities"] = new JsonObject { ["experimentalApi"] = true } }, token);
        if (response["error"] is not null) throw new InvalidDataException("runtime_incompatible");
        await SendAsync(new JsonObject { ["method"] = "initialized", ["params"] = new JsonObject() }, token);
    }

    public async Task<JsonObject> CallAsync(string method, JsonObject parameters, CancellationToken token)
    {
        var id = "lp-internal-" + Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        _calls[id] = completion;
        try
        {
            await SendAsync(new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters.DeepClone() }, token);
            var result = await completion.Task.WaitAsync(TimeSpan.FromSeconds(30), token);
            return result;
        }
        finally { _calls.TryRemove(id, out _); }
    }

    private async Task ReadAsync()
    {
        try
        {
            while (await ReadFrameAsync(_lifetime.Token) is { } raw)
            {
                var message = CodexRemoteProtocol.Parse(raw, LocalFrameLimit);
                if (message["id"] is JsonValue id && id.TryGetValue<string>(out var value) &&
                    _calls.TryRemove(value, out var completion))
                { completion.TrySetResult(message); continue; }
                var method = message["method"]?.GetValue<string>();
                if (method is null) continue;
                if (message.ContainsKey("id"))
                {
                    if (!CodexRemoteProtocol.ApprovalMethods.Contains(method) || _approvals.Count >= 64)
                    {
                        if (Shared) continue; // Another subscribed client may handle this native request.
                        await SendAsync(new JsonObject { ["id"] = message["id"]!.DeepClone(),
                            ["error"] = new JsonObject { ["code"] = -32601, ["message"] = "unsupported_request" } }, _lifetime.Token);
                        continue;
                    }
                    // Independent session workers may receive the same native numeric request ID.
                    // Give Relay a unique ID and restore the native ID only on this connection.
                    var nativeId = message["id"]!.DeepClone();
                    message["id"] = "lp-approval-" + Guid.NewGuid().ToString("N");
                    _approvals[CodexRemoteProtocol.Id(message)] = (message, DateTimeOffset.UtcNow, nativeId);
                }
                else if (!Notifications.Contains(method)) continue;
                var parameters = message["params"] as JsonObject;
                if (parameters?["item"]?["type"]?.GetValue<string>() == "reasoning") continue;
                var diffThread = parameters?["threadId"]?.GetValue<string>();
                if (method == "turn/started")
                {
                    ActiveThread = parameters?["threadId"]?.GetValue<string>(); ActiveTurn = parameters?["turn"]?["id"]?.GetValue<string>();
                    if (ActiveThread is not null && ActiveTurn is not null) ActiveTurns[ActiveThread] = ActiveTurn;
                    Diff = "";
                    if (ActiveThread is not null)
                    {
                        if (ThreadDiffs.Count >= 32 && ThreadDiffs.Keys.FirstOrDefault(key => !ActiveTurns.ContainsKey(key)) is { } old)
                        { ThreadDiffs.TryRemove(old, out _); _fileDiffs.Remove(old); _aggregatedDiffs.Remove(old); }
                        ThreadDiffs[ActiveThread] = ""; _fileDiffs.Remove(ActiveThread); _aggregatedDiffs.Remove(ActiveThread);
                    }
                }
                if (method == "turn/completed")
                {
                    var threadId = parameters?["threadId"]?.GetValue<string>();
                    var turnId = parameters?["turn"]?["id"]?.GetValue<string>();
                    if (threadId is not null && ActiveTurns.GetValueOrDefault(threadId) == turnId) ActiveTurns.TryRemove(threadId, out _);
                    if (ActiveThread == threadId && ActiveTurn == turnId) ActiveTurn = null;
                    foreach (var pending in _approvals.Where(pair => pair.Value.Request["params"]?["threadId"]?.GetValue<string>() == threadId &&
                        pair.Value.Request["params"]?["turnId"]?.GetValue<string>() == turnId)) _approvals.TryRemove(pending.Key, out _);
                    foreach (var decided in _resolvedApprovals.Where(pair => pair.Value["params"]?["threadId"]?.GetValue<string>() == threadId &&
                        pair.Value["params"]?["turnId"]?.GetValue<string>() == turnId)) _resolvedApprovals.TryRemove(decided.Key, out _);
                }
                if (method == "turn/diff/updated" && diffThread is not null)
                {
                    var diff = parameters?["diff"]?.GetValue<string>() ?? "";
                    ThreadDiffs[diffThread] = diff.Length > 262144 ? diff[..262144] : diff;
                    _aggregatedDiffs.Add(diffThread); if (diffThread == ActiveThread) Diff = ThreadDiffs[diffThread];
                }
                if (method == "item/completed" && parameters?["item"] is JsonObject item &&
                    item["type"]?.GetValue<string>() == "fileChange" && item["status"]?.GetValue<string>() == "completed" &&
                    item["id"]?.GetValue<string>() is { } itemId && item["changes"] is JsonArray changes && diffThread is not null)
                {
                    if (!_fileDiffs.TryGetValue(diffThread, out var files)) _fileDiffs[diffThread] = files = new();
                    if (files.Count >= 32) files.Remove(files.Keys.First());
                    var fileDiff = string.Join("\n", changes.OfType<JsonObject>().Select(change =>
                        $"文件：{change["path"]?.GetValue<string>()}\n{change["diff"]?.GetValue<string>()}"));
                    files[itemId] = fileDiff.Length > 262144 ? fileDiff[..262144] : fileDiff;
                    // Some Runtime/workspace combinations emit item diffs without an aggregate notification.
                    var combined = string.Join("\n", files.Values);
                    if (!_aggregatedDiffs.Contains(diffThread)) ThreadDiffs[diffThread] = combined.Length > 262144 ? combined[..262144] : combined;
                    if (diffThread == ActiveThread) Diff = ThreadDiffs.GetValueOrDefault(diffThread, "");
                }
                if (method == "serverRequest/resolved" && parameters?["requestId"] is { } resolved)
                {
                    var pending = _approvals.FirstOrDefault(pair => pair.Value.NativeId.ToJsonString() == resolved.ToJsonString());
                    if (pending.Key is not null)
                    {
                        parameters["requestId"] = pending.Value.Request["id"]!.DeepClone();
                        parameters["threadId"] = pending.Value.Request["params"]?["threadId"]?.DeepClone();
                        parameters["turnId"] = pending.Value.Request["params"]?["turnId"]?.DeepClone();
                        _approvals.TryRemove(pending.Key, out _);
                    }
                    else if (_resolvedApprovals.TryRemove(resolved.ToJsonString(), out var decided))
                    {
                        parameters["requestId"] = decided["id"]!.DeepClone();
                        parameters["threadId"] = decided["params"]?["threadId"]?.DeepClone();
                        parameters["turnId"] = decided["params"]?["turnId"]?.DeepClone();
                    }
                }
                Message?.Invoke(message);
            }
        }
        catch (Exception error) when (error is IOException or InvalidDataException or OperationCanceledException or InvalidOperationException or WebSocketException) { }
        finally
        {
            foreach (var call in _calls.Values) call.TrySetException(new IOException("runtime_exited"));
            _approvals.Clear();
            _resolvedApprovals.Clear();
        }
    }

    private async Task<string?> ReadFrameAsync(CancellationToken token)
    {
        if (_socket is null) return await CodexRemoteProtocol.ReadLineAsync(_process!.StandardOutput, token, LocalFrameLimit);
        using var data = new MemoryStream(); var buffer = new byte[16384];
        while (true)
        {
            var received = await _socket.ReceiveAsync(buffer.AsMemory(), token);
            if (received.MessageType == WebSocketMessageType.Close) return null;
            if (received.MessageType != WebSocketMessageType.Text || data.Length + received.Count > LocalFrameLimit)
                throw new InvalidDataException("frame_too_large");
            data.Write(buffer, 0, received.Count);
            if (received.EndOfMessage) return new UTF8Encoding(false, true).GetString(data.GetBuffer(), 0, (int)data.Length);
        }
    }

    public void ObserveThread(JsonObject thread)
    {
        if (thread["id"]?.GetValue<string>() is not { } id) return;
        var active = (thread["turns"] as JsonArray)?.OfType<JsonObject>().LastOrDefault(turn =>
            turn["status"]?.GetValue<string>() == "inProgress")?["id"]?.GetValue<string>();
        if (active is not null) ActiveTurns[id] = active;
        else if (thread["status"]?["type"]?.GetValue<string>() is "idle" or "notLoaded") ActiveTurns.TryRemove(id, out _);
    }

    public async Task DecideAsync(JsonObject response, CancellationToken token)
    {
        var key = CodexRemoteProtocol.Id(response);
        if (response.Count != 2 || response["result"] is not JsonObject result ||
            !_approvals.TryGetValue(key, out var pending)) throw new InvalidDataException("approval_unavailable");
        var method = pending.Request["method"]!.GetValue<string>();
        if (method is "item/commandExecution/requestApproval" or "item/fileChange/requestApproval")
        {
            if (result.Count != 1 || result["decision"]?.GetValue<string>() is not ("accept" or "decline" or "cancel"))
                throw new InvalidDataException("invalid_decision");
        }
        else if (method == "item/permissions/requestApproval")
        {
            // MVP never extends filesystem access or grants persistent session permissions.
            if (result.Any(pair => pair.Key is not ("permissions" or "scope")) ||
                result["scope"]?.GetValue<string>() is not (null or "turn") || result["permissions"] is not JsonObject permissions ||
                permissions.Any(pair => pair.Key != "network") || permissions.ContainsKey("network") && permissions["network"] is not JsonObject ||
                permissions["network"] is JsonObject network &&
                (network.Count != 1 || network["enabled"]?.GetValue<bool>() != true ||
                 pending.Request["params"]?["permissions"]?["network"]?["enabled"]?.GetValue<bool>() != true))
                throw new InvalidDataException("invalid_permissions");
        }
        else if (method == "item/tool/requestUserInput")
        {
            if (result.Count != 1 || result["answers"] is not JsonObject answers || answers.Count > 20)
                throw new InvalidDataException("invalid_answers");
            foreach (var answer in answers)
                if (answer.Value is not JsonObject { Count: 1 } entry || entry["answers"] is not JsonArray { Count: <= 20 } texts ||
                    texts.Any(text => text is not JsonValue v || !v.TryGetValue<string>(out var s) || s.Length > 4000))
                    throw new InvalidDataException("invalid_answers");
        }
        else if (result["action"]?.GetValue<string>() is not ("decline" or "cancel") ||
                 result.Any(pair => pair.Key is not ("action" or "content")) || result["content"] is not null)
            throw new InvalidDataException("unsupported_elicitation");
        if (!_approvals.TryRemove(key, out _)) throw new InvalidDataException("approval_unavailable");
        if (_resolvedApprovals.Count >= 64 && _resolvedApprovals.Keys.FirstOrDefault() is { } oldest) _resolvedApprovals.TryRemove(oldest, out _);
        _resolvedApprovals[pending.NativeId.ToJsonString()] = (JsonObject)pending.Request.DeepClone();
        var nativeResponse = (JsonObject)response.DeepClone();
        nativeResponse["id"] = pending.NativeId.DeepClone();
        await SendAsync(nativeResponse, token);
    }

    public async Task ExpireApprovalsAsync(CancellationToken token)
    {
        foreach (var entry in _approvals.Where(pair => DateTimeOffset.UtcNow - pair.Value.Time > TimeSpan.FromMinutes(5)))
        {
            var method = entry.Value.Request["method"]!.GetValue<string>();
            JsonObject result = method switch
            {
                "item/permissions/requestApproval" => new() { ["permissions"] = new JsonObject(), ["scope"] = "turn" },
                "item/tool/requestUserInput" => new() { ["answers"] = new JsonObject() },
                "mcpServer/elicitation/request" => new() { ["action"] = "decline", ["content"] = null },
                _ => new() { ["decision"] = "decline" }
            };
            await DecideAsync(new JsonObject { ["id"] = entry.Value.Request["id"]!.DeepClone(), ["result"] = result }, token);
        }
    }

    private async Task SendAsync(JsonObject message, CancellationToken token)
    {
        var raw = message.ToJsonString(CodexRemoteProtocol.JsonOptions);
        if (System.Text.Encoding.UTF8.GetByteCount(raw) > CodexRemoteProtocol.MaxFrame) throw new InvalidDataException("frame_too_large");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        await _write.WaitAsync(deadline.Token);
        try
        {
            if (_socket is not null) await _socket.SendAsync(Encoding.UTF8.GetBytes(raw).AsMemory(), WebSocketMessageType.Text, true, deadline.Token);
            else { await _process!.StandardInput.WriteLineAsync(raw.AsMemory(), deadline.Token); await _process.StandardInput.FlushAsync(deadline.Token); }
        }
        finally { _write.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        _socket?.Abort();
        if (_process is { HasExited: false }) _process.Kill(true);
        _job?.Dispose();
        try { await Task.WhenAll(_reader, _stderr); } catch (OperationCanceledException) { }
        _socket?.Dispose(); _process?.Dispose(); _lifetime.Dispose();
    }
}
