using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;
using LanPower.Shared;

namespace LanPower.Service;

public sealed class CodexHostBridge(bool dryRun = false) : BackgroundService
{
    private readonly SemaphoreSlim _write = new(1, 1);
    private StreamWriter? _writer;
    private string? _session;
    public string State { get; private set; } = "host_offline";
    public event Action<string>? Message;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var security = new PipeSecurity();
                security.SetAccessRuleProtection(true, false);
                foreach (var denied in new[] { WellKnownSidType.NetworkSid, WellKnownSidType.AnonymousSid })
                    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(denied, null),
                        PipeAccessRights.FullControl, AccessControlType.Deny));
                foreach (var allowed in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
                    security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(allowed, null),
                        PipeAccessRights.FullControl, AccessControlType.Allow));
                security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null),
                    PipeAccessRights.ReadWrite, AccessControlType.Allow));
                await using var pipe = NamedPipeServerStreamAcl.Create(dryRun ?
                    $"{CodexRemoteProtocol.PipeName}.DryRun.{Environment.ProcessId}" : CodexRemoteProtocol.PipeName,
                    PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.FirstPipeInstance,
                    65536, 65536, security);
                await pipe.WaitForConnectionAsync(stoppingToken);
                using var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 65536, true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 65536, true) { AutoFlush = true };
                await _write.WaitAsync(stoppingToken);
                try { _writer = writer; }
                finally { _write.Release(); }
                while (await CodexRemoteProtocol.ReadLineAsync(reader, stoppingToken) is { } raw)
                {
                    var frame = CodexRemoteProtocol.Parse(raw);
                    var kind = frame["type"]?.GetValue<string>();
                    if (kind == "hello")
                    {
                        if (frame.Count != 3 || frame["protocol"]?.GetValue<int>() != 1 ||
                            frame["state"]?.GetValue<string>() is not ("host_ready" or "disabled"))
                            throw new InvalidDataException("invalid_host");
                        State = frame["state"]!.GetValue<string>();
                        Message?.Invoke(raw);
                        if (_session is { } session) await SendAsync(new { type = "open", session }, stoppingToken);
                    }
                    else if (frame["session"]?.GetValue<string>() == _session && kind is "state" or "rpc")
                    {
                        if (kind == "state") State = frame["state"]!.GetValue<string>();
                        Message?.Invoke(raw);
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) when (error is IOException or InvalidOperationException or UnauthorizedAccessException) { }
            finally
            {
                await _write.WaitAsync(CancellationToken.None);
                try { _writer = null; State = "host_offline"; }
                finally { _write.Release(); }
                if (_session is { } session) Message?.Invoke(System.Text.Json.JsonSerializer.Serialize(
                    new { type = "state", session, state = "host_offline" }));
            }
            await Task.Delay(1000, stoppingToken);
        }
    }

    public async Task ForwardAsync(JsonObject frame, CancellationToken token)
    {
        var kind = frame["type"]?.GetValue<string>();
        var session = frame["session"]?.GetValue<string>();
        if (!Guid.TryParseExact(session, "D", out _)) throw new InvalidDataException("invalid_session");
        if (kind == "open" && frame.Count == 2) _session = session;
        else if (session != _session) return;
        else if (kind == "rpc" && frame.Count == 3 && frame["payload"] is JsonObject rpc)
        {
            if (rpc.ContainsKey("method")) CodexRemoteProtocol.ValidateRequest(rpc);
            else if (rpc.Count != 2 || !rpc.ContainsKey("result")) throw new InvalidDataException("invalid_response");
        }
        else if (kind != "close" || frame.Count != 2) throw new InvalidDataException("invalid_frame");
        if (!await SendAsync(frame, token)) Message?.Invoke(System.Text.Json.JsonSerializer.Serialize(
            new { type = "state", session, state = "host_offline" }));
        if (kind == "close") _session = null;
    }

    private async Task<bool> SendAsync(object frame, CancellationToken token)
    {
        await _write.WaitAsync(token);
        try
        {
            if (_writer is null) return false;
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(TimeSpan.FromSeconds(10));
            await _writer.WriteLineAsync(System.Text.Json.JsonSerializer.Serialize(frame, CodexRemoteProtocol.JsonOptions).AsMemory(), deadline.Token);
            return true;
        }
        finally { _write.Release(); }
    }
}
