using System.Text.Json.Nodes;
using System.Collections.Concurrent;
using LanPower.Shared;

namespace LanPower.CodexHost;

public sealed class RemoteRuntime(Func<CodexHostSettings> settings, Func<CancellationToken, Task<RuntimeClient>>? sharedConnection = null) : IAsyncDisposable
{
    private RuntimeClient? _runtime;
    private readonly ConcurrentDictionary<string, string> _threads = new();
    private readonly ConcurrentDictionary<string, byte> _sharedThreads = new();
    private readonly ConcurrentDictionary<string, JsonObject> _newThreads = new();
    private readonly ConcurrentDictionary<string, SessionWorker> _writers = new();
    private readonly Dictionary<string, string> _recentDiffs = new();
    private List<CodexProject> _projects = new();
    private CodexHostSettings _scope = new(false, [], AutoDiscover: false);
    private DateTimeOffset _catalogUpdated;
    private string? _lastThread;
    private bool _initialized;
    public event Action<JsonObject>? Message;
    public bool Running => _initialized && _runtime?.Running == true;
    public bool Shared => _runtime?.Shared == true;
    public JsonArray PendingApprovals => new((_runtime?.Shared == true ? _runtime.PendingApprovals
        .Where(item => item?["params"]?["threadId"]?.GetValue<string>() is { } id && _threads.ContainsKey(id)) :
        _writers.Values.SelectMany(worker => worker.Client.PendingApprovals))
        .Take(64).Select(item => item?.DeepClone()).ToArray());
    private sealed class SessionWorker(RuntimeClient client)
    {
        public RuntimeClient Client { get; } = client;
        public long ReleaseAt;
    }

    private async Task<SessionWorker> CreateWorkerAsync(string cwd, CancellationToken token)
    {
        if (_writers.Count >= 8) throw new InvalidDataException("too_many_sessions");
        var worker = new SessionWorker(new RuntimeClient(RuntimeClient.FindExecutable(settings()), cwd));
        worker.Client.Message += message =>
        {
            var method = message["method"]?.GetValue<string>();
            if (method == "turn/started") Interlocked.Exchange(ref worker.ReleaseAt, 0);
            if (method == "turn/completed") Interlocked.Exchange(ref worker.ReleaseAt, DateTimeOffset.UtcNow.AddSeconds(2).UtcTicks);
            Message?.Invoke(message);
        };
        try { await worker.Client.InitializeAsync(token); return worker; }
        catch { await worker.Client.DisposeAsync(); throw; }
    }

    private async Task ReleaseWorkerAsync(string id)
    {
        if (!_writers.TryRemove(id, out var worker)) return;
        if (_recentDiffs.Count >= 32) _recentDiffs.Remove(_recentDiffs.Keys.First());
        _recentDiffs[id] = worker.Client.Diff;
        _newThreads.TryRemove(id, out _);
        await worker.Client.DisposeAsync();
        // This process owns only this idle session. Other workers and the native desktop stay alive.
        Message?.Invoke(new JsonObject { ["method"] = "lanpower/session/released", ["params"] = new JsonObject { ["threadId"] = id } });
    }

    private static async Task<string?> ReleaseIssueAsync(SessionWorker worker, CancellationToken token)
    {
        if (worker.Client.ActiveTurns.Count != 0 || worker.Client.PendingApprovals.Count != 0) return "task_running";
        var loaded = await worker.Client.CallAsync("thread/loaded/list", new JsonObject(), token);
        if (loaded["result"]?["data"] is not JsonArray { Count: <= 128 } ids) return "session_release_unavailable";
        foreach (var id in ids)
        {
            var read = await worker.Client.CallAsync("thread/read", new JsonObject { ["threadId"] = id?.DeepClone(), ["includeTurns"] = false }, token);
            var state = read["result"]?["thread"]?["status"]?["type"]?.GetValue<string>();
            if (state == "active") return "task_running";
            if (state is not ("idle" or "notLoaded")) return "session_release_unavailable";
            var terminals = await worker.Client.CallAsync("thread/backgroundTerminals/list", new JsonObject { ["threadId"] = id?.DeepClone() }, token);
            if (terminals["result"]?["data"] is not JsonArray data) return "session_release_unavailable";
            if (data.Count != 0 || terminals["result"]?["nextCursor"] is not null) return "background_running";
        }
        return worker.Client.ActiveTurns.Count != 0 || worker.Client.PendingApprovals.Count != 0 ? "task_running" : null;
    }

