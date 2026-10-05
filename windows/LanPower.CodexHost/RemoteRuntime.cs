using System.Text.Json.Nodes;
using System.Collections.Concurrent;
using LanPower.Shared;

namespace LanPower.CodexHost;

public sealed class RemoteRuntime(Func<CodexHostSettings> settings, Func<CancellationToken, Task<RuntimeClient>>? sharedConnection = null, RemoteSubmissionStore? submissions = null, TimeProvider? clock = null) : IAsyncDisposable
{
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private DateTimeOffset _reconnectAt;
    private int _reconnectDelay = 2;
    private readonly RemoteSubmissionStore _submissions = submissions ?? new();
    private readonly RemoteHistoryStore _history = new();
    private readonly HashSet<string> _unsupported = new();
    private long _revision;
    private void Notify(JsonObject message)
    {
        if (message["method"]?.GetValue<string>() is "thread/started" or "thread/archived" or "thread/unarchived" or "thread/name/updated")
        {
            Interlocked.Increment(ref _libraryInvalidation);
            Interlocked.Exchange(ref _libraryCatalogUpdatedTicks, 0);
        }
        message = RemoteHistory.PublicPayload(message).AsObject();
        if (message["params"] is JsonObject p) p["lanpowerRevision"] = Interlocked.Increment(ref _revision);
        Message?.Invoke(message);
    }
    private RuntimeClient? _runtime;
    private readonly ConcurrentDictionary<string, string> _threads = new();
    private readonly ConcurrentDictionary<string, byte> _sharedThreads = new();
    private readonly ConcurrentDictionary<string, JsonObject> _newThreads = new();
    private readonly ConcurrentDictionary<string, JsonObject> _threadSettings = new();
    private readonly ConcurrentDictionary<string, SessionWorker> _writers = new();
    private readonly Dictionary<string, string> _recentDiffs = new();
    private readonly RemoteLibraryStore _library = new();
    private readonly RemoteLibraryCatalog _libraryCatalog = new();
    private readonly RemoteCapabilityCatalog _capabilityCatalog = new();
    private readonly SemaphoreSlim _libraryCatalogGate = new(1, 1);
    private long _libraryCatalogUpdatedTicks;
    private long _libraryInvalidation;
    private volatile bool _libraryCatalogReady;
    private readonly object _warmupGate = new();
    private Task? _libraryWarmup;
    private CancellationTokenSource? _warmupCancellation;
    private readonly RemoteImages _images = new();
    private readonly object _projectGate = new();
    private CodexProject[] _projects = [];
    private CodexHostSettings _scope = new(false, [], AutoDiscover: false);
    private long _catalogUpdatedTicks;
    private string? _lastThread;
    private bool _initialized;
    public event Action<JsonObject>? Message;
    public bool Running => _initialized && _runtime?.Running == true;
    public bool Shared => _runtime?.Shared == true;
    public JsonArray PendingApprovals => new((_runtime?.Shared == true ? _runtime.PendingApprovals
        .Where(item => item?["params"]?["threadId"]?.GetValue<string>() is { } id && _threads.ContainsKey(id)) :
        _writers.Values.SelectMany(worker => worker.Client.PendingApprovals))
        .Select(item => item?.DeepClone()).ToArray());
    private sealed class SessionWorker(RuntimeClient client)
    {
        public RuntimeClient Client { get; } = client;
        public long ReleaseAt;
    }

    private async Task<SessionWorker> CreateWorkerAsync(string cwd, CancellationToken token)
    {
        var worker = new SessionWorker(new RuntimeClient(RuntimeClient.FindExecutable(settings()), cwd));
        worker.Client.Message += message =>
        {
            var method = message["method"]?.GetValue<string>();
            if (method == "turn/started") Interlocked.Exchange(ref worker.ReleaseAt, 0);
            if (method == "turn/completed") Interlocked.Exchange(ref worker.ReleaseAt, DateTimeOffset.UtcNow.AddSeconds(2).UtcTicks);
            Notify(message);
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
        Notify(new JsonObject { ["method"] = "lanpower/session/released", ["params"] = new JsonObject { ["threadId"] = id } });
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
        if (config.DesktopControl) _runtime = await RuntimeClient.ConnectDesktopAsync(token);
        else if (config.SharedControl)
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
            if (!client.Shared) { Notify(message); return; }
            var p = message["params"];
            var id = p?["threadId"]?.GetValue<string>() ?? p?["thread"]?["id"]?.GetValue<string>();
            if (message["method"]?.GetValue<string>() == "thread/started" && p?["thread"]?["cwd"]?.GetValue<string>() is { } cwd && _scope.Allows(cwd))
            { _threads[id!] = cwd; _sharedThreads[id!] = 0; p!["thread"] = Summary(p["thread"]!.AsObject()); }
            if (message["method"]?.GetValue<string>() == "turn/started" && id is not null) _newThreads.TryRemove(id, out _);
            if (message["method"]?.GetValue<string>() == "thread/settings/updated" && id is not null && p is JsonObject changed)
                ObserveSettings(id, changed["threadSettings"] as JsonObject ?? changed["settings"] as JsonObject ?? changed);
            if (p?["turn"] is JsonObject turn) p["turn"] = RemoteHistory.VisibleTurns(new JsonArray(turn.DeepClone())).FirstOrDefault()?.DeepClone();
            if (message["method"]?.GetValue<string>() == "account/rateLimits/updated") Notify(message);
            else if (id is not null && _threads.ContainsKey(id)) { _images.Observe(id, p); Notify(message); }
        };
        await _runtime.InitializeAsync(token);
        // The transport is ready after native initialize. Project discovery and the complete
        // chat index are secondary work; blocking runtime_ready on them makes every reconnect
        // pay the full project/thread scan cost.
        var initialProjects = new List<CodexProject>();
        foreach (var path in config.Workspaces) CodexProjects.Add(initialProjects, path);
        _projects = initialProjects.ToArray();
        _scope = config with { Workspaces = initialProjects.Select(project => project.Path).ToArray(), AutoDiscover = false };
        _initialized = true;
        _warmupCancellation = new CancellationTokenSource();
        _reconnectAt = default; _reconnectDelay = 2;
        StartLibraryWarmup();
    }

