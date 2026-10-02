using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.CodexHost;

public sealed class RemoteRuntime(Func<CodexHostSettings> settings) : IAsyncDisposable
{
    private RuntimeClient? _runtime;
    private readonly Dictionary<string, string> _threads = new();
    private readonly Dictionary<string, JsonObject> _newThreads = new();
    private readonly HashSet<string> _owned = new();
    private List<CodexProject> _projects = new();
    private CodexHostSettings _scope = new(false, [], AutoDiscover: false);
    private DateTimeOffset _catalogUpdated;
    private string? _lastThread;
    private bool _initialized;
    public event Action<JsonObject>? Message;
    public bool Running => _initialized && _runtime?.Running == true;
    public JsonArray PendingApprovals => _runtime?.PendingApprovals ?? new();

    public async Task OpenAsync(CancellationToken token)
    {
        var config = settings();
        if (!config.Enabled || !config.AutoDiscover && !config.Workspaces.Any(config.Allows))
            throw new InvalidDataException("remote_disabled");
        if (Running) return;
        await DisposeAsync();
        var root = config.Workspaces.FirstOrDefault(config.Allows)
            ?? (config.AutoDiscover ? CodexProjects.FromState().FirstOrDefault()?.Path : null)
            ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        _runtime = new RuntimeClient(RuntimeClient.FindExecutable(config), root);
        _runtime.Message += message => Message?.Invoke(message);
        await _runtime.InitializeAsync(token);
        _initialized = true;
        await RefreshCatalogAsync(token);
    }

    private async Task RefreshCatalogAsync(CancellationToken token)
    {
        var config = settings();
        var projects = new List<CodexProject>();
        if (config.AutoDiscover)
        {
            // The native project API is preferred; older CLI versions fall back to desktop project metadata.
            foreach (var project in CodexProjects.FromState())
                CodexProjects.Add(projects, project.Path, project.Name, project.Id);
            var native = await _runtime!.CallAsync("project/list", new JsonObject(), token);
            if (native["result"]?["data"] is JsonArray data)
                foreach (var item in data.OfType<JsonObject>().Take(128))
                    if (item["roots"] is JsonArray roots)
                        foreach (var root in roots.OfType<JsonObject>().Take(8))
                            CodexProjects.Add(projects, root["path"]?.GetValue<string>(),
                                item["name"]?.GetValue<string>(), item["id"]?.GetValue<string>());
            // Include recent projectless chats and worktrees, across the user's configured providers.
            var recent = await _runtime.CallAsync("thread/list", new JsonObject {
                ["limit"] = 50, ["sortKey"] = "updated_at", ["modelProviders"] = new JsonArray(),
                ["sourceKinds"] = new JsonArray("cli", "vscode", "appServer", "unknown") }, token);
            if (recent["result"]?["data"] is JsonArray threads)
                foreach (var item in threads.OfType<JsonObject>())
                    CodexProjects.Add(projects, item["cwd"]?.GetValue<string>());
        }
        foreach (var path in config.Workspaces) CodexProjects.Add(projects, path);
        _projects = projects;
        _scope = config with { Workspaces = projects.Select(project => project.Path).ToArray(), AutoDiscover = false };
        _catalogUpdated = DateTimeOffset.UtcNow;
    }

    private void RequireWorkspace(string? cwd)
    {
        if (!_scope.Allows(cwd)) throw new InvalidDataException("workspace_not_allowed");
    }

    private void RequireControl(string thread)
    {
        if (!_owned.Contains(thread) && CodexProjects.DesktopOwns(thread))
            throw new InvalidDataException("desktop_session_busy");
    }

