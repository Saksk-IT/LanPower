using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using LanPower.CodexHost;
using LanPower.Shared;
using Microsoft.Win32.SafeHandles;

if (!Environment.UserInteractive || WindowsIdentity.GetCurrent().IsSystem) return;
if (args.Contains("--check-desktop"))
{
    try
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        await using var desktop = await RuntimeClient.ConnectDesktopAsync(deadline.Token);
        await desktop.InitializeAsync(deadline.Token);
        var threads = await desktop.CallAsync("thread/list", new JsonObject { ["limit"] = 1 }, deadline.Token);
        var loaded = await desktop.CallAsync("thread/loaded/list", new(), deadline.Token);
        var first = (threads["result"]?["data"] as JsonArray)?.OfType<JsonObject>().FirstOrDefault();
        var history = first is null ? null : await desktop.CallAsync("thread/turns/list", new() { ["threadId"] = first["id"]!.DeepClone(), ["limit"] = 2, ["itemsView"] = "full", ["sortDirection"] = "desc" }, deadline.Token);
        var queue = first is null ? null : await desktop.CallAsync("thread/queue/list", new() { ["threadId"] = first["id"]!.DeepClone(), ["limit"] = 2 }, deadline.Token);
        if (threads["error"] is not null || loaded["error"] is not null) throw new IOException("desktop_request_failed");
        Console.WriteLine(JsonSerializer.Serialize(new { connected = desktop.Running, originalWindow = desktop.Desktop,
            recentThreads = (threads["result"]?["data"] as JsonArray)?.Count ?? 0,
            loadedThreads = (loaded["result"]?["data"] as JsonArray)?.Count ?? 0,
            historySupported = history?["error"] is null, historyTurns = (history?["result"]?["data"] as JsonArray)?.Count ?? 0,
            queueSupported = queue?["error"] is null, queueError = queue?["error"]?["code"]?.GetValue<int>() }));
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException or OperationCanceledException)
    { Console.WriteLine("{\"connected\":false}"); Environment.ExitCode = 6; }
    return;
}
if (args.Contains("--connect-desktop"))
{
    try
    {
        await using var desktop = await DesktopCdp.ConnectAsync(CancellationToken.None);
        var config = CodexHostSettings.Load(); (config with { DesktopControl = true, SharedControl = false }).Save();
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException or TimeoutException or OperationCanceledException)
    { Environment.ExitCode = error is UnauthorizedAccessException ? 5 : 6; }
    return;
}
if (args.Contains("--open-shared-desktop"))
{
    try
    {
        await SharedCodexServer.OpenDesktopAsync(CancellationToken.None);
        var config = CodexHostSettings.Load(); (config with { SharedControl = true, DesktopControl = false }).Save();
    }
    catch (Exception error) when (error is IOException or UnauthorizedAccessException or TimeoutException or InvalidOperationException or System.ComponentModel.Win32Exception)
    {
        Environment.ExitCode = error.Message switch {
            "native_desktop_not_installed" => 2,
            "shared_runtime_not_installed" => 3,
            _ when error is UnauthorizedAccessException => 5,
            _ when error is TimeoutException || error.Message == "shared_runtime_unavailable" => 4,
            _ => 1 };
    }
    return;
}
var pipeName = Argument("--pipe") ?? CodexRemoteProtocol.PipeName;
var settingsPath = Argument("--settings") ?? CodexHostSettings.DefaultPath;
var identity = WindowsIdentity.GetCurrent().User!.Value;
using var instance = new Mutex(true, @"Local\LanPower.CodexHost." + identity + "." + pipeName, out var owns);
if (!owns) return;
using var lifetime = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; lifetime.Cancel(); };
CodexHostSettings ReadSettings()
{
    try { return CodexHostSettings.Load(settingsPath); }
    catch (Exception error) when (error is IOException or InvalidDataException or JsonException or UnauthorizedAccessException)
    { return new(false, []); }
}
await using var runtime = new RemoteRuntime(ReadSettings);
string? session = null;
var runtimeLock = new SemaphoreSlim(1, 1);
Channel<string>? output = null;
CancellationTokenSource? connection = null;
var dirtyHistory = new System.Collections.Concurrent.ConcurrentDictionary<(string Session, string Thread), byte>();
void Emit(object frame)
{
    var raw = JsonSerializer.Serialize(frame, CodexRemoteProtocol.JsonOptions);
    if (Encoding.UTF8.GetByteCount(raw) <= CodexRemoteFrames.MaxResultBytes && output?.Writer.TryWrite(raw) != false) return;
    // A busy transport must not abandon a native task or lose its final content.
    var payload = JsonNode.Parse(raw)?["payload"];
    var thread = payload?["params"]?["threadId"]?.GetValue<string>();
    if (payload?["method"] is not null && payload?["id"] is null && thread is not null && session is { } current && dirtyHistory.Count < 128)
        dirtyHistory[(current,thread)] = 0;
    else connection?.Cancel();
}
async Task EmitResultAsync(JsonObject result, string current, CancellationToken token)
{
    var raw = JsonSerializer.Serialize(new { type = "rpc", session = current, payload = result }, CodexRemoteProtocol.JsonOptions);
    if (Encoding.UTF8.GetByteCount(raw) > CodexRemoteFrames.MaxResultBytes)
        raw = JsonSerializer.Serialize(new { type = "rpc", session = current, payload = new { id = result["id"], error = new { code = -32000, message = "result_too_large" } } }, CodexRemoteProtocol.JsonOptions);
    if (output is { } channel) await channel.Writer.WriteAsync(raw, token);
}
void State(string state)
{
    if (session is { } current) Emit(new { type = "state", session = current, state });
}
runtime.Message += message => { if (session is { } current) Emit(new { type = "rpc", session = current, payload = message }); };