    // Restore only the native/shared transport. Never replay RPCs or restart independent task workers.
    public async Task<bool> ReconnectAsync(CancellationToken token)
    {
        var config = settings();
        if (Running || !config.Enabled || !(config.DesktopControl || config.SharedControl) ||
            _clock.GetUtcNow() < _reconnectAt) return false;
        try { await OpenAsync(token); return true; }
        catch
        {
            await DisposeAsync();
            _reconnectAt = _clock.GetUtcNow().AddSeconds(_reconnectDelay);
            _reconnectDelay = Math.Min(30, _reconnectDelay * 2);
            throw;
        }
    }

    private async Task RefreshCatalogAsync(CancellationToken token)
    {
        var config = settings();
        var projects = new List<CodexProject>();
        if (config.AutoDiscover)
        {
            foreach (var project in _projects) CodexProjects.Add(projects, project.Path, project.Name, project.Id);
            // The native project API is preferred; older CLI versions fall back to desktop project metadata.
            foreach (var project in CodexProjects.FromState())
                CodexProjects.Add(projects, project.Path, project.Name, project.Id);
            var native = await _runtime!.CallAsync("project/list", new JsonObject(), token);
            if (native["result"]?["data"] is JsonArray data)
                foreach (var item in data.OfType<JsonObject>())
                    if (item["roots"] is JsonArray roots)
                        foreach (var root in roots.OfType<JsonObject>())
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
        lock (_projectGate)
        {
            // A first-page read may discover another authorized project while this scan awaits
            // the native server. Publish immutable arrays and retain those concurrent discoveries.
            if (config.AutoDiscover)
                foreach (var project in _projects) CodexProjects.Add(projects, project.Path, project.Name, project.Id);
            _projects = projects.ToArray();
            _scope = config with { Workspaces = _projects.Select(project => project.Path).ToArray(), AutoDiscover = false };
        }
        Interlocked.Exchange(ref _catalogUpdatedTicks, DateTimeOffset.UtcNow.UtcTicks);
    }

    private void RequireWorkspace(string? cwd)
    {
        var config = settings();
        if (!_scope.Allows(cwd) || !config.Enabled || !config.AutoDiscover && !config.Allows(cwd)) throw new InvalidDataException("workspace_not_allowed");
    }

    private void ObserveWorkspace(string? cwd, string? name = null)
    {
        if (_scope.Allows(cwd) || !settings().AutoDiscover || string.IsNullOrWhiteSpace(cwd)) return;
        lock (_projectGate)
        {
            var projects = _projects.ToList();
            CodexProjects.Add(projects, cwd, name);
            _projects = projects.ToArray();
            _scope = settings() with { Workspaces = _projects.Select(project => project.Path).ToArray(), AutoDiscover = false };
        }
    }

    private void RequireControl(string thread)
    {
        if (_runtime?.Shared == true && _sharedThreads.ContainsKey(thread)) return;
        if (!_writers.ContainsKey(thread) && CodexProjects.DesktopOwns(thread))
            throw new InvalidDataException("desktop_session_busy");
    }

    private JsonObject Summary(JsonObject thread, bool metadataOnly = false)
    {
        var cwd = thread["cwd"]?.GetValue<string>();
        var project = CodexProjects.ContainingProject(_projects, cwd);
        var id = thread["id"]!.GetValue<string>();
        var control = _runtime?.Shared == true && _sharedThreads.ContainsKey(id) ? "shared" :
            _writers.ContainsKey(id) ? "remote" : CodexProjects.DesktopOwns(id) ? "desktop" : "available";
        string Short(string key, int max) { var value = thread[key]?.GetValue<string>() ?? ""; return value.Length > max ? value[..max] : value; }
        var summary = new JsonObject {
            ["id"] = id, ["name"] = Short("name", 160), ["preview"] = Short("preview", 160),
            ["cwd"] = cwd, ["createdAt"] = thread["createdAt"]?.DeepClone(), ["updatedAt"] = thread["updatedAt"]?.DeepClone(),
            ["status"] = thread["status"]?.DeepClone(), ["control"] = control,
            ["projectPath"] = project?.Path ?? cwd, ["projectName"] = project?.Name ?? Path.GetFileName(cwd),
            ["isChat"] = CodexProjects.IsChatPath(cwd),
        };
        if (_threadSettings.TryGetValue(id,out var options)) foreach (var pair in options) summary[pair.Key] = pair.Value?.DeepClone();
        if (control == "desktop" && cwd is not null && NativeSessionSnapshot.Read(id, thread["path"]?.GetValue<string>(), cwd, metadataOnly) is { } snapshot)
        {
            summary["live"] = snapshot["live"]?.DeepClone();
            if (snapshot["live"]?["state"]?.GetValue<string>() == "running") summary["status"] = new JsonObject { ["type"] = "active" };
        }
        return summary;
    }

    private void ObserveSettings(string id, JsonObject response)
    {
        var options = _threadSettings.TryGetValue(id,out var existing) ? (JsonObject)existing.DeepClone() : new JsonObject();
        foreach (var key in new[] { "model", "reasoningEffort", "collaborationMode", "approvalPolicy", "approvalsReviewer", "sandbox", "activePermissionProfile" })
            if (response.ContainsKey(key)) options[key] = response[key]?.DeepClone();
        if (response.ContainsKey("sandboxPolicy")) options["sandbox"] = response["sandboxPolicy"]?.DeepClone();
        if (response.ContainsKey("effort")) options["reasoningEffort"] = response["effort"]?.DeepClone();
        if (options.Count > 0) _threadSettings[id] = options;
    }

    private async Task<JsonObject> ReadHistoryPageAsync(RuntimeClient reader, string id, string? cursor, int limit, CancellationToken token)
    {
        if (cursor?.StartsWith(RemoteHistory.CursorPrefix, StringComparison.Ordinal) != true)
        {
            var args = new JsonObject { ["threadId"] = id, ["limit"] = Math.Min(8, limit), ["itemsView"] = "full", ["sortDirection"] = "desc" };
            if (cursor is not null) args["cursor"] = cursor;
            var page = await reader.CallAsync("thread/turns/list", args, token);
            if (page["result"]?["data"] is JsonArray data)
            { _images.Observe(id, data); page["result"]!["data"] = _history.Pack(id, data); return page; }
            if (cursor is not null || page["error"]?["code"]?.GetValue<int>() != -32601) return page;
        }
        var full = await reader.CallAsync("thread/read", new JsonObject { ["threadId"] = id, ["includeTurns"] = true }, token);
        if (full["error"] is not null) return full;
        var saved = RemoteHistory.PageSavedTurns(full["result"]?["thread"]?["turns"] as JsonArray ?? [], cursor, Math.Min(8, limit));
        _images.Observe(id, saved["data"]); saved["data"] = _history.Pack(id, saved["data"]!.AsArray());
        return new() { ["result"] = saved };
    }

    private async Task<JsonObject> ReadThreadAsync(string id, bool history, CancellationToken token, int historyLimit = 8)
    {
        var revision = Interlocked.Read(ref _revision);
        if (_newThreads.TryGetValue(id, out var empty)) return Summary(empty);
        if (_runtime!.Shared) await RefreshSharedLoadedAsync(token);
        var reader = _writers.TryGetValue(id, out var writer) ? writer.Client : _runtime!;
        var stateRevision = reader.StateRevision;
        var response = await reader.CallAsync("thread/read", new JsonObject { ["threadId"] = id, ["includeTurns"] = false }, token);
        if (response["result"]?["thread"] is not JsonObject native) throw new IOException("thread_unavailable");
        ObserveWorkspace(native["cwd"]?.GetValue<string>());
        RequireWorkspace(native["cwd"]?.GetValue<string>());
        _threads[id] = native["cwd"]!.GetValue<string>();
        if (_runtime.Desktop)
        {
            // The original renderer already owns the event listeners. Read saved
            // and cached settings without loading or resuming a viewed thread.
            if (NativeSessionSnapshot.Read(id, native["path"]?.GetValue<string>(), native["cwd"]!.GetValue<string>())?["settings"] is JsonObject savedSettings)
                ObserveSettings(id, savedSettings);
            ObserveSettings(id, response["result"]!.AsObject());
        }
        if (_runtime.Shared && !_runtime.Desktop && history)
        {
            // A separate app-server connection needs its own event subscription.
            var joined = await _runtime.CallAsync("thread/resume", new JsonObject { ["threadId"] = id, ["excludeTurns"] = true }, token);
            if (joined["error"] is null) { _sharedThreads[id] = 0; if (joined["result"] is JsonObject joinedResult) ObserveSettings(id,joinedResult); }
            else if (_sharedThreads.ContainsKey(id) && !UnpersistedSharedChat(native, joined["error"], id))
                throw new IOException("shared_subscription_failed");
        }
        var thread = Summary(native); thread["lanpowerRevision"] = revision;
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
            var page = await ReadHistoryPageAsync(reader, id, null, historyLimit, token);
            if (page["error"] is not null) throw new IOException(page["error"]?["message"]?.GetValue<string>() is "result_too_large" or "history_item_too_large" ? page["error"]!["message"]!.GetValue<string>() : "history_unavailable");
            var data = page["result"]?["data"] as JsonArray ?? [];
            thread["turns"] = new JsonArray(data.Reverse().Select(t => t?.DeepClone()).ToArray());
            thread["historyTailTurnId"] = data.FirstOrDefault()?["id"]?.DeepClone();
            thread["historyCursor"] = page["result"]?["nextCursor"]?.DeepClone();
            thread["historyTruncated"] = false;
        }
        if (_runtime.Shared) _runtime.ObserveThread(thread, stateRevision);
        return thread;
    }

