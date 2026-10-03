using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace LanPower.CodexHost;

// The renderer owns the task. Closing this transport only removes our listeners.
public sealed class DesktopCdp : IAsyncDisposable
{
    private readonly ClientWebSocket _socket;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _write = new(1, 1);
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonObject>> _calls = new();
    private readonly Channel<string> _frames = Channel.CreateBounded<string>(new BoundedChannelOptions(128) { FullMode = BoundedChannelFullMode.Wait });
    private readonly string _global = "__lanpowerCdp_" + Guid.NewGuid().ToString("N");
    private readonly string _binding = "__lanpowerEvent_" + Guid.NewGuid().ToString("N");
    private readonly Task _reader;
    private int _sequence;
    public bool Running => _socket.State == WebSocketState.Open && !_reader.IsCompleted;
    public Task<string?> ReadAsync(CancellationToken token) => ReadFrame(token);
    public int ProcessId { get; private set; }

    private DesktopCdp(ClientWebSocket socket) { _socket = socket; _reader = ReceiveAsync(); }

    public static Uri ValidateTarget(int port, JsonArray targets)
    {
        var target = targets.OfType<JsonObject>().FirstOrDefault(t => t["type"]?.GetValue<string>() == "page" && t["url"]?.GetValue<string>() == "app://-/index.html");
        if (!Uri.TryCreate(target?["webSocketDebuggerUrl"]?.GetValue<string>(), UriKind.Absolute, out var uri) ||
            uri.Scheme != "ws" || uri.Host != "127.0.0.1" || uri.Port != port || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || !uri.AbsolutePath.StartsWith("/devtools/page/", StringComparison.Ordinal))
            throw new IOException("desktop_target_unavailable");
        return uri;
    }