    public async Task<bool> CanSwitchModeAsync(CancellationToken token)
    {
        foreach (var worker in _writers.Values)
        {
            try { if (await ReleaseIssueAsync(worker, token) is not null) return false; }
            catch (Exception error) when (error is IOException or InvalidDataException or InvalidOperationException or TimeoutException)
            { return false; }
        }
        return true;
    }

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
        if (config.SharedControl)
        {
            if (sharedConnection is not null) _runtime = await sharedConnection(token);
            else
            {
                var connection = await SharedCodexServer.EnsureAsync(token);
                _runtime = await RuntimeClient.ConnectAsync(new Uri(connection.Endpoint), connection.Bearer, token);
            }
        }
        else _runtime = new RuntimeClient(RuntimeClient.FindExecutable(config), root);
        var client = _runtime;
        client.Message += message =>
        {
            if (!client.Shared) { Message?.Invoke(message); return; }
            var p = message["params"];
            var id = p?["threadId"]?.GetValue<string>() ?? p?["thread"]?["id"]?.GetValue<string>();
            if (message["method"]?.GetValue<string>() == "thread/started" && p?["thread"]?["cwd"]?.GetValue<string>() is { } cwd && _scope.Allows(cwd))
            { _threads[id!] = cwd; _sharedThreads[id!] = 0; p!["thread"] = Summary(p["thread"]!.AsObject()); }
            if (message["method"]?.GetValue<string>() == "turn/started" && id is not null) _newThreads.TryRemove(id, out _);
            if (p?["turn"] is JsonObject turn) p["turn"] = BoundedTurns(new JsonArray(turn.DeepClone())).FirstOrDefault()?.DeepClone();
            if (id is not null && _threads.ContainsKey(id)) Message?.Invoke(message);
        };
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
        if (_runtime?.Shared == true && _sharedThreads.ContainsKey(thread)) return;
        if (!_writers.ContainsKey(thread) && CodexProjects.DesktopOwns(thread))
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
        var control = _runtime?.Shared == true && _sharedThreads.ContainsKey(id) ? "shared" :
            _writers.ContainsKey(id) ? "remote" : CodexProjects.DesktopOwns(id) ? "desktop" : "available";
        string Short(string key, int max) { var value = thread[key]?.GetValue<string>() ?? ""; return value.Length > max ? value[..max] : value; }
        var summary = new JsonObject {
            ["id"] = id, ["name"] = Short("name", 160), ["preview"] = Short("preview", 160),
            ["cwd"] = cwd, ["createdAt"] = thread["createdAt"]?.DeepClone(), ["updatedAt"] = thread["updatedAt"]?.DeepClone(),
            ["status"] = thread["status"]?.DeepClone(), ["control"] = control,
            ["projectPath"] = project?.Path ?? cwd, ["projectName"] = project?.Name ?? Path.GetFileName(cwd),
        };
        if (control == "desktop" && cwd is not null && NativeSessionSnapshot.Read(id, thread["path"]?.GetValue<string>(), cwd) is { } snapshot)
        {
            summary["live"] = snapshot["live"]?.DeepClone();
            if (snapshot["live"]?["state"]?.GetValue<string>() == "running") summary["status"] = new JsonObject { ["type"] = "active" };
        }
        return summary;
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
                ["startedAt"] = turn["startedAt"]?.DeepClone(), ["completedAt"] = turn["completedAt"]?.DeepClone(), ["durationMs"] = turn["durationMs"]?.DeepClone(),
                ["items"] = items, ["error"] = turn["error"] is null ? null : new JsonObject { ["message"] = "本轮任务未完成，请查看本机状态。" } });
            if (result.ToJsonString().Length > 240000) { result.RemoveAt(result.Count - 1); break; }
        }
        return result;
    }

    private async Task<JsonObject> ReadThreadAsync(string id, bool history, CancellationToken token)
    {
        if (_newThreads.TryGetValue(id, out var empty)) return Summary(empty);
        if (_runtime!.Shared) await RefreshSharedLoadedAsync(token);
        var reader = _writers.TryGetValue(id, out var writer) ? writer.Client : _runtime!;
        var response = await reader.CallAsync("thread/read", new JsonObject { ["threadId"] = id, ["includeTurns"] = false }, token);
        if (response["result"]?["thread"] is not JsonObject native) throw new IOException("thread_unavailable");
        RequireWorkspace(native["cwd"]?.GetValue<string>());
        _threads[id] = native["cwd"]!.GetValue<string>();
        if (_runtime.Shared && history)
        {
            // Joining a loaded native chat must preserve its permissions and active task.
            var joined = await _runtime.CallAsync("thread/resume", new JsonObject { ["threadId"] = id, ["excludeTurns"] = true }, token);
            if (joined["error"] is null) _sharedThreads[id] = 0;
            else if (_sharedThreads.ContainsKey(id) && !UnpersistedSharedChat(native, joined["error"], id))
                throw new IOException("shared_subscription_failed");
        }
        var thread = Summary(native);
        if (!_writers.ContainsKey(id) && thread["control"]?.GetValue<string>() != "shared" && NativeSessionSnapshot.Read(id, native["path"]?.GetValue<string>(), native["cwd"]!.GetValue<string>()) is { } snapshot)
        {
            thread["live"] = snapshot["live"]?.DeepClone();
            if (snapshot["live"]?["state"]?.GetValue<string>() == "running") thread["status"] = new JsonObject { ["type"] = "active" };
            if (history && snapshot["turns"] is JsonArray { Count: > 0 })
            {
                thread["turns"] = snapshot["turns"]!.DeepClone(); thread["historyTruncated"] = snapshot["historyTruncated"]?.DeepClone();
                return thread;
            }
        }
        if (history)
        {
            var turns = await reader.CallAsync("thread/turns/list", new JsonObject {
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
                var full = await reader.CallAsync("thread/read", new JsonObject { ["threadId"] = id, ["includeTurns"] = true }, token);
                thread["turns"] = BoundedTurns(new JsonArray((full["result"]?["thread"]?["turns"] as JsonArray ?? new())
                    .Reverse().Take(8).Select(item => item?.DeepClone()).ToArray()));
                thread["turns"] = new JsonArray(thread["turns"]!.AsArray().Reverse().Select(item => item?.DeepClone()).ToArray());
                thread["historyTruncated"] = true;
            }
        }
        if (_runtime.Shared) _runtime.ObserveThread(thread);
        return thread;
    }

    private static bool UnpersistedSharedChat(JsonObject thread, JsonNode? error, string id)
    {
        if (thread["status"]?["type"]?.GetValue<string>() is not ("idle" or "notLoaded") ||
            error?["code"]?.GetValue<int>() != -32600) return false;
        var message = error["message"]?.GetValue<string>();
        return message == "no rollout found for thread id " + id ||
            message == "invalid paginated history lineage for " + id + ": missing source rollout";
    }

    private async Task RefreshSharedLoadedAsync(CancellationToken token)
    {
        var loaded = await _runtime!.CallAsync("thread/loaded/list", new JsonObject(), token);
        if (loaded["result"]?["data"] is not JsonArray ids) throw new IOException("shared_runtime_unavailable");
        _sharedThreads.Clear(); foreach (var id in ids.OfType<JsonValue>().Take(256)) _sharedThreads[id.GetValue<string>()] = 0;
    }

    private async Task<JsonObject> SharedRequestAsync(string method, JsonObject parameters, JsonNode requestId, CancellationToken token)
    {
        if (method == "lanpower/session/release") throw new InvalidDataException("shared_session_control");
        var id = parameters["threadId"]?.GetValue<string>();
        if (method == "thread/start") RequireWorkspace(parameters["cwd"]?.GetValue<string>());
        if (id is not null)
        {
            if (!_threads.ContainsKey(id)) await ReadThreadAsync(id, false, token);
            RequireWorkspace(_threads[id]); await RefreshSharedLoadedAsync(token); RequireControl(id);
            if (!_sharedThreads.ContainsKey(id) && method is not "thread/archive" and not "thread/unarchive")
            {
                var resumed = await _runtime!.CallAsync("thread/resume", new JsonObject { ["threadId"] = id, ["excludeTurns"] = true }, token);
                if (resumed["error"] is not null) { resumed["id"] = requestId.DeepClone(); return resumed; }
                _sharedThreads[id] = 0;
            }
            if (method is "turn/steer" or "turn/interrupt")
            {
                await ReadThreadAsync(id, true, token);
                var expected = parameters[method == "turn/steer" ? "expectedTurnId" : "turnId"]?.GetValue<string>();
                if (_runtime!.ActiveTurns.GetValueOrDefault(id) != expected) throw new InvalidDataException("turn_changed");
            }
        }
        if (method == "thread/resume" && _sharedThreads.ContainsKey(id!))
            return new JsonObject { ["id"] = requestId.DeepClone(), ["result"] = new JsonObject { ["thread"] = await ReadThreadAsync(id!, true, token) } };
        if (method == "thread/start") { parameters["approvalPolicy"] = "on-request"; parameters["sandbox"] = "workspace-write"; parameters["excludeTurns"] = true; }
        if (method == "thread/resume") parameters["excludeTurns"] = true;
        if (method == "turn/start")
        {
            if (_runtime!.ActiveTurns.ContainsKey(id!)) throw new InvalidDataException("task_running");
            parameters["approvalPolicy"] = "on-request"; parameters["cwd"] = _threads[id!];
            parameters["sandboxPolicy"] = new JsonObject { ["type"] = "workspaceWrite", ["networkAccess"] = false,
                ["excludeTmpdirEnvVar"] = true, ["excludeSlashTmp"] = true, ["writableRoots"] = new JsonArray(_threads[id!]) };
        }
        var response = await _runtime!.CallAsync(method, parameters, token); response["id"] = requestId.DeepClone();
        if (response["result"]?["thread"] is JsonObject created && created["id"]?.GetValue<string>() is { } createdId)
        {
            RequireWorkspace(created["cwd"]?.GetValue<string>()); _threads[createdId] = created["cwd"]!.GetValue<string>();
            _sharedThreads[createdId] = 0; _lastThread = createdId;
            if (method == "thread/start") _newThreads[createdId] = (JsonObject)created.DeepClone();
            response["result"]!["thread"] = method == "thread/start" ? Summary(created) : await ReadThreadAsync(createdId, true, token);
        }
        if (method is "turn/start" or "thread/queue/add") _newThreads.TryRemove(id!, out _);
        return response;
    }

    public async Task<JsonObject?> HandleAsync(JsonObject request, CancellationToken token)
    {
        if (!Running) throw new IOException("runtime_unavailable");
        var config = settings();
        if (!config.Enabled) throw new InvalidDataException("remote_disabled");
        if (!request.ContainsKey("method"))
        {
            if (_runtime!.Shared)
            {
                var item = PendingApprovals.OfType<JsonObject>().FirstOrDefault(item => CodexRemoteProtocol.Id(item) == CodexRemoteProtocol.Id(request))
                    ?? throw new InvalidDataException("approval_unavailable");
                if (item["method"]?.GetValue<string>() == "item/fileChange/requestApproval" && request["result"]?["decision"]?.GetValue<string>() == "accept" &&
                    item["params"]?["grantRoot"]?.GetValue<string>() is { } grant && !_scope.Allows(grant)) throw new InvalidDataException("workspace_not_allowed");
                await _runtime.DecideAsync(request, token); return null;
            }
            var key = CodexRemoteProtocol.Id(request);
            var worker = _writers.Values.FirstOrDefault(value => value.Client.PendingApprovals.OfType<JsonObject>()
                .Any(item => CodexRemoteProtocol.Id(item) == key)) ?? throw new InvalidDataException("approval_unavailable");
            var pending = worker.Client.PendingApprovals.OfType<JsonObject>().First(item => CodexRemoteProtocol.Id(item) == key);
            if (request["result"]?["decision"]?.GetValue<string>() == "accept" &&
                pending?["method"]?.GetValue<string>() == "item/fileChange/requestApproval" &&
                pending["params"]?["grantRoot"] is { } root && !_scope.Allows(root.GetValue<string>()))
                throw new InvalidDataException("workspace_not_allowed");
            await worker.Client.DecideAsync(request, token); return null;
        }
        var method = CodexRemoteProtocol.ValidateRequest(request);
        var parameters = (JsonObject)request["params"]!.DeepClone();
        JsonObject Reply(JsonObject value) => new() { ["id"] = request["id"]!.DeepClone(), ["result"] = value };
        if (method == "lanpower/status")
        {
            if (DateTimeOffset.UtcNow - _catalogUpdated > TimeSpan.FromSeconds(30)) await RefreshCatalogAsync(token);
            var account = await _runtime!.CallAsync("account/read", new JsonObject { ["refreshToken"] = false }, token);
            if (_runtime.Shared) await RefreshSharedLoadedAsync(token);
            var active = _writers.FirstOrDefault(pair => pair.Value.Client.ActiveTurns.ContainsKey(pair.Key));
            var last = active.Key ?? (_runtime.Shared ? _runtime.ActiveTurns.Keys.FirstOrDefault(_threads.ContainsKey) : null) ?? _lastThread;
            var diff = last is not null && _writers.TryGetValue(last, out var lastWriter) ? lastWriter.Client.Diff
                : last is not null ? _runtime.Shared ? _runtime.ThreadDiffs.GetValueOrDefault(last, "") : _recentDiffs.GetValueOrDefault(last, "") : "";
            return Reply(new JsonObject {
                ["workspaces"] = new JsonArray(_projects.Select(project => JsonValue.Create(project.Path)).ToArray()),
                ["projects"] = new JsonArray(_projects.Select(project => (JsonNode)new JsonObject {
                    ["name"] = project.Name, ["path"] = project.Path, ["id"] = project.Id }).ToArray()),
                ["autoDiscover"] = config.AutoDiscover, ["loggedIn"] = account["result"]?["account"] is not null, ["sessionHandoff"] = !_runtime.Shared,
                ["sharedControl"] = _runtime.Shared, ["queueSupported"] = _runtime.Shared,
                ["pendingApprovals"] = PendingApprovals, ["activeThread"] = last,
                ["activeTurn"] = _runtime.Shared && last is not null ? _runtime.ActiveTurns.GetValueOrDefault(last) : active.Key is null ? null : active.Value.Client.ActiveTurns.GetValueOrDefault(active.Key), ["diff"] = diff,
                ["activeTurns"] = _runtime.Shared ? new JsonArray(_runtime.ActiveTurns.Where(pair => _threads.ContainsKey(pair.Key))
                    .Select(pair => (JsonNode)new JsonObject { ["threadId"] = pair.Key, ["turnId"] = pair.Value }).ToArray()) : new JsonArray(_writers.Where(pair => pair.Value.Client.ActiveTurns.ContainsKey(pair.Key))
                    .Select(pair => (JsonNode)new JsonObject { ["threadId"] = pair.Key, ["turnId"] = pair.Value.Client.ActiveTurns.GetValueOrDefault(pair.Key) }).ToArray()) });
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
            if (_runtime!.Shared) return await SharedRequestAsync(method, parameters, request["id"]!, token);
            if (method == "lanpower/session/release")
            {
                if (_writers.TryGetValue(threadId, out var owner))
                {
                    if (await ReleaseIssueAsync(owner, token) is { } issue) throw new InvalidDataException(issue);
                    await ReleaseWorkerAsync(threadId);
                }
                else if (CodexProjects.DesktopOwns(threadId)) throw new InvalidDataException("desktop_session_busy");
                return Reply(new JsonObject { ["released"] = true });
            }
            RequireControl(threadId);
        }
        if (method == "thread/list")
        {
            if (_runtime!.Shared) await RefreshSharedLoadedAsync(token);
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
            {
                // Loaded native chats can exist before their first turn is persisted in history.
                if (_runtime.Shared)
                    foreach (var id in _sharedThreads.Keys.Take(32))
                    {
                        if (data.Count >= limit) break;
                        if (data.Any(item => item?["id"]?.GetValue<string>() == id)) continue;
                        var response = await _runtime.CallAsync("thread/read", new JsonObject { ["threadId"] = id, ["includeTurns"] = false }, token);
                        if (response["result"]?["thread"] is not JsonObject loaded || !_scope.Allows(loaded["cwd"]?.GetValue<string>()) ||
                            selected is not null && !CodexHostSettings.Canonical(loaded["cwd"]!.GetValue<string>()).Equals(CodexHostSettings.Canonical(selected), StringComparison.OrdinalIgnoreCase)) continue;
                        _threads[id] = loaded["cwd"]!.GetValue<string>(); data.Insert(0, Summary(loaded));
                    }
                foreach (var empty in _newThreads.Values.Where(item => selected is null || item["cwd"]?.GetValue<string>() == selected))
                    if (!data.Any(item => item?["id"]?.GetValue<string>() == empty["id"]?.GetValue<string>())) data.Insert(0, Summary(empty));
            }
            return Reply(new JsonObject { ["data"] = data, ["nextCursor"] = next });
        }
        if (_runtime!.Shared) return await SharedRequestAsync(method, parameters, request["id"]!, token);
        if (method.StartsWith("thread/queue/")) throw new InvalidDataException("shared_runtime_required");
        if (method == "thread/start")
        {
            cwd = parameters["cwd"]?.GetValue<string>(); RequireWorkspace(cwd);
            parameters["cwd"] = CodexHostSettings.Canonical(cwd!);
        }
        _writers.TryGetValue(threadId ?? "", out var sessionWorker);
        if (method == "turn/start" && sessionWorker?.Client.ActiveTurns.ContainsKey(threadId!) == true) throw new InvalidDataException("task_running");
        if (method is "turn/steer" or "turn/interrupt")
        {
            var expected = parameters[method == "turn/steer" ? "expectedTurnId" : "turnId"]?.GetValue<string>();
            if (sessionWorker is null || sessionWorker.Client.ActiveTurns.GetValueOrDefault(threadId!) is not { } actual || expected != actual)
                throw new InvalidDataException("turn_changed");
        }
        if (method is "thread/start" or "thread/resume")
        { parameters["approvalPolicy"] = "on-request"; parameters["sandbox"] = "workspace-write"; parameters["excludeTurns"] = true; }
        if (method == "thread/resume" && _newThreads.TryGetValue(threadId!, out var newThread))
            return Reply(new JsonObject { ["thread"] = Summary(newThread) });
        // The catalog connection never loads a writable chat. Each chat has its own disposable worker.
        if (method is "thread/start" or "thread/resume")
        {
            var fresh = sessionWorker is null;
            sessionWorker ??= await CreateWorkerAsync(CodexHostSettings.Canonical(cwd!), token);
            try
            {
                var started = await sessionWorker.Client.CallAsync(method, parameters, token);
                started["id"] = request["id"]!.DeepClone();
                if (started["result"]?["thread"] is not JsonObject created || created["id"]?.GetValue<string>() is not { } createdId ||
                    created["cwd"]?.GetValue<string>() is not { } createdCwd)
                {
                    if (fresh) await sessionWorker.Client.DisposeAsync();
                    return started;
                }
                RequireWorkspace(createdCwd);
                if (method == "thread/resume" && createdId != threadId) throw new InvalidDataException("thread_unavailable");
                if (fresh && !_writers.TryAdd(createdId, sessionWorker)) throw new InvalidDataException("thread_unavailable");
                _threads[createdId] = createdCwd; _lastThread = createdId;
                if (method == "thread/start") _newThreads[createdId] = (JsonObject)created.DeepClone();
                started["result"]!["thread"] = method == "thread/start" ? Summary(created) : await ReadThreadAsync(createdId, true, token);
                return started;
            }
            catch
            {
                if (fresh)
                {
                    foreach (var pair in _writers.Where(pair => pair.Value == sessionWorker)) _writers.TryRemove(pair.Key, out _);
                    await sessionWorker.Client.DisposeAsync();
                }
                throw;
            }
        }
        if (method == "turn/start")
        {
            if (sessionWorker is null)
            {
                var resumed = await HandleAsync(new JsonObject { ["id"] = request["id"]!.DeepClone(), ["method"] = "thread/resume",
                    ["params"] = new JsonObject { ["threadId"] = threadId } }, token);
                if (resumed?["error"] is not null) return resumed;
                sessionWorker = _writers[threadId!];
            }
            Interlocked.Exchange(ref sessionWorker.ReleaseAt, 0);
            parameters["approvalPolicy"] = "on-request"; parameters["cwd"] = cwd;
            parameters["sandboxPolicy"] = new JsonObject { ["type"] = "workspaceWrite", ["networkAccess"] = false,
                ["excludeTmpdirEnvVar"] = true, ["excludeSlashTmp"] = true, ["writableRoots"] = new JsonArray(cwd) };
        }
        var result = await (sessionWorker?.Client ?? _runtime!).CallAsync(method, parameters, token);
        result["id"] = request["id"]!.DeepClone();
        if (method == "turn/start" && result["error"] is null) _newThreads.TryRemove(threadId!, out _);
        if (method == "thread/archive" && result["error"] is null && sessionWorker is not null && await ReleaseIssueAsync(sessionWorker, token) is null)
            await ReleaseWorkerAsync(threadId!);
        return result;
    }

    public async Task ExpireAsync(CancellationToken token)
    {
        foreach (var pair in _writers.ToArray())
        {
            if (!pair.Value.Client.Running) { await ReleaseWorkerAsync(pair.Key); continue; }
            await pair.Value.Client.ExpireApprovalsAsync(token);
            var releaseAt = Interlocked.Read(ref pair.Value.ReleaseAt);
            if (releaseAt > 0 && DateTimeOffset.UtcNow.UtcTicks >= releaseAt)
            {
                if (await ReleaseIssueAsync(pair.Value, token) is null) await ReleaseWorkerAsync(pair.Key);
                else Interlocked.Exchange(ref pair.Value.ReleaseAt, DateTimeOffset.UtcNow.AddSeconds(30).UtcTicks);
            }
        }
    }
    public async ValueTask DisposeAsync()
    {
        _initialized = false; if (_runtime is not null) await _runtime.DisposeAsync(); _runtime = null;
        foreach (var worker in _writers.Values) await worker.Client.DisposeAsync();
        _writers.Clear(); _threads.Clear(); _sharedThreads.Clear(); _newThreads.Clear(); _recentDiffs.Clear(); _projects.Clear(); _lastThread = null;
    }
}