// Local revocation and approval expiry must work even while Cloud/Service is offline.
async Task WatchLocal()
{
    var previousConfig = ReadSettings();
    var previous = JsonSerializer.Serialize(previousConfig);
    var running = false;
    while (!lifetime.IsCancellationRequested)
    {
        await Task.Delay(2000, lifetime.Token);
        await runtimeLock.WaitAsync(lifetime.Token);
        try
        {
            await runtime.ExpireAsync(lifetime.Token);
            var config = ReadSettings();
            var current = JsonSerializer.Serialize(config);
            if (current != previous)
            {
                // A mode change waits for existing independent tasks to finish. Revocation still takes effect immediately.
                if ((config.SharedControl != previousConfig.SharedControl || config.DesktopControl != previousConfig.DesktopControl) &&
                    JsonSerializer.Serialize(config with { SharedControl = previousConfig.SharedControl, DesktopControl = previousConfig.DesktopControl }) == previous &&
                    !await runtime.CanSwitchModeAsync(lifetime.Token)) continue;
                await runtime.DisposeAsync(); previous = current; previousConfig = config; running = false;
                Emit(new { type = "hello", protocol = 1, state = config.Enabled ? "host_ready" : "disabled" });
                if (!config.Enabled) State("disabled");
            }
            if (running && !runtime.Running) State(config.Enabled ? "runtime_error" : "disabled");
            running = runtime.Running;
        }
        catch (Exception error) when (error is IOException or InvalidDataException) { State("runtime_error"); }
        finally { runtimeLock.Release(); }
    }
}
var localWatch = WatchLocal();