    private async Task EnsureLibraryCatalogAsync(bool refresh, CancellationToken token)
    {
        await _libraryCatalogGate.WaitAsync(token);
        try
        {
            if (!refresh && DateTimeOffset.UtcNow.UtcTicks - Interlocked.Read(ref _libraryCatalogUpdatedTicks) < TimeSpan.FromSeconds(5).Ticks) return;
            var invalidation = Interlocked.Read(ref _libraryInvalidation);
            var entries = new Dictionary<string, (JsonObject Thread, bool Archived)>();
            foreach (var archived in new[] { false, true })
            {
                string? cursor = null; var seen = new HashSet<string>();
                do
                {
                    var args = new JsonObject { ["limit"] = 50, ["archived"] = archived, ["sortKey"] = "updated_at",
                        ["modelProviders"] = new JsonArray(), ["sourceKinds"] = new JsonArray("cli", "vscode", "appServer", "unknown") };
                    if (cursor is not null) args["cursor"] = cursor;
                    var page = await _runtime!.CallAsync("thread/list", args, token);
                    if (page["result"]?["data"] is not JsonArray rows) throw new InvalidDataException("library_unavailable");
                    foreach (var thread in rows.OfType<JsonObject>())
                    {
                        ObserveWorkspace(thread["cwd"]?.GetValue<string>());
                        if (!_scope.Allows(thread["cwd"]?.GetValue<string>())) continue;
                        var id = thread["id"]!.GetValue<string>(); _threads[id] = thread["cwd"]!.GetValue<string>();
                        entries[id] = (Summary(thread, metadataOnly: true), archived);
                    }
                    cursor = page["result"]?["nextCursor"]?.GetValue<string>();
                    if (cursor is not null && !seen.Add(cursor)) throw new InvalidDataException("library_cursor_changed");
                } while (cursor is not null);
            }
            if (_runtime!.Shared) await RefreshSharedLoadedAsync(token);
            foreach (var id in _sharedThreads.Keys.Concat(_newThreads.Keys).Distinct())
                if (!entries.ContainsKey(id))
                {
                    var thread = await ReadThreadAsync(id, false, token);
                    if (_scope.Allows(thread["cwd"]?.GetValue<string>())) entries[id] = (thread, false);
                }
            _libraryCatalog.Replace(entries.Values);
            Interlocked.Exchange(ref _libraryCatalogUpdatedTicks,
                invalidation == Interlocked.Read(ref _libraryInvalidation) ? DateTimeOffset.UtcNow.UtcTicks : 0);
            _libraryCatalogReady = true;
        }
        finally { _libraryCatalogGate.Release(); }
    }

    private void StartLibraryWarmup()
    {
        lock (_warmupGate)
        {
            if (!_initialized || _runtime is null || _libraryWarmup is { IsCompleted: false }) return;
            var token = (_warmupCancellation ??= new CancellationTokenSource()).Token;
            _libraryWarmup = WarmLibraryAsync(token);
        }
    }

