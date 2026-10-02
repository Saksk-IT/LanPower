using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.CodexHost;

public sealed class RemoteRuntime(Func<CodexHostSettings> settings) : IAsyncDisposable
{
    private RuntimeClient? _runtime;
    private readonly Dictionary<string, string> _threads = new();
    private readonly Dictionary<string, JsonObject> _newThreads = new();
    private string? _lastThread;
    private bool _initialized;
    public event Action<JsonObject>? Message;
    public bool Running => _initialized && _runtime?.Running == true;
    public JsonArray PendingApprovals => _runtime?.PendingApprovals ?? new();

    public async Task OpenAsync(CancellationToken token)
    {
        var config = settings();
        if (!config.Enabled || !config.Workspaces.Any(config.Allows)) throw new InvalidDataException("remote_disabled");
        if (Running) return;
        await DisposeAsync();
        _runtime = new RuntimeClient(RuntimeClient.FindExecutable(config), CodexHostSettings.Canonical(config.Workspaces.First(config.Allows)));
        _runtime.Message += message => Message?.Invoke(message);
        await _runtime.InitializeAsync(token);
        _initialized = true;
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
                pending["params"]?["grantRoot"] is { } root && !config.Allows(root.GetValue<string>()))
                throw new InvalidDataException("workspace_not_allowed");
            await _runtime.DecideAsync(request, token); return null;
        }
        var method = CodexRemoteProtocol.ValidateRequest(request);
        var parameters = (JsonObject)request["params"]!.DeepClone();
        if (_threads.Count > 512) _threads.Clear();
        if (method == "turn/start" && _runtime!.ActiveTurn is not null) throw new InvalidDataException("task_running");
        if (method == "lanpower/status")
        {
            var account = await _runtime!.CallAsync("account/read", new JsonObject { ["refreshToken"] = false }, token);
            return new JsonObject { ["id"] = request["id"]!.DeepClone(), ["result"] = new JsonObject {
                ["workspaces"] = new JsonArray(config.Workspaces.Where(config.Allows).Select(path => JsonValue.Create(path)).ToArray()),
                ["loggedIn"] = account["result"]?["account"] is not null,
                ["pendingApprovals"] = _runtime.PendingApprovals, ["activeThread"] = _runtime.ActiveThread ?? _lastThread,
                ["activeTurn"] = _runtime.ActiveTurn, ["diff"] = _runtime.Diff.Length > 262144 ? _runtime.Diff[..262144] : _runtime.Diff } };
        }
        string? cwd = null;
        if (method is "thread/start" or "thread/list")
        {
            cwd = parameters["cwd"]?.GetValue<string>();
            if (!config.Allows(cwd)) throw new InvalidDataException("workspace_not_allowed");
            cwd = CodexHostSettings.Canonical(cwd!); parameters["cwd"] = cwd;
            if (method == "thread/list") parameters["sourceKinds"] = new JsonArray("cli", "vscode", "appServer", "unknown");
        }
        else if (parameters["threadId"] is { } id)
        {
            var thread = id.GetValue<string>();
            if (!_threads.TryGetValue(thread, out cwd))
            {
                var read = await _runtime!.CallAsync("thread/read", new JsonObject { ["threadId"] = thread, ["includeTurns"] = false }, token);
                cwd = read["result"]?["thread"]?["cwd"]?.GetValue<string>();
            }
            if (!config.Allows(cwd)) throw new InvalidDataException("workspace_not_allowed");
            _threads[thread] = cwd!;
            if (method == "thread/resume" && _newThreads.TryGetValue(thread, out var empty))
                return new JsonObject { ["id"] = request["id"]!.DeepClone(), ["result"] = new JsonObject { ["thread"] = empty.DeepClone() } };
        }
        if (method is "thread/start" or "thread/resume")
        { parameters["approvalPolicy"] = "on-request"; parameters["sandbox"] = "workspace-write"; }
        if (method == "turn/start")
        {
            _newThreads.Remove(parameters["threadId"]!.GetValue<string>());
            parameters["approvalPolicy"] = "on-request";
            parameters["cwd"] = cwd;
            parameters["sandboxPolicy"] = new JsonObject { ["type"] = "workspaceWrite", ["networkAccess"] = false,
                ["excludeTmpdirEnvVar"] = true, ["excludeSlashTmp"] = true, ["writableRoots"] = new JsonArray(cwd) };
        }
        var response = await _runtime!.CallAsync(method, parameters, token);
        response["id"] = request["id"]!.DeepClone();
        if (method == "thread/list" && response["result"]?["data"] is JsonArray data)
        {
            for (var index = data.Count - 1; index >= 0; index--)
            {
                var item = data[index];
                var path = item?["cwd"]?.GetValue<string>();
                if (!config.Allows(path)) data.RemoveAt(index);
                else if (item?["id"]?.GetValue<string>() is { } thread) _threads[thread] = path!;
            }
            foreach (var empty in _newThreads.Values.Where(item => item["cwd"]?.GetValue<string>() == cwd))
                if (!data.Any(item => item?["id"]?.GetValue<string>() == empty["id"]?.GetValue<string>())) data.Insert(0, empty.DeepClone());
        }
        if (response["result"]?["thread"] is JsonObject created && created["id"]?.GetValue<string>() is { } createdId &&
            created["cwd"]?.GetValue<string>() is { } createdCwd)
        {
            if (!config.Allows(createdCwd)) throw new InvalidDataException("workspace_not_allowed");
            _threads[createdId] = createdCwd;
            _lastThread = createdId;
            if (method == "thread/start")
            {
                if (_newThreads.Count >= 32) _newThreads.Remove(_newThreads.Keys.First());
                _newThreads[createdId] = (JsonObject)created.DeepClone();
            }
        }
        return response;
    }

    public Task ExpireAsync(CancellationToken token) => _runtime?.ExpireApprovalsAsync(token) ?? Task.CompletedTask;
    public async ValueTask DisposeAsync()
    { _initialized = false; if (_runtime is not null) await _runtime.DisposeAsync(); _runtime = null; _threads.Clear(); _newThreads.Clear(); _lastThread = null; }
}