while (!lifetime.IsCancellationRequested)
{
    try
    {
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
        await pipe.ConnectAsync(5000, lifetime.Token);
        if (!PipeIdentity.Trusted(pipe, pipeName.Contains(".DryRun.", StringComparison.Ordinal)))
            throw new IOException("untrusted_service");
        using var connected = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        connection = connected;
        output = Channel.CreateBounded<string>(new BoundedChannelOptions(8) { FullMode = BoundedChannelFullMode.Wait });
        dirtyHistory.Clear();
        using var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 65536, true);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 65536, true) { AutoFlush = true };
        var config = ReadSettings();
        Emit(new { type = "hello", protocol = 1, state = config.Enabled ? "host_ready" : "disabled" });
        async Task Write()
        {
            await foreach (var raw in output.Reader.ReadAllAsync(connected.Token))
            {
                foreach (var part in CodexRemoteFrames.Encode(raw))
                    await writer.WriteLineAsync(part.AsMemory(), connected.Token);
                foreach (var dirty in dirtyHistory.Keys)
                    if (dirtyHistory.TryRemove(dirty,out _) && session == dirty.Session)
                        await writer.WriteLineAsync(JsonSerializer.Serialize(new { type = "rpc", session = dirty.Session, payload = new { method = "lanpower/historyChanged", @params = new { threadId = dirty.Thread } } }, CodexRemoteProtocol.JsonOptions).AsMemory(), connected.Token);
            }
        }
        async Task Read()
        {
            while (await CodexRemoteProtocol.ReadLineAsync(reader, connected.Token) is { } raw)
            {
                var frame = CodexRemoteProtocol.Parse(raw);
                var kind = frame["type"]?.GetValue<string>();
                var incoming = frame["session"]?.GetValue<string>();
                if (!Guid.TryParseExact(incoming, "D", out _)) throw new IOException("invalid_session");
                await runtimeLock.WaitAsync(connected.Token);
                try
                {
                    if (kind == "open" && frame.Count == 2)
                    {
                        session = incoming;
                        State("runtime_starting");
                        try
                        {
                            await runtime.OpenAsync(connected.Token); State("runtime_ready");
                            foreach (var pending in runtime.PendingApprovals)
                                Emit(new { type = "rpc", session, payload = pending });
                        }
                        catch (Exception error) when (error is IOException or InvalidDataException or InvalidOperationException or TimeoutException or System.ComponentModel.Win32Exception)
                        { await runtime.DisposeAsync(); State(ReadSettings().Enabled ? "runtime_error" : "disabled"); }
                    }
                    else if (session != incoming) continue;
                    else if (kind == "close" && frame.Count == 2) session = null;
                    else if (kind == "rpc" && frame.Count == 3 && frame["payload"] is JsonObject request)
                    {
                        try
                        {
                            var result = await runtime.HandleAsync(request, connected.Token);
                            if (result is not null) await EmitResultAsync(result, session!, connected.Token);
                        }
                        catch (Exception error) when (error is IOException or InvalidDataException or InvalidOperationException or TimeoutException or ArgumentException)
                        {
                            // Remote failures contain only fixed categories. Runtime RPC errors remain encrypted in transit.
                            var category = error.Message is "desktop_session_busy" or "task_running" or "workspace_not_allowed" or
                                "turn_changed" or "approval_unavailable" or "too_many_sessions" or "background_running" or
                                "session_release_unavailable" or "shared_session_control" or "shared_runtime_required" or "image_not_referenced" or "image_too_large" or "unsupported_image" or
                                "submission_mismatch" or "submission_store_full" or "submission_store_unavailable" or "history_reference_expired" or "history_item_too_large" or "result_too_large" ? error.Message : "request_rejected";
                            Emit(new { type = "rpc", session, payload = new JsonObject { ["id"] = request["id"]?.DeepClone(),
                                ["error"] = new JsonObject { ["code"] = -32000, ["message"] = category } } });
                        }
                    }
                    else throw new IOException("invalid_frame");
                }
                finally { runtimeLock.Release(); }
            }
        }
        var tasks = new[] { Write(), Read() };
        try { await await Task.WhenAny(tasks); }
        finally
        {
            connected.Cancel();
            try { await Task.WhenAll(tasks); }
            catch (Exception error) when (error is OperationCanceledException or IOException or InvalidDataException or InvalidOperationException) { }
            output = null; connection = null;
        }
    }
    catch (Exception error) when (error is IOException or InvalidDataException or TimeoutException or OperationCanceledException or UnauthorizedAccessException) { }
    if (!lifetime.IsCancellationRequested) await Task.Delay(2000, lifetime.Token);
}
try { await localWatch; } catch (OperationCanceledException) { }

string? Argument(string name)
{
    var index = Array.IndexOf(args, name);
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
}

internal static class PipeIdentity
{
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] private struct ServiceProcess
    { public uint Type, State, Accepted, Exit, SpecificExit, Checkpoint, WaitHint, Pid, Flags; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr OpenSCManager(string? machine, string? database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr OpenService(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll")] private static extern bool QueryServiceStatusEx(IntPtr service, int info, out ServiceProcess status, uint size, out uint needed);
    [DllImport("advapi32.dll")] private static extern bool CloseServiceHandle(IntPtr handle);
    public static bool Trusted(NamedPipeClientStream pipe, bool dryRun)
    {
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var pid)) return false;
        if (!dryRun)
        {
            // Standard users can query SCM status, but cannot query a SYSTEM process token.
            // Bind the pipe server to the actual installed service process.
            var manager = OpenSCManager(null, null, 1);
            if (manager == IntPtr.Zero) return false;
            var service = OpenService(manager, "LanPowerService", 4);
            try { return service != IntPtr.Zero && QueryServiceStatusEx(service, 0, out var status,
                (uint)Marshal.SizeOf<ServiceProcess>(), out _) && status.Pid == pid && status.State == 4; }
            finally { if (service != IntPtr.Zero) CloseServiceHandle(service); CloseServiceHandle(manager); }
        }
        var process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return false;
        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(process, 8, out token)) return false;
            using var server = new WindowsIdentity(token);
            return server.IsSystem || dryRun && server.User == WindowsIdentity.GetCurrent().User;
        }
        finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
    }
}