    private async Task WarmLibraryAsync(CancellationToken token)
    {
        try
        {
            // Give the first bootstrap/list request a chance to use the native first page before
            // project discovery and the complete active + archived index start scanning.
            await Task.Delay(250, token);
            await RefreshCatalogAsync(token);
            await EnsureLibraryCatalogAsync(true, token);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) when (error is IOException or InvalidDataException or InvalidOperationException or TimeoutException) { }
        finally { lock (_warmupGate) _libraryWarmup = null; }
    }

    private async Task<JsonObject> ReadLibraryPageFastAsync(JsonObject parameters, CancellationToken token)
    {
        var archived = parameters["archived"]?.GetValue<bool>() == true;
        var query = parameters["query"]?.GetValue<string>()?.Trim() ?? "";
        var limit = parameters["limit"]?.GetValue<int>() ?? 50;
        if (query.Length > 0)
            return new JsonObject { ["data"] = new JsonArray(), ["nextCursor"] = null, ["pinned"] = new JsonArray(), ["revision"] = _libraryCatalog.Revision, ["stale"] = true, ["refreshing"] = true };
        var args = new JsonObject { ["limit"] = limit, ["archived"] = archived, ["sortKey"] = "updated_at",
            ["modelProviders"] = new JsonArray(), ["sourceKinds"] = new JsonArray("cli", "vscode", "appServer", "unknown") };
        if (parameters["cursor"]?.GetValue<string>() is { Length: > 0 } cursor) args["cursor"] = cursor;
        var response = await _runtime!.CallAsync("thread/list", args, token);
        if (response["error"] is not null) throw new InvalidDataException("library_unavailable");
        var data = new JsonArray();
        if (response["result"]?["data"] is JsonArray rows)
            foreach (var item in rows.OfType<JsonObject>())
            {
                ObserveWorkspace(item["cwd"]?.GetValue<string>());
                if (!_scope.Allows(item["cwd"]?.GetValue<string>())) continue;
                var summary = Summary(item, metadataOnly: true); _threads[item["id"]!.GetValue<string>()] = item["cwd"]!.GetValue<string>();
                data.Add(summary);
            }
        var preferences = (await _library.ReadAsync(token))["preferences"]!.AsObject();
        var pinnedIds = (preferences["pinned"] as JsonArray ?? []).Select(id => id!.GetValue<string>()).ToHashSet(StringComparer.Ordinal);
        var pinned = new JsonArray(data.OfType<JsonObject>().Where(item => pinnedIds.Contains(item["id"]!.GetValue<string>()))
            .Select(item => item.DeepClone()).ToArray());
        return new JsonObject { ["data"] = data, ["nextCursor"] = response["result"]?["nextCursor"]?.DeepClone(),
            ["pinned"] = pinned, ["revision"] = _libraryCatalog.Revision, ["stale"] = true, ["refreshing"] = true };
    }

    private async Task<JsonObject> ReadLibraryPageAsync(JsonObject parameters, CancellationToken token)
    {
        if (!_libraryCatalogReady)
        {
            StartLibraryWarmup();
            return await ReadLibraryPageFastAsync(parameters, token);
        }
        if (parameters["refresh"]?.GetValue<bool>() == true || DateTimeOffset.UtcNow.UtcTicks - Interlocked.Read(ref _libraryCatalogUpdatedTicks) >= TimeSpan.FromSeconds(30).Ticks)
            StartLibraryWarmup();
        var archived = parameters["archived"]?.GetValue<bool>() == true;
        var preferences = (await _library.ReadAsync(token))["preferences"]!.AsObject();
        var page = _libraryCatalog.Page(parameters["query"]?.GetValue<string>()?.Trim() ?? "", archived,
            (preferences["pinned"] as JsonArray ?? []).Select(id => id!.GetValue<string>()), parameters["cursor"]?.GetValue<string>(),
            parameters["limit"]?.GetValue<int>() ?? 50, preferences["aliases"] as JsonObject);
        lock (_warmupGate)
            if (_libraryWarmup is { IsCompleted: false }) { page["stale"] = true; page["refreshing"] = true; }
        return page;
    }

    private async Task<JsonObject> LoadHistoryItemAsync(string id, RemoteHistoryStore.Locator source, CancellationToken token)
    {
        var reader = _writers.TryGetValue(id, out var writer) ? writer.Client : _runtime!;
        string? cursor = null; var seen = new HashSet<string>();
        while (true)
        {
            var args = new JsonObject { ["threadId"] = id, ["limit"] = 8, ["itemsView"] = "full", ["sortDirection"] = "desc" };
            if (cursor is not null) args["cursor"] = cursor;
            var page = await reader.CallAsync("thread/turns/list", args, token);
            JsonArray data;
            if (page["error"]?["code"]?.GetValue<int>() == -32601)
            {
                var full = await reader.CallAsync("thread/read", new() { ["threadId"] = id, ["includeTurns"] = true }, token);
                if (full["result"]?["thread"]?["turns"] is not JsonArray all) throw new InvalidDataException("history_reference_changed");
                data = all;
            }
            else if (page["result"]?["data"] is JsonArray turns) data = turns;
            else throw new InvalidDataException("history_unavailable");
            var turn = data.OfType<JsonObject>().FirstOrDefault(t => t["id"]?.GetValue<string>() == source.TurnId);
            if (turn is not null)
            {
                var visible = RemoteHistory.VisibleTurns(new JsonArray(turn.DeepClone()))[0]!.AsObject();
                if (source.WholeTurn) return visible;
                if (visible["items"] is JsonArray items && source.ItemIndex < items.Count && items[source.ItemIndex] is JsonObject item && item["id"]?.GetValue<string>() == source.ItemId)
                    return (JsonObject)item.DeepClone();
                throw new InvalidDataException("history_reference_changed");
            }
            cursor = page["result"]?["nextCursor"]?.GetValue<string>();
            if (cursor is null) throw new InvalidDataException("history_reference_changed");
            if (!seen.Add(cursor)) throw new InvalidDataException("invalid_history_cursor");
        }
    }