    public static async Task<DesktopCdp> ConnectAsync(CancellationToken token)
    {
        var script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
            "@(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" | Where-Object { $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\ChatGPT.exe' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { " +
            "$match=[regex]::Match($_.CommandLine,'(?:^|\\s)--remote-debugging-port(?:=|\\s+)(\\d+)(?:\\s|$)'); " +
            "if($match.Success){ $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid; " +
            "[pscustomobject]@{ pid=$_.ProcessId; port=[int]$match.Groups[1].Value; sid=$owner.Sid; shared=$_.CommandLine -like '*LanPower*CodexShared*' } } }) | ConvertTo-Json -Compress";
        var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8 };
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-Command", script }) start.ArgumentList.Add(arg);
        using var process = Process.Start(start) ?? throw new IOException("desktop_unavailable");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(15));
        var stdout = process.StandardOutput.ReadToEndAsync(deadline.Token); var stderr = process.StandardError.ReadToEndAsync(deadline.Token);
        await process.WaitForExitAsync(deadline.Token); var raw = await stdout; await stderr;
        if (process.ExitCode != 0) throw new IOException("desktop_unavailable");
        var data = string.IsNullOrWhiteSpace(raw) ? new JsonArray() : JsonNode.Parse(raw);
        var candidates = data is JsonArray list ? list : new JsonArray(data);
        var sid = WindowsIdentity.GetCurrent().User!.Value;
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(3) };
        foreach (var candidate in candidates.OfType<JsonObject>().Where(p => p["sid"]?.GetValue<string>() == sid && p["shared"]?.GetValue<bool>() != true))
        {
            var port = candidate["port"]!.GetValue<int>(); if (port is < 1 or > 65535) continue;
            try
            {
                var targets = JsonNode.Parse(await http.GetStringAsync($"http://127.0.0.1:{port}/json/list", token)) as JsonArray ?? new();
                var endpoint = ValidateTarget(port, targets);
                var socket = new ClientWebSocket(); socket.Options.Proxy = null;
                try
                {
                    await socket.ConnectAsync(endpoint, deadline.Token);
                    var transport = new DesktopCdp(socket) { ProcessId = candidate["pid"]!.GetValue<int>() };
                    try { await transport.BootstrapAsync(deadline.Token); return transport; }
                    catch { await transport.DisposeAsync(); throw; }
                }
                catch { socket.Dispose(); throw; }
            }
            catch (Exception error) when (error is HttpRequestException or IOException or WebSocketException or JsonException) { }
        }
        throw new IOException("desktop_cdp_unavailable");
    }

    private async Task BootstrapAsync(CancellationToken token)
    {
        await CallAsync("Runtime.enable", new(), token);
        await CallAsync("Runtime.addBinding", new() { ["name"] = _binding }, token);
        using var source = typeof(DesktopCdp).Assembly.GetManifestResourceStream("LanPower.DesktopRenderer.js") ?? throw new IOException("desktop_adapter_unavailable");
        var bootstrap = await new StreamReader(source).ReadToEndAsync(token);
        var result = await EvaluateAsync(bootstrap.Replace("__LANPOWER_GLOBAL__", _global).Replace("__LANPOWER_BINDING__", _binding), token);
        if (result?["protocol"]?.GetValue<int>() != 1 || result?["hostId"]?.GetValue<string>() != "local") throw new IOException("desktop_incompatible");
    }

    public async Task SendAsync(JsonObject payload, CancellationToken token)
    {
        if (payload["method"]?.GetValue<string>() is { } method)
        {
            if (method == "initialized") return;
            var id = payload["id"]?.DeepClone(); if (id is null) return;
            JsonObject response;
            try
            {
                var result = method == "initialize" ? new JsonObject { ["userAgent"] = "LanPower Desktop Bridge" } :
                    await RpcAsync(method, payload["params"]?.DeepClone() ?? new JsonObject(), token);
                response = new() { ["id"] = id, ["result"] = result };
            }
            catch (IOException error) { response = new() { ["id"] = id, ["error"] = new JsonObject { ["code"] = error is DesktopRpcException rpc ? rpc.Code : -32000, ["message"] = error is DesktopRpcException native ? native.Message : "desktop_request_failed" } }; }
            await _frames.Writer.WriteAsync(response.ToJsonString(), token);
        }
        else await RpcAsync("codex-web/local/server-requests/respond", payload.DeepClone(), token);
    }

    private sealed class DesktopRpcException(int code, string message) : IOException(message) { public int Code { get; } = code; }
    private async Task<JsonNode?> RpcAsync(string method, JsonNode parameters, CancellationToken token)
    {
        // Only fixed error categories cross the CDP boundary; never forward renderer stacks or task content.
        var response = await EvaluateAsync($"(async()=>{{const a=globalThis[{JsonSerializer.Serialize(_global)}];try{{if(!a)throw new Error('bridge unavailable');return {{ok:true,result:await a.rpc({JsonSerializer.Serialize(method)},{parameters.ToJsonString()})}};}}catch(e){{let missing=false;let c=e;for(let i=0;c&&i<4;i++,c=c.cause){{if(String(c.message||c).toLowerCase().includes('no rollout found for thread id'))missing=true;}}return {{ok:false,code:typeof e?.code==='number'?e.code:-32000,missing}};}}}})()", token);
        if (response?["ok"]?.GetValue<bool>() != true)
        {
            var missing = response?["missing"]?.GetValue<bool>() == true;
            throw new DesktopRpcException(missing ? -32600 : response?["code"]?.GetValue<int>() ?? -32000,
                missing && parameters["threadId"] is not null ? "no rollout found for thread id " + parameters["threadId"]!.GetValue<string>() : "desktop_request_failed");
        }
        return response?["result"]?.DeepClone();
    }

    private async Task<JsonNode?> EvaluateAsync(string expression, CancellationToken token)
    {
        var response = await CallAsync("Runtime.evaluate", new() { ["expression"] = expression, ["awaitPromise"] = true, ["returnByValue"] = true }, token);
        if (response["error"] is not null || response["result"]?["exceptionDetails"] is not null) throw new IOException("desktop_request_failed");
        return response["result"]?["result"]?["value"]?.DeepClone();
    }

    private async Task<JsonObject> CallAsync(string method, JsonObject parameters, CancellationToken token)
    {
        var id = Interlocked.Increment(ref _sequence); var call = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        _calls[id] = call;
        try
        {
            var bytes = Encoding.UTF8.GetBytes(new JsonObject { ["id"] = id, ["method"] = method, ["params"] = parameters }.ToJsonString());
            await _write.WaitAsync(token);
            try { await _socket.SendAsync(bytes.AsMemory(), WebSocketMessageType.Text, true, token); } finally { _write.Release(); }
            return await call.Task.WaitAsync(TimeSpan.FromSeconds(30), token);
        }
        finally { _calls.TryRemove(id, out _); }
    }

    public static JsonObject? NormalizeEvent(JsonObject bridge)
    {
        if (bridge["kind"]?.GetValue<string>() != "notification" || bridge["payload"] is not JsonObject payload) return null;
        var method = payload["method"]?.GetValue<string>();
        if (method == "server/request" && payload["params"] is JsonObject request)
            return new() { ["id"] = request["id"]?.DeepClone(), ["method"] = request["method"]?.DeepClone(), ["params"] = request["params"]?.DeepClone() };
        if (method == "server/request/resolved") return new() { ["method"] = "serverRequest/resolved", ["params"] = new JsonObject { ["requestId"] = payload["params"]?["id"]?.DeepClone() } };
        return method is null ? null : (JsonObject)payload.DeepClone();
    }

    private async Task ReceiveAsync()
    {
        try
        {
            var buffer = new byte[16384];
            while (!_lifetime.IsCancellationRequested)
            {
                using var data = new MemoryStream(); WebSocketReceiveResult frame;
                do
                {
                    frame = await _socket.ReceiveAsync(buffer, _lifetime.Token);
                    if (frame.MessageType == WebSocketMessageType.Close) return;
                    if (frame.MessageType != WebSocketMessageType.Text || data.Length + frame.Count > 16 * 1024 * 1024) throw new IOException("desktop_frame_too_large");
                    data.Write(buffer, 0, frame.Count);
                } while (!frame.EndOfMessage);
                var message = JsonNode.Parse(data.GetBuffer().AsSpan(0, (int)data.Length)) as JsonObject ?? throw new IOException("desktop_invalid_frame");
                if (message["id"] is JsonValue id && id.TryGetValue<int>(out var n) && _calls.TryRemove(n, out var pending)) { pending.TrySetResult(message); continue; }
                if (message["method"]?.GetValue<string>() != "Runtime.bindingCalled" || message["params"]?["name"]?.GetValue<string>() != _binding) continue;
                var bridge = JsonNode.Parse(message["params"]!["payload"]!.GetValue<string>()) as JsonObject;
                if (bridge is not null && NormalizeEvent(bridge) is { } notification && !_frames.Writer.TryWrite(notification.ToJsonString()))
                    throw new IOException("desktop_backpressure");
            }
        }
        catch (Exception error) when (error is IOException or JsonException or WebSocketException or OperationCanceledException or InvalidOperationException) { }
        finally { foreach (var call in _calls.Values) call.TrySetException(new IOException("desktop_disconnected")); _frames.Writer.TryComplete(); }
    }

    private async Task<string?> ReadFrame(CancellationToken token)
    { while (await _frames.Reader.WaitToReadAsync(token)) if (_frames.Reader.TryRead(out var frame)) return frame; return null; }

    public async ValueTask DisposeAsync()
    {
        if (Running) try { using var deadline = new CancellationTokenSource(1500); await EvaluateAsync($"globalThis[{JsonSerializer.Serialize(_global)}]?.dispose()", deadline.Token); } catch { }
        _lifetime.Cancel(); _socket.Abort(); try { await _reader; } catch { }
        _socket.Dispose(); _lifetime.Dispose(); _write.Dispose();
    }
}
