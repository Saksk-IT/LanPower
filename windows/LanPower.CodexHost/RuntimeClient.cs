using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.CodexHost;

public sealed class RuntimeClient : IAsyncDisposable
{
    private readonly Process _process;
    private readonly RuntimeJob _job;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _write = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonObject>> _calls = new();
    private readonly ConcurrentDictionary<string, (JsonObject Request, DateTimeOffset Time)> _approvals = new();
    private readonly Dictionary<string, string> _fileDiffs = new();
    private bool _aggregatedDiff;
    private readonly Task _reader;
    private readonly Task _stderr;
    public event Action<JsonObject>? Message;
    public string? ActiveThread { get; private set; }
    public string? ActiveTurn { get; private set; }
    public string Diff { get; private set; } = "";
    public bool Running => !_process.HasExited && !_reader.IsCompleted;
    public JsonArray PendingApprovals => new(_approvals.Values.Select(value => value.Request.DeepClone()).ToArray());
    private static readonly HashSet<string> Notifications = ["thread/started", "thread/status/changed", "turn/started",
        "turn/completed", "turn/diff/updated", "turn/plan/updated", "item/started", "item/completed",
        "item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta",
        "item/fileChange/outputDelta", "serverRequest/resolved", "error"];

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
            ["name"] = "lanpower_remote", ["title"] = "LanPower Remote", ["version"] = LanProtocol.Version } }, token);
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
            while (await CodexRemoteProtocol.ReadLineAsync(_process.StandardOutput, _lifetime.Token) is { } raw)
            {
                var message = CodexRemoteProtocol.Parse(raw);
                if (message["id"] is JsonValue id && id.TryGetValue<string>(out var value) &&
                    _calls.TryRemove(value, out var completion))
                { completion.TrySetResult(message); continue; }
                var method = message["method"]?.GetValue<string>();
                if (method is null) continue;
                if (message.ContainsKey("id"))
                {
                    if (!CodexRemoteProtocol.ApprovalMethods.Contains(method) || _approvals.Count >= 64)
                    {
                        await SendAsync(new JsonObject { ["id"] = message["id"]!.DeepClone(),
                            ["error"] = new JsonObject { ["code"] = -32601, ["message"] = "unsupported_request" } }, _lifetime.Token);
                        continue;
                    }
                    _approvals[CodexRemoteProtocol.Id(message)] = (message, DateTimeOffset.UtcNow);
                }
                else if (!Notifications.Contains(method)) continue;
                var parameters = message["params"] as JsonObject;
                if (method == "turn/started")
                { ActiveThread = parameters?["threadId"]?.GetValue<string>(); ActiveTurn = parameters?["turn"]?["id"]?.GetValue<string>(); Diff = ""; _fileDiffs.Clear(); _aggregatedDiff = false; }
                if (method == "turn/completed")
                { ActiveTurn = null; _approvals.Clear(); }
                if (method == "turn/diff/updated") { Diff = parameters?["diff"]?.GetValue<string>() ?? ""; _aggregatedDiff = true; }
                if (method == "item/completed" && parameters?["item"] is JsonObject item &&
                    item["type"]?.GetValue<string>() == "fileChange" && item["status"]?.GetValue<string>() == "completed" &&
                    item["id"]?.GetValue<string>() is { } itemId && item["changes"] is JsonArray changes)
                {
                    if (_fileDiffs.Count >= 32) _fileDiffs.Remove(_fileDiffs.Keys.First());
                    var fileDiff = string.Join("\n", changes.OfType<JsonObject>().Select(change =>
                        $"文件：{change["path"]?.GetValue<string>()}\n{change["diff"]?.GetValue<string>()}"));
                    _fileDiffs[itemId] = fileDiff.Length > 262144 ? fileDiff[..262144] : fileDiff;
                    // Some Runtime/workspace combinations emit item diffs without an aggregate notification.
                    var combined = string.Join("\n", _fileDiffs.Values);
                    if (!_aggregatedDiff) Diff = combined.Length > 262144 ? combined[..262144] : combined;
                }
                if (method == "serverRequest/resolved" && parameters?["requestId"] is { } resolved)
                    _approvals.TryRemove(resolved.ToJsonString(), out _);
                Message?.Invoke(message);
            }
        }
        catch (Exception error) when (error is IOException or OperationCanceledException or InvalidOperationException) { }
        finally
        {
            foreach (var call in _calls.Values) call.TrySetException(new IOException("runtime_exited"));
            _approvals.Clear();
        }
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
        await SendAsync(response, token);
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
        try { await _process.StandardInput.WriteLineAsync(raw.AsMemory(), deadline.Token); await _process.StandardInput.FlushAsync(deadline.Token); }
        finally { _write.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        if (!_process.HasExited) _process.Kill(true);
        _job.Dispose();
        try { await Task.WhenAll(_reader, _stderr); } catch (OperationCanceledException) { }
        _process.Dispose(); _lifetime.Dispose();
    }
}