    private async Task<JsonObject> HistoryActionAsync(JsonObject parameters, JsonNode requestId, CancellationToken token)
    {
        var id = parameters["threadId"]!.GetValue<string>();
        if (!_runtime!.Shared) throw new InvalidDataException("shared_runtime_required");
        await RefreshSharedLoadedAsync(token); RequireControl(id);
        JsonObject result;
        if (_runtime.Desktop)
            result = await _runtime.CallAsync("codex-web/local/history/action", parameters, token);
        else
        {
            // Never derive native tail counts from the client's currently loaded page.
            var ids = new List<string>(); var seen = new HashSet<string>(); string? cursor = null;
            do
            {
                var args = new JsonObject { ["threadId"] = id, ["limit"] = 50, ["itemsView"] = "notLoaded", ["sortDirection"] = "desc" };
                if (cursor is not null) args["cursor"] = cursor;
                var page = await _runtime.CallAsync("thread/turns/list", args, token);
                if (page["result"]?["data"] is not JsonArray data) throw new InvalidDataException("history_action_unsupported");
                ids.AddRange(data.OfType<JsonObject>().Select(t => t["id"]!.GetValue<string>()));
                cursor = page["result"]?["nextCursor"]?.GetValue<string>();
                if (ids.Count > 100000 || cursor is not null && !seen.Add(cursor)) throw new InvalidDataException("invalid_history_cursor");
            } while (cursor is not null);
            var count = RemoteHistory.TailCount(ids, parameters["turnId"]!.GetValue<string>(), parameters["expectedTailTurnId"]!.GetValue<string>(), parameters["action"]!.GetValue<string>() == "rollback");
            var latest = await _runtime.CallAsync("thread/turns/list", new() { ["threadId"] = id, ["limit"] = 1, ["itemsView"] = "notLoaded", ["sortDirection"] = "desc" }, token);
            if (latest["result"]?["data"]?[0]?["id"]?.GetValue<string>() != ids[0] || _runtime.ActiveTurns.ContainsKey(id)) throw new InvalidDataException("history_changed");
            result = parameters["action"]!.GetValue<string>() == "fork"
                ? await _runtime.CallAsync("thread/fork", new() { ["threadId"] = id, ["lastTurnId"] = parameters["turnId"]!.DeepClone(), ["excludeTurns"] = true }, token)
                : await _runtime.CallAsync("thread/rollback", new() { ["threadId"] = id, ["numTurns"] = count }, token);
        }
        result["id"] = requestId.DeepClone();
        if (result["error"] is not null) return result;
        var target = result["result"]?["thread"]?["id"]?.GetValue<string>() ?? id;
        result["result"] = new JsonObject { ["thread"] = await ReadThreadAsync(target, true, token) };
        return result;
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
        _sharedThreads.Clear(); foreach (var id in ids.OfType<JsonValue>()) _sharedThreads[id.GetValue<string>()] = 0;
    }