    private JsonObject Summary(JsonObject thread)
    {
        var cwd = thread["cwd"]?.GetValue<string>();
        var project = _projects.Where(project => cwd is not null &&
            (project.Path.Equals(cwd, StringComparison.OrdinalIgnoreCase) ||
             cwd.StartsWith(project.Path + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(project => project.Path.Length).FirstOrDefault();
        var id = thread["id"]!.GetValue<string>();
        var control = _owned.Contains(id) ? "remote" : CodexProjects.DesktopOwns(id) ? "desktop" : "available";
        string Short(string key, int max) { var value = thread[key]?.GetValue<string>() ?? ""; return value.Length > max ? value[..max] : value; }
        return new JsonObject {
            ["id"] = id, ["name"] = Short("name", 160), ["preview"] = Short("preview", 160),
            ["cwd"] = cwd, ["createdAt"] = thread["createdAt"]?.DeepClone(), ["updatedAt"] = thread["updatedAt"]?.DeepClone(),
            ["status"] = thread["status"]?.DeepClone(), ["control"] = control,
            ["projectPath"] = project?.Path ?? cwd, ["projectName"] = project?.Name ?? Path.GetFileName(cwd),
        };
    }

    private static JsonArray BoundedTurns(JsonArray turns)
    {
        // Keep UI-relevant text and tool items. Hidden reasoning and raw image/file data are not relayed.
        var result = new JsonArray();
        foreach (var turn in turns.OfType<JsonObject>())
        {
            var items = new JsonArray();
            foreach (var item in (turn["items"] as JsonArray ?? new()).OfType<JsonObject>().TakeLast(80))
            {
                var type = item["type"]?.GetValue<string>();
                if (type is not ("userMessage" or "agentMessage" or "plan" or "commandExecution" or "fileChange")) continue;
                var copy = (JsonObject)item.DeepClone();
                void Clip(JsonNode? node)
                {
                    if (node is JsonObject obj)
                        foreach (var key in obj.Select(pair => pair.Key).ToArray())
                        {
                            if (obj[key] is JsonValue value && value.TryGetValue<string>(out var text) && text.Length > 8000)
                                obj[key] = text[..8000] + "\n…内容较长，请在电脑查看完整输出";
                            else Clip(obj[key]);
                        }
                    else if (node is JsonArray array) foreach (var child in array) Clip(child);
                }
                Clip(copy); items.Add(copy);
                if (items.ToJsonString().Length > 100000) { items.RemoveAt(items.Count - 1); break; }
            }
            result.Add(new JsonObject { ["id"] = turn["id"]?.DeepClone(), ["status"] = turn["status"]?.DeepClone(),
                ["items"] = items, ["error"] = turn["error"] is null ? null : new JsonObject { ["message"] = "本轮任务未完成，请查看本机状态。" } });
            if (result.ToJsonString().Length > 240000) { result.RemoveAt(result.Count - 1); break; }
        }
        return result;
    }

    private async Task<JsonObject> ReadThreadAsync(string id, bool history, CancellationToken token)
    {
        if (_newThreads.TryGetValue(id, out var empty)) return Summary(empty);
        var response = await _runtime!.CallAsync("thread/read", new JsonObject { ["threadId"] = id, ["includeTurns"] = false }, token);
        if (response["result"]?["thread"] is not JsonObject native) throw new IOException("thread_unavailable");
        RequireWorkspace(native["cwd"]?.GetValue<string>());
        var thread = Summary(native);
        if (history)
        {
            var turns = await _runtime.CallAsync("thread/turns/list", new JsonObject {
                ["threadId"] = id, ["limit"] = 8, ["itemsView"] = "full", ["sortDirection"] = "desc" }, token);
            if (turns["result"]?["data"] is JsonArray data)
            {
                var recent = BoundedTurns(data); // Server lists newest first; preserve the newest items under the size cap.
                thread["turns"] = new JsonArray(recent.Reverse().Select(item => item?.DeepClone()).ToArray());
                thread["historyTruncated"] = turns["result"]?["nextCursor"] is not null || recent.Count < data.Count;
            }
            else
            {
                // Compatibility for Runtime versions without paginated history.
                var full = await _runtime.CallAsync("thread/read", new JsonObject { ["threadId"] = id, ["includeTurns"] = true }, token);
                thread["turns"] = BoundedTurns(new JsonArray((full["result"]?["thread"]?["turns"] as JsonArray ?? new())
                    .Reverse().Take(8).Select(item => item?.DeepClone()).ToArray()));
                thread["turns"] = new JsonArray(thread["turns"]!.AsArray().Reverse().Select(item => item?.DeepClone()).ToArray());
                thread["historyTruncated"] = true;
            }
        }
        return thread;
    }

    public async Task<JsonObject?> HandleAsync(JsonObject request, CancellationToken token)
    {
        if (!Running) throw new IOException("runtime_unavailable");
        var config = settings();
        if (!config.Enabled) throw new InvalidDataException("remote_disabled");
        if (!request.ContainsKey("method"))
        {
            var key = CodexRemoteProtocol.Id(request);
            var pending = _runtime!.PendingApprovals.OfType<JsonObject>().FirstOrDefault(item => CodexRemoteProtocol.Id(item) == key);
            if (request["result"]?["decision"]?.GetValue<string>() == "accept" &&
                pending?["method"]?.GetValue<string>() == "item/fileChange/requestApproval" &&
                pending["params"]?["grantRoot"] is { } root && !_scope.Allows(root.GetValue<string>()))
                throw new InvalidDataException("workspace_not_allowed");
            await _runtime.DecideAsync(request, token); return null;
        }
        var method = CodexRemoteProtocol.ValidateRequest(request);
        var parameters = (JsonObject)request["params"]!.DeepClone();
        JsonObject Reply(JsonObject value) => new() { ["id"] = request["id"]!.DeepClone(), ["result"] = value };
        if (method == "lanpower/status")
        {
            if (DateTimeOffset.UtcNow - _catalogUpdated > TimeSpan.FromSeconds(30)) await RefreshCatalogAsync(token);
            var account = await _runtime!.CallAsync("account/read", new JsonObject { ["refreshToken"] = false }, token);
            return Reply(new JsonObject {
                ["workspaces"] = new JsonArray(_projects.Select(project => JsonValue.Create(project.Path)).ToArray()),
                ["projects"] = new JsonArray(_projects.Select(project => (JsonNode)new JsonObject {
                    ["name"] = project.Name, ["path"] = project.Path, ["id"] = project.Id }).ToArray()),
                ["autoDiscover"] = config.AutoDiscover, ["loggedIn"] = account["result"]?["account"] is not null,
                ["pendingApprovals"] = _runtime.PendingApprovals, ["activeThread"] = _runtime.ActiveThread ?? _lastThread,
                ["activeTurn"] = _runtime.ActiveTurn, ["diff"] = _runtime.Diff.Length > 262144 ? _runtime.Diff[..262144] : _runtime.Diff });
        }
        string? cwd = null;
        var threadId = parameters["threadId"]?.GetValue<string>();
        if (threadId is not null)
        {
            if (!_threads.TryGetValue(threadId, out cwd))
            {
                var read = await ReadThreadAsync(threadId, false, token);
                cwd = read["cwd"]?.GetValue<string>();
            }
            RequireWorkspace(cwd);
            _threads[threadId] = cwd!;
            if (method == "thread/read")
                return Reply(new JsonObject { ["thread"] = await ReadThreadAsync(threadId, parameters["includeTurns"]?.GetValue<bool>() == true, token) });
            RequireControl(threadId);
        }
        if (method == "thread/list")
        {
            var selected = parameters["cwd"]?.GetValue<string>();
            if (selected is not null) RequireWorkspace(selected);
            var limit = parameters["limit"]?.GetValue<int>() ?? 30;
            parameters["limit"] = limit; parameters["sortKey"] = "updated_at";
            parameters["modelProviders"] = new JsonArray();
            parameters["sourceKinds"] = new JsonArray("cli", "vscode", "appServer", "unknown");
            var data = new JsonArray(); JsonNode? next = null;
            // Filter locally before relaying, while retaining the native cursor across excluded sessions.
            for (var page = 0; page < 5 && data.Count < limit; page++)
            {
                var response = await _runtime!.CallAsync(method, parameters, token);
                if (response["error"] is not null) { response["id"] = request["id"]!.DeepClone(); return response; }
                if (response["result"]?["data"] is JsonArray native)
                    foreach (var item in native.OfType<JsonObject>())
                        if (_scope.Allows(item["cwd"]?.GetValue<string>()) &&
                            (selected is null || CodexHostSettings.Canonical(item["cwd"]!.GetValue<string>()).Equals(
                                CodexHostSettings.Canonical(selected), StringComparison.OrdinalIgnoreCase)))
                        { data.Add(Summary(item)); _threads[item["id"]!.GetValue<string>()] = item["cwd"]!.GetValue<string>(); }
                next = response["result"]?["nextCursor"]?.DeepClone();
                if (next is null) break;
                parameters["cursor"] = next.DeepClone(); parameters["limit"] = limit - data.Count;
            }
            if (!request["params"]!.AsObject().ContainsKey("cursor"))
                foreach (var empty in _newThreads.Values.Where(item => selected is null || item["cwd"]?.GetValue<string>() == selected))
                    if (!data.Any(item => item?["id"]?.GetValue<string>() == empty["id"]?.GetValue<string>())) data.Insert(0, Summary(empty));
            return Reply(new JsonObject { ["data"] = data, ["nextCursor"] = next });
        }
        if (method == "thread/start")
        {
            cwd = parameters["cwd"]?.GetValue<string>(); RequireWorkspace(cwd);
            parameters["cwd"] = CodexHostSettings.Canonical(cwd!);
        }
        if (method == "turn/start" && _runtime!.ActiveTurn is not null) throw new InvalidDataException("task_running");
        if (method is "turn/steer" or "turn/interrupt")
        {
            var expected = parameters[method == "turn/steer" ? "expectedTurnId" : "turnId"]?.GetValue<string>();
            if (_runtime!.ActiveThread != threadId || _runtime.ActiveTurn is null || expected != _runtime.ActiveTurn)
                throw new InvalidDataException("turn_changed");
        }
        if (method is "thread/start" or "thread/resume")
        { parameters["approvalPolicy"] = "on-request"; parameters["sandbox"] = "workspace-write"; parameters["excludeTurns"] = true; }
        if (method == "thread/resume" && _newThreads.TryGetValue(threadId!, out var newThread))
            return Reply(new JsonObject { ["thread"] = Summary(newThread) });
        if (method == "turn/start")
        {
            _newThreads.Remove(threadId!);
            parameters["approvalPolicy"] = "on-request"; parameters["cwd"] = cwd;
            parameters["sandboxPolicy"] = new JsonObject { ["type"] = "workspaceWrite", ["networkAccess"] = false,
                ["excludeTmpdirEnvVar"] = true, ["excludeSlashTmp"] = true, ["writableRoots"] = new JsonArray(cwd) };
        }
        var result = await _runtime!.CallAsync(method, parameters, token);
        result["id"] = request["id"]!.DeepClone();
        if (result["result"]?["thread"] is JsonObject created && created["id"]?.GetValue<string>() is { } createdId &&
            created["cwd"]?.GetValue<string>() is { } createdCwd)
        {
            RequireWorkspace(createdCwd);
            _threads[createdId] = createdCwd; _owned.Add(createdId); _lastThread = createdId;
            if (method == "thread/start")
            {
                if (_newThreads.Count >= 32) _newThreads.Remove(_newThreads.Keys.First());
                _newThreads[createdId] = (JsonObject)created.DeepClone();
                result["result"]!["thread"] = Summary(created);
            }
            else result["result"]!["thread"] = await ReadThreadAsync(createdId, true, token);
        }
        return result;
    }

    public Task ExpireAsync(CancellationToken token) => _runtime?.ExpireApprovalsAsync(token) ?? Task.CompletedTask;
    public async ValueTask DisposeAsync()
    {
        _initialized = false; if (_runtime is not null) await _runtime.DisposeAsync(); _runtime = null;
        _threads.Clear(); _newThreads.Clear(); _owned.Clear(); _projects.Clear(); _lastThread = null;
    }
}
