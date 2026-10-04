using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.CodexHost;

public sealed record SharedCodexConnection(string Endpoint, string Bearer, string DesktopEndpoint);

public static class SharedCodexServer
{
    private static string Identity => WindowsIdentity.GetCurrent().User!.Value;
    private static string PipeName => "LanPower.CodexShared." + Identity;
    public static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LanPower", "CodexShared");

    public static async Task<SharedCodexConnection> EnsureAsync(CancellationToken token)
    {
        async Task<SharedCodexConnection> Read(int timeout)
        {
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.In, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.ConnectAsync(timeout, token);
            using var reader = new StreamReader(pipe, new UTF8Encoding(false, true));
            var raw = await CodexRemoteProtocol.ReadLineAsync(reader, token, 4096);
            var connection = JsonSerializer.Deserialize<SharedCodexConnection>(raw ?? "") ?? throw new IOException("shared_runtime_unavailable");
            ValidateConnection(connection); return connection;
        }
        try { return await Read(250); }
        catch (TimeoutException)
        {
            var executable = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "CodexServer", LanProtocol.Version, "LanPower.CodexServer.exe"));
            if (!File.Exists(executable)) throw new IOException("shared_runtime_not_installed");
            Process.Start(new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true });
            return await Read(15000);
        }
    }

    public static void ValidateConnection(SharedCodexConnection connection)
    {
        bool Local(string value, out Uri? uri) => Uri.TryCreate(value, UriKind.Absolute, out uri) &&
            uri.Scheme == "ws" && uri.Host == "127.0.0.1" && uri.Port > 0 && string.IsNullOrEmpty(uri.UserInfo) &&
            string.IsNullOrEmpty(uri.Query) && string.IsNullOrEmpty(uri.Fragment);
        if (!Local(connection.Endpoint, out var endpoint) || endpoint!.AbsolutePath != "/" ||
            !Local(connection.DesktopEndpoint, out var desktop) || desktop!.AbsolutePath.Length != 65 ||
            !desktop.AbsolutePath[1..].All(Uri.IsHexDigit) || connection.Bearer is not { Length: 64 } bearer || !bearer.All(Uri.IsHexDigit))
            throw new InvalidDataException("invalid_shared_endpoint");
    }

    public static async Task OpenDesktopAsync(CancellationToken token)
    {
        var connection = await EnsureAsync(token);
        var applications = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var packages = Path.Combine(applications, "WindowsApps");
        var executable = Directory.EnumerateDirectories(packages, "OpenAI.Codex_*_x64__2p2nqsd0c76g0")
            .OrderByDescending(folder => Version.TryParse(Path.GetFileName(folder).Split('_')[1], out var version) ? version : new Version())
            .Select(folder => Path.Combine(folder, "app", "ChatGPT.exe")).FirstOrDefault(File.Exists)
            ?? throw new IOException("native_desktop_not_installed");
        var profile = Path.Combine(Root, "Desktop"); Directory.CreateDirectory(profile);
        var start = new ProcessStartInfo(executable) { UseShellExecute = false };
        start.Environment.Remove("ELECTRON_RUN_AS_NODE"); start.Environment.Remove("NODE_OPTIONS");
        start.Environment.Remove("CODEX_APP_SERVER_FORCE_CLI");
        start.Environment["CODEX_APP_SERVER_WS_URL"] = connection.DesktopEndpoint;
        start.Environment["CODEX_ELECTRON_USER_DATA_PATH"] = profile;
        start.ArgumentList.Add("--user-data-dir=" + profile);
        start.ArgumentList.Add("codex://threads/new?mode=codex");
        Process.Start(start);
    }

    public static async Task RunAsync(CancellationToken token)
    {
        if (!Environment.UserInteractive || WindowsIdentity.GetCurrent().IsSystem) return;
        using var instance = new Mutex(true, @"Local\" + PipeName, out var owns); if (!owns) return;
        Directory.CreateDirectory(Root);
        var acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(Root).SetAccessControl(acl);
        var bearer = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var gate = "/" + Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var tokenFile = Path.Combine(Root, "token-" + Guid.NewGuid().ToString("N")); File.WriteAllText(tokenFile, bearer);
        try
        {
            var reserve = new TcpListener(IPAddress.Loopback, 0); reserve.Start(); var enginePort = ((IPEndPoint)reserve.LocalEndpoint).Port; reserve.Stop();
            using var gateway = new TcpListener(IPAddress.Loopback, 0); gateway.Start(16);
            var start = new ProcessStartInfo(RuntimeClient.FindExecutable(CodexHostSettings.Load())) {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in new[] { "app-server", "--listen", "ws://127.0.0.1:" + enginePort, "--ws-auth", "capability-token", "--ws-token-file", tokenFile })
                start.ArgumentList.Add(arg);
            using var engine = Process.Start(start) ?? throw new IOException("runtime_unavailable");
            RuntimeJob job;
            try { job = new RuntimeJob(engine.Handle); }
            catch { if (!engine.HasExited) engine.Kill(true); gateway.Stop(); throw; }
            using var ownedJob = job;
            using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
            var discard = new[] { DiscardAsync(engine.StandardOutput, lifetime.Token), DiscardAsync(engine.StandardError, lifetime.Token) };
            var engineUri = new Uri("ws://127.0.0.1:" + enginePort);
            var connection = new SharedCodexConnection(engineUri.AbsoluteUri, bearer, "ws://127.0.0.1:" + ((IPEndPoint)gateway.LocalEndpoint).Port + gate);
            var slots = new SemaphoreSlim(16, 16);
            try
            {
                // Publish credentials only after an authenticated app-server connection succeeds.
                var ready = false;
                for (var attempt = 0; attempt < 100 && !engine.HasExited; attempt++)
                {
                    try { await using var check = await RuntimeClient.ConnectAsync(engineUri, bearer, token); ready = true; break; }
                    catch (IOException) { await Task.Delay(100, token); }
                }
                if (!ready) throw new IOException("shared_runtime_unavailable");
                async Task ServeDesktop()
                {
                    while (!lifetime.IsCancellationRequested)
                    {
                        var socket = await gateway.AcceptTcpClientAsync(lifetime.Token);
                        if (!slots.Wait(0)) { socket.Dispose(); continue; }
                        _ = Task.Run(async () => { try { await ProxyAsync(socket, gate, engineUri, bearer, lifetime.Token); }
                            catch (Exception error) when (error is IOException or WebSocketException or OperationCanceledException or InvalidDataException or ArgumentException) { }
                            finally { socket.Dispose(); slots.Release(); } });
                    }
                }
                async Task ServeConnection()
                {
                    while (!lifetime.IsCancellationRequested)
                    {
                        using var pipe = new NamedPipeServerStream(PipeName, PipeDirection.Out, 1, PipeTransmissionMode.Byte,
                            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                        await pipe.WaitForConnectionAsync(lifetime.Token);
                        try
                        {
                            using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true);
                            await writer.WriteLineAsync(JsonSerializer.Serialize(connection).AsMemory(), lifetime.Token); await writer.FlushAsync(lifetime.Token);
                        }
                        catch (IOException) { } // A disconnected client must not terminate the shared engine.
                    }
                }
                await await Task.WhenAny(ServeConnection(), ServeDesktop(), engine.WaitForExitAsync(lifetime.Token));
            }
            finally
            {
                lifetime.Cancel(); gateway.Stop(); if (!engine.HasExited) engine.Kill(true);
                try { await Task.WhenAll(discard); } catch (OperationCanceledException) { }
            }
        }
        finally { File.Delete(tokenFile); }
    }

    private static async Task DiscardAsync(StreamReader reader, CancellationToken token)
    { var buffer = new char[4096]; while (await reader.ReadAsync(buffer.AsMemory(), token) > 0) { } }

    private static async Task ProxyAsync(TcpClient socket, string gate, Uri endpoint, string bearer, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(10));
        var stream = socket.GetStream(); var header = new List<byte>(); var one = new byte[1];
        while (header.Count < 16384)
        {
            if (await stream.ReadAsync(one, deadline.Token) != 1) return; header.Add(one[0]);
            if (header.Count >= 4 && header.TakeLast(4).SequenceEqual(new byte[] { 13, 10, 13, 10 })) break;
        }
        if (!header.TakeLast(4).SequenceEqual(new byte[] { 13, 10, 13, 10 })) return;
        var lines = Encoding.ASCII.GetString(header.ToArray()).Split("\r\n");
        if (lines[0] != "GET " + gate + " HTTP/1.1") return;
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1).Where(line => line.Length != 0))
        { var split = line.IndexOf(':'); if (split <= 0 || !fields.TryAdd(line[..split], line[(split + 1)..].Trim())) return; }
        if (fields.ContainsKey("Origin") || fields.ContainsKey("Content-Length") || fields.ContainsKey("Transfer-Encoding") ||
            fields.GetValueOrDefault("Upgrade")?.Equals("websocket", StringComparison.OrdinalIgnoreCase) != true ||
            fields.GetValueOrDefault("Connection")?.Split(',').Any(value => value.Trim().Equals("Upgrade", StringComparison.OrdinalIgnoreCase)) != true ||
            fields.GetValueOrDefault("Sec-WebSocket-Version") != "13" || !fields.TryGetValue("Sec-WebSocket-Key", out var key)) return;
        try { if (Convert.FromBase64String(key).Length != 16) return; } catch (FormatException) { return; }
        using var upstream = new ClientWebSocket(); upstream.Options.SetRequestHeader("Authorization", "Bearer " + bearer);
        await upstream.ConnectAsync(endpoint, deadline.Token);
        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"), deadline.Token);
        using var downstream = WebSocket.CreateFromStream(stream, true, null, TimeSpan.FromSeconds(20));
        using var relay = CancellationTokenSource.CreateLinkedTokenSource(token);
        async Task Copy(WebSocket from, WebSocket to)
        {
            var buffer = new byte[16384];
            while (!relay.IsCancellationRequested)
            {
                var frame = await from.ReceiveAsync(buffer.AsMemory(), relay.Token);
                if (frame.MessageType == WebSocketMessageType.Close) return;
                if (frame.MessageType != WebSocketMessageType.Text) throw new InvalidDataException("invalid_frame");
                await to.SendAsync(buffer.AsMemory(0, frame.Count), frame.MessageType, frame.EndOfMessage, relay.Token);
            }
        }
        var copies = new[] { Copy(upstream, downstream), Copy(downstream, upstream) };
        await Task.WhenAny(copies); relay.Cancel(); downstream.Abort(); upstream.Abort();
        try { await Task.WhenAll(copies); } catch (Exception error) when (error is OperationCanceledException or WebSocketException or IOException) { }
    }
}
