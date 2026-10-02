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
if (args.Contains("--open-shared-desktop"))
{
    try
    {
        await SharedCodexServer.OpenDesktopAsync(CancellationToken.None);
        var config = CodexHostSettings.Load(); (config with { SharedControl = true }).Save();
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
void Emit(object frame)
{
    var raw = JsonSerializer.Serialize(frame, CodexRemoteProtocol.JsonOptions);
    if (Encoding.UTF8.GetByteCount(raw) > CodexRemoteProtocol.MaxFrame || output?.Writer.TryWrite(raw) == false)
        connection?.Cancel();
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
                if (config.SharedControl != previousConfig.SharedControl &&
                    JsonSerializer.Serialize(config with { SharedControl = previousConfig.SharedControl }) == previous &&
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
        output = Channel.CreateBounded<string>(new BoundedChannelOptions(16) { FullMode = BoundedChannelFullMode.Wait });
        using var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 65536, true);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 65536, true) { AutoFlush = true };
        var config = ReadSettings();
        Emit(new { type = "hello", protocol = 1, state = config.Enabled ? "host_ready" : "disabled" });
        async Task Write()
        {
            await foreach (var raw in output.Reader.ReadAllAsync(connected.Token))
                await writer.WriteLineAsync(raw.AsMemory(), connected.Token);
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
                            if (result is not null) Emit(new { type = "rpc", session, payload = result });
                        }
                        catch (Exception error) when (error is IOException or InvalidDataException or InvalidOperationException or TimeoutException or ArgumentException)
                        {
                            // Remote failures contain only fixed categories. Runtime RPC errors remain encrypted in transit.
                            var category = error.Message is "desktop_session_busy" or "task_running" or "workspace_not_allowed" or
                                "turn_changed" or "approval_unavailable" or "too_many_sessions" or "background_running" or
                                "session_release_unavailable" or "shared_session_control" or "shared_runtime_required" ? error.Message : "request_rejected";
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