    private async Task RefreshActiveThreadsAsync(CancellationToken token)
    {
        if (_runtime?.Shared != true) return;
        foreach (var id in _sharedThreads.Keys.Where(_threads.ContainsKey))
        {
            var revision = _runtime.StateRevision;
            var read = await _runtime.CallAsync("thread/read", new() { ["threadId"] = id, ["includeTurns"] = false }, token);
            if (read["result"]?["thread"] is not JsonObject thread) continue;
            if (thread["status"]?["type"]?.GetValue<string>() == "active")
            {
                var page = await ReadHistoryPageAsync(_runtime,id,null,1,token);
                if (page["result"]?["data"] is JsonArray turns) thread["turns"] = turns.DeepClone();
            }
            _runtime.ObserveThread(thread,revision);
        }
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
            if (!_sharedThreads.ContainsKey(id) && method is not "thread/archive" and not "thread/unarchive" and not "thread/queue/list")
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
        if (method == "lanpower/permissions/set")
        {
            // Only these three explicit presets cross the relay. Native managed requirements still apply.
            var native = RemotePermissions.Parameters(id!, _threads[id!], parameters["permissionMode"]!.GetValue<string>());
            var confirmed = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            void Changed(JsonObject message)
            {
                if (message["method"]?.GetValue<string>() == "thread/settings/updated" && message["params"]?["threadId"]?.GetValue<string>() == id &&
                    (message["params"]?["threadSettings"] ?? message["params"]?["settings"]) is JsonObject actual)
                    confirmed.TrySetResult((JsonObject)actual.DeepClone());
            }
            _runtime!.Message += Changed;
            try
            {
                var updated = await _runtime.CallAsync("thread/settings/update", native, token);
                updated["id"] = requestId.DeepClone();
                if (updated["error"] is not null) return updated;
                // Empty native chats have no rollout to resume. Confirm using the native effective-settings event.
                var actual = await confirmed.Task.WaitAsync(TimeSpan.FromSeconds(5), token);
                var thread = await ReadThreadAsync(id!, false, token);
                ObserveSettings(id!, actual);
                return new() { ["id"] = requestId.DeepClone(), ["result"] = new JsonObject {
                    ["thread"] = Summary(thread), ["appliesTo"] = "subsequentTurns" } };
            }
            catch (TimeoutException) { throw new IOException("permissions_unavailable"); }
            finally { _runtime.Message -= Changed; }
        }
        if (method == "thread/start") { parameters["approvalPolicy"] = "on-request"; parameters["sandbox"] = "workspace-write"; parameters["excludeTurns"] = true; }
        if (method == "thread/resume") parameters["excludeTurns"] = true;
        if (method == "thread/fork") parameters["excludeTurns"] = true;
        if (parameters["input"] is JsonArray input && input.OfType<JsonObject>().Any(i => i["type"]?.GetValue<string>() == "skill"))
        {
            var list = await _runtime!.CallAsync("skills/list", new() { ["cwds"] = new JsonArray(_threads[id!]) }, token);
            var installed = (list["result"]?["data"] as JsonArray ?? []).OfType<JsonObject>()
                .SelectMany(entry => (entry["skills"] as JsonArray ?? []).OfType<JsonObject>()).Where(skill => skill["enabled"]?.GetValue<bool>() != false).ToArray();
            foreach (var skill in input.OfType<JsonObject>().Where(i => i["type"]?.GetValue<string>() == "skill"))
                if (!installed.Any(s => s["path"]?.GetValue<string>()?.Equals(skill["path"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase) == true && s["name"]?.GetValue<string>() == skill["name"]!.GetValue<string>()))
                    throw new InvalidDataException("skill_not_allowed");
        }
        if (method == "turn/start" && parameters["mode"] is { } mode)
        {
            var model = parameters["model"]?.DeepClone();
            if (model is null) {
                var list = await _runtime!.CallAsync("model/list", new() { ["limit"] = 50 }, token);
                var models = (list["result"]?["data"] as JsonArray ?? []).OfType<JsonObject>().ToArray();
                model = (models.FirstOrDefault(m => m["isDefault"]?.GetValue<bool>() == true) ?? models.FirstOrDefault())?["model"]?.DeepClone();
            }
            if (model is null) throw new InvalidDataException("model_unavailable");
            parameters["collaborationMode"] = new JsonObject { ["mode"] = mode.DeepClone(), ["settings"] = new JsonObject {
                ["model"] = model, ["reasoning_effort"] = parameters["effort"]?.DeepClone(), ["developer_instructions"] = null } };
            parameters.Remove("mode");
        }
        if (method == "turn/start" && !_runtime!.Desktop)
        {
            if (_runtime!.ActiveTurns.ContainsKey(id!)) throw new InvalidDataException("task_running");
            // Permissions are owned by the native thread, including changes from either client.
            parameters["cwd"] = _threads[id!];
        }
        if (_unsupported.Contains(method)) return new() { ["id"] = requestId.DeepClone(), ["error"] = new JsonObject { ["code"] = -32601, ["message"] = "unsupported_method" } };
        var response = await _runtime!.CallAsync(method, parameters, token); response["id"] = requestId.DeepClone();
        if (response["error"]?["code"]?.GetValue<int>() == -32601) _unsupported.Add(method);
        if (response["result"]?["thread"] is JsonObject created && created["id"]?.GetValue<string>() is { } createdId)
        {
            ObserveSettings(createdId,response["result"]!.AsObject());
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
        if (request["method"]?.GetValue<string>() is not ("turn/start" or "turn/steer" or "thread/queue/add" or "thread/queue/update") || request["params"]?["submissionId"] is null) return await HandleCoreAsync(request, token);
        var method = CodexRemoteProtocol.ValidateRequest(request);
        if (!Running || !settings().Enabled) throw new InvalidDataException("remote_disabled");
        var args = (JsonObject)request["params"]!.DeepClone();
        var id = args["threadId"]!.GetValue<string>();
        // Authorize before exposing a receipt or dispatching a mutation.
        await ReadThreadAsync(id, false, token); RequireWorkspace(_threads[id]);
        var submissionId = args["submissionId"]!.GetValue<string>(); args.Remove("submissionId");
        if (!await _submissions.BeginAsync(id, submissionId, method, args, token))
        {
            var receipt = _submissions.Read(id, submissionId);
            var result = new JsonObject { ["receipt"] = receipt };
            if (receipt["turnId"] is { } turnId) result["turn"] = new JsonObject { ["id"] = turnId.DeepClone() };
            return new() { ["id"] = request["id"]!.DeepClone(), ["result"] = result };
        }
        try
        {
            var nativeRequest = (JsonObject)request.DeepClone(); nativeRequest["params"] = args;
            var response = await HandleCoreAsync(nativeRequest, token);
            var receipt = await _submissions.FinishAsync(id, submissionId, response, CancellationToken.None);
            if (response?["result"] is JsonObject result) result["receipt"] = receipt;
            return response;
        }
        catch
        {
            await _submissions.FinishAsync(id, submissionId, null, CancellationToken.None);
            throw;
        }
    }

    private async Task<JsonObject> BuildStatusAsync(bool fast, CancellationToken token)
    {
        var runtime = _runtime!;
        var config = settings();
        var revision = Interlocked.Read(ref _revision);
        JsonObject? account = null;
        if (!fast)
        {
            await runtime.RefreshApprovalsAsync(token);
            if (DateTimeOffset.UtcNow.UtcTicks - Interlocked.Read(ref _catalogUpdatedTicks) > TimeSpan.FromSeconds(30).Ticks) await RefreshCatalogAsync(token);
            account = await runtime.CallAsync("account/read", new JsonObject { ["refreshToken"] = false }, token);
            if (runtime.Shared) { await RefreshSharedLoadedAsync(token); await RefreshActiveThreadsAsync(token); }
        }
        var active = _writers.FirstOrDefault(pair => pair.Value.Client.ActiveTurns.ContainsKey(pair.Key));
        var last = active.Key ?? (runtime.Shared ? runtime.ActiveTurns.Keys.FirstOrDefault(_threads.ContainsKey) : null) ?? _lastThread;
        var diff = last is not null && _writers.TryGetValue(last, out var lastWriter) ? lastWriter.Client.Diff
            : last is not null ? runtime.Shared ? runtime.ThreadDiffs.GetValueOrDefault(last, "") : _recentDiffs.GetValueOrDefault(last, "") : "";
        return new JsonObject {
            ["workspaces"] = new JsonArray(_projects.Select(project => JsonValue.Create(project.Path)).ToArray()),
            ["projects"] = new JsonArray(_projects.Select(project => (JsonNode)new JsonObject {
                ["name"] = project.Name, ["path"] = project.Path, ["id"] = project.Id, ["kind"] = CodexProjects.IsChatPath(project.Path) ? "chat" : "project" }).ToArray()),
            ["fast"] = fast, ["autoDiscover"] = config.AutoDiscover, ["loggedIn"] = fast ? false : account?["result"]?["account"] is not null,
            ["sessionHandoff"] = !runtime.Shared, ["sharedControl"] = runtime.Shared,
            ["queueSupported"] = runtime.Shared && !_unsupported.Contains("thread/queue/list"), ["desktopControl"] = runtime.Desktop,
            ["lanpowerRevision"] = revision, ["submissionReceipts"] = true, ["largeHistory"] = true,
            ["targetedHistoryActions"] = runtime.Shared, ["historyReferenceLeases"] = true, ["libraryCatalog"] = true, ["capabilityPaging"] = true,
            ["permissionsControl"] = runtime.Shared,
            ["unsupportedMethods"] = new JsonArray(_unsupported.Select(m => (JsonNode)JsonValue.Create(m)!).ToArray()),
            ["chatSupported"] = config.AutoDiscover && runtime.Shared,
            ["library"] = await _library.ReadAsync(token), ["pendingApprovals"] = PendingApprovals, ["activeThread"] = last,
            ["activeTurn"] = runtime.Shared && last is not null ? runtime.ActiveTurns.GetValueOrDefault(last) : active.Key is null ? null : active.Value.Client.ActiveTurns.GetValueOrDefault(active.Key),
            ["diff"] = diff,
            ["activeTurns"] = runtime.Shared ? new JsonArray(runtime.ActiveTurns.Where(pair => _threads.ContainsKey(pair.Key))
                .Select(pair => (JsonNode)new JsonObject { ["threadId"] = pair.Key, ["turnId"] = pair.Value }).ToArray()) : new JsonArray(_writers.Where(pair => pair.Value.Client.ActiveTurns.ContainsKey(pair.Key))
                .Select(pair => (JsonNode)new JsonObject { ["threadId"] = pair.Key, ["turnId"] = pair.Value.Client.ActiveTurns.GetValueOrDefault(pair.Key) }).ToArray()) };
    }

    private async Task<JsonObject> BuildBootstrapAsync(JsonObject parameters, CancellationToken token)
    {
        var status = await BuildStatusAsync(true, token);
        var modelTask = _runtime!.CallAsync("model/list", new JsonObject { ["limit"] = 50 }, token);
        var modeTask = _runtime.CallAsync("collaborationMode/list", new JsonObject(), token);
        var libraryTask = ReadLibraryPageAsync(new JsonObject {
            ["archived"] = parameters["archived"]?.DeepClone() ?? false,
            ["limit"] = parameters["limit"]?.DeepClone() ?? 50 }, token);
        var models = await modelTask;
        JsonObject? modes = null;
        try { modes = await modeTask; } catch (Exception error) when (error is IOException or InvalidDataException or InvalidOperationException or TimeoutException) { }
        var result = new JsonObject {
            ["status"] = status,
            ["models"] = models["result"]?["data"]?.DeepClone() ?? new JsonArray(),
            ["modelNextCursor"] = models["result"]?["nextCursor"]?.DeepClone(),
            ["planSupported"] = modes?["result"]?["data"] is JsonArray modeData && modeData.OfType<JsonObject>().Any(mode => mode["mode"]?.GetValue<string>() == "plan"),
            ["library"] = await libraryTask };
        if (parameters["threadId"]?.GetValue<string>() is { Length: > 0 } threadId)
            result["thread"] = await ReadThreadAsync(threadId, true, token);
        return result;
    }

    private async Task<JsonObject?> HandleCoreAsync(JsonObject request, CancellationToken token)
    {
        if (!Running) throw new IOException("runtime_unavailable");
        var config = settings();
        if (!config.Enabled) throw new InvalidDataException("remote_disabled");
        if (!request.ContainsKey("method"))
        {
            if (_runtime!.Shared)
            {
                await _runtime.RefreshApprovalsAsync(token);
                var item = PendingApprovals.OfType<JsonObject>().FirstOrDefault(item => CodexRemoteProtocol.Id(item) == CodexRemoteProtocol.Id(request))
                    ?? throw new InvalidDataException("approval_unavailable");
                var approvalThread = item["params"]?["threadId"]?.GetValue<string>() ?? throw new InvalidDataException("approval_unavailable");
                await ReadThreadAsync(approvalThread, true, token); RequireWorkspace(_threads[approvalThread]);
                if (item["params"]?["turnId"]?.GetValue<string>() is { } approvalTurn && _runtime.ActiveTurns.GetValueOrDefault(approvalThread) != approvalTurn)
                    throw new InvalidDataException("approval_unavailable");
                if (item["method"]?.GetValue<string>() == "item/fileChange/requestApproval" && request["result"]?["decision"]?.GetValue<string>() == "accept" &&
                    item["params"]?["grantRoot"]?.GetValue<string>() is { } grant && !_scope.Allows(grant)) throw new InvalidDataException("workspace_not_allowed");
                await _runtime.DecideAsync(request, token); return null;
            }
            var key = CodexRemoteProtocol.Id(request);
            var worker = _writers.Values.FirstOrDefault(value => value.Client.PendingApprovals.OfType<JsonObject>()
                .Any(item => CodexRemoteProtocol.Id(item) == key)) ?? throw new InvalidDataException("approval_unavailable");
            var pending = worker.Client.PendingApprovals.OfType<JsonObject>().First(item => CodexRemoteProtocol.Id(item) == key);
            RequireWorkspace(pending["params"]?["cwd"]?.GetValue<string>() ?? _threads.GetValueOrDefault(pending["params"]?["threadId"]?.GetValue<string>() ?? ""));
            if (request["result"]?["decision"]?.GetValue<string>() == "accept" &&
                pending?["method"]?.GetValue<string>() == "item/fileChange/requestApproval" &&
                pending["params"]?["grantRoot"] is { } root && !_scope.Allows(root.GetValue<string>()))
                throw new InvalidDataException("workspace_not_allowed");
            await worker.Client.DecideAsync(request, token); return null;
        }
        var method = CodexRemoteProtocol.ValidateRequest(request);
        var parameters = (JsonObject)request["params"]!.DeepClone();
        JsonObject Reply(JsonObject value) => new() { ["id"] = request["id"]!.DeepClone(), ["result"] = value };
        if (method == "lanpower/bootstrap") return Reply(await BuildBootstrapAsync(parameters, token));
        if (method is "lanpower/library/list" or "lanpower/library/check")
        {
            var archived = parameters["archived"]?.GetValue<bool>() == true;
            if (method == "lanpower/library/check") return Reply(_libraryCatalogReady
                ? _libraryCatalog.Check(parameters["threadIds"]!.AsArray().Select(id => id!.GetValue<string>()), archived)
                : new JsonObject { ["revision"] = 0, ["data"] = new JsonArray() });
            return Reply(await ReadLibraryPageAsync(parameters, token));
        }
        if (method == "lanpower/library/update")
        {
            var preferences = CodexLibraryPreferences.Validate(parameters["preferences"]);
            foreach (var id in (preferences["pinned"] as JsonArray ?? []).Select(p => p!.GetValue<string>()))
                if (!_threads.ContainsKey(id)) await ReadThreadAsync(id, false, token);
            var saved = await _library.UpdateAsync(parameters["revision"]!.GetValue<long>(), preferences, token);
            return Reply(saved);
        }
        if (method == "lanpower/chat/start")
        {
            if (!config.AutoDiscover || !_runtime!.Shared) throw new InvalidDataException("workspace_not_allowed");
            var basePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Codex", DateTime.Now.ToString("yyyy-MM-dd"));
            Directory.CreateDirectory(basePath);
            if (!CodexProjects.SafeDirectory(basePath)) throw new InvalidDataException("workspace_not_allowed");
            var path = Path.Combine(basePath, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(path);
            ObserveWorkspace(path, "独立聊天");
            parameters["cwd"] = path;
            return await SharedRequestAsync("thread/start", parameters, request["id"]!, token);
        }
        if (method == "lanpower/automations/list") return Reply(RemoteWorkspace.Automations(_scope));
        if (method.StartsWith("lanpower/files/"))
        {
            var root = parameters["cwd"]!.GetValue<string>(); RequireWorkspace(root);
            if (method == "lanpower/files/upload") return Reply(await RemoteWorkspace.UploadAsync(_scope, root, parameters["name"]!.GetValue<string>(), parameters["base64"]!.GetValue<string>(), token));
            return Reply(method switch {
                "lanpower/files/list" => RemoteWorkspace.List(_scope, root, parameters["path"]?.GetValue<string>(), int.TryParse(parameters["cursor"]?.GetValue<string>() ?? "0", out var offset) ? offset : -1),
                "lanpower/files/read" => RemoteWorkspace.Read(_scope,root,parameters["path"]!.GetValue<string>()),
                _ => RemoteWorkspace.Search(_scope,root,parameters["query"]!.GetValue<string>()) });
        }
        if (method is "skills/list" or "plugin/list")
        {
            var roots = parameters["cwd"] is { } root ? new[] { root.GetValue<string>() } : _projects.Where(p => !CodexProjects.IsChatPath(p.Path)).Select(p => p.Path).ToArray();
            foreach (var rootPath in roots) RequireWorkspace(rootPath);
            var response = await _capabilityCatalog.ReadAsync(method, roots, parameters, (nativeMethod, nativeParams, ct) => _runtime!.CallAsync(nativeMethod, nativeParams, ct), token);
            response["id"] = request["id"]!.DeepClone(); return response;
        }
        if (method == "lanpower/status") return Reply(await BuildStatusAsync(parameters["fast"]?.GetValue<bool>() == true, token));
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
            if (method == "lanpower/submission/read") return Reply(_submissions.Read(threadId, parameters["submissionId"]!.GetValue<string>()));
            if (method == "lanpower/history/item/read")
            {
                if (_runtime!.Desktop)
                {
                    var response = await _runtime.CallAsync("codex-web/local/history/item/read", parameters, token);
                    response["id"] = request["id"]!.DeepClone(); return response;
                }
                return Reply(await _history.ReadAsync(threadId, parameters["reference"]!.GetValue<string>(), parameters["offset"]!.GetValue<int>(),
                    (source, ct) => LoadHistoryItemAsync(threadId, source, ct), token));
            }
            if (method == "lanpower/history/action") return await HistoryActionAsync(parameters, request["id"]!, token);
            if (method == "lanpower/permissions/set" && !_runtime!.Shared) throw new InvalidDataException("shared_runtime_required");
            if (method == "lanpower/image/read") return Reply(_images.Read(_scope, cwd!, threadId, parameters["path"]!.GetValue<string>()));
            if (method == "thread/read")
                return Reply(new JsonObject { ["thread"] = await ReadThreadAsync(threadId, parameters["includeTurns"]?.GetValue<bool>() == true, token, parameters["historyLimit"]?.GetValue<int>() ?? 8) });
            if (method == "thread/turns/list")
            {
                var reader = _writers.TryGetValue(threadId, out var historyWriter) ? historyWriter.Client : _runtime!;
                var page = await ReadHistoryPageAsync(reader, threadId, parameters["cursor"]?.GetValue<string>(), parameters["limit"]?.GetValue<int>() ?? 8, token);
                page["id"] = request["id"]!.DeepClone(); return page;
            }
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
                    {
                        ObserveWorkspace(item["cwd"]?.GetValue<string>());
                        if (_scope.Allows(item["cwd"]?.GetValue<string>()) &&
                            (selected is null || CodexHostSettings.Canonical(item["cwd"]!.GetValue<string>()).Equals(
                                CodexHostSettings.Canonical(selected), StringComparison.OrdinalIgnoreCase)))
                        { data.Add(Summary(item)); _threads[item["id"]!.GetValue<string>()] = item["cwd"]!.GetValue<string>(); }
                    }
                next = response["result"]?["nextCursor"]?.DeepClone();
                if (next is null) break;
                parameters["cursor"] = next.DeepClone(); parameters["limit"] = limit - data.Count;
            }
            if (!request["params"]!.AsObject().ContainsKey("cursor"))
            {
                // Loaded native chats can exist before their first turn is persisted in history.
                if (_runtime.Shared)
                    foreach (var id in _sharedThreads.Keys)
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
        Task? warmup;
        lock (_warmupGate)
        {
            _initialized = false;
            warmup = _libraryWarmup;
            _warmupCancellation?.Cancel();
        }
        if (warmup is not null)
        {
            try { await warmup; } catch (OperationCanceledException) { }
        }
        _libraryWarmup = null; _warmupCancellation?.Dispose(); _warmupCancellation = null;
        _initialized = false; if (_runtime is not null) await _runtime.DisposeAsync(); _runtime = null;
        foreach (var worker in _writers.Values) await worker.Client.DisposeAsync();
        _writers.Clear(); _threads.Clear(); _sharedThreads.Clear(); _newThreads.Clear(); _threadSettings.Clear(); _recentDiffs.Clear(); _projects = []; _lastThread = null;
        _history.Clear(); _libraryCatalog.Clear(); _capabilityCatalog.Clear(); Interlocked.Exchange(ref _libraryCatalogUpdatedTicks, 0); _libraryCatalogReady = false; _unsupported.Clear();
    }
}
