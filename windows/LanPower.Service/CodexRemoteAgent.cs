using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using LanPower.Shared;

namespace LanPower.Service;

public sealed class CodexRemoteAgent(CloudTokenSession tokens, CodexHostBridge bridge, ServiceLog log) : BackgroundService
{
    public string State { get; private set; } = "cloud_offline";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var delay = 2;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var access = await tokens.GetAccessAsync(stoppingToken);
                var origin = new Uri(CloudEnrollment.NormalizeOrigin(access.Credentials.CloudUrl));
                using var socket = new ClientWebSocket();
                socket.Options.Proxy = null;
                socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                socket.Options.KeepAliveTimeout = TimeSpan.FromSeconds(30);
                socket.Options.AddSubProtocol(CodexRemoteProtocol.WebSocketProtocol);
                socket.Options.SetRequestHeader("Authorization", "Bearer " + access.Token);
                var uri = new UriBuilder(origin) { Scheme = "wss", Path = "/api/v2/remote/agent" }.Uri;
                await socket.ConnectAsync(uri, stoppingToken);
                delay = 2;
                State = "connected";
                var output = Channel.CreateBounded<string>(new BoundedChannelOptions(16) { FullMode = BoundedChannelFullMode.Wait });
                using var connection = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                void Forward(string raw)
                {
                    if (!output.Writer.TryWrite(raw)) connection.Cancel();
                }
                bridge.Message += Forward;
                try
                {
                    Forward(JsonSerializer.Serialize(new { type = "hello", protocol = 1,
                        state = bridge.State == "host_offline" ? "host_offline" : bridge.State == "disabled" ? "disabled" : "host_ready" }));
                    async Task Send()
                    {
                        await foreach (var raw in output.Reader.ReadAllAsync(connection.Token))
                            await socket.SendAsync(Encoding.UTF8.GetBytes(raw), WebSocketMessageType.Text, true, connection.Token);
                    }
                    async Task Receive()
                    {
                        var buffer = new byte[65536];
                        while (!connection.IsCancellationRequested)
                        {
                            using var body = new MemoryStream();
                            WebSocketReceiveResult result;
                            do
                            {
                                result = await socket.ReceiveAsync(buffer, connection.Token);
                                if (result.MessageType == WebSocketMessageType.Close) return;
                                if (result.MessageType != WebSocketMessageType.Text || body.Length + result.Count > CodexRemoteProtocol.MaxFrame)
                                    throw new InvalidDataException("invalid_frame");
                                body.Write(buffer, 0, result.Count);
                            } while (!result.EndOfMessage);
                            var frame = CodexRemoteProtocol.Parse(new UTF8Encoding(false, true).GetString(body.ToArray()));
                            if (frame["type"]?.GetValue<string>() == "ping") Forward("{\"type\":\"pong\"}");
                            else if (frame["type"]?.GetValue<string>() != "pong") await bridge.ForwardAsync(frame, connection.Token);
                        }
                    }
                    // Rotation of the shared single-use token invalidates the old access token.
                    async Task CredentialWatch()
                    {
                        while (true)
                        {
                            await Task.Delay(5000, connection.Token);
                            var cached = await tokens.GetCachedAccessAsync(connection.Token);
                            if (cached is null || cached.Credentials.DeviceId != access.Credentials.DeviceId || cached.Token != access.Token) return;
                        }
                    }
                    var tasks = new[] { Send(), Receive(), CredentialWatch() };
                    var finished = await Task.WhenAny(tasks);
                    connection.Cancel();
                    try { await finished; }
                    finally { try { await Task.WhenAll(tasks); } catch (OperationCanceledException) { } }
                }
                finally { bridge.Message -= Forward; }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) when (error is IOException or WebSocketException or HttpRequestException or
                UnauthorizedAccessException or JsonException or InvalidOperationException or System.Security.Cryptography.CryptographicException)
            {
                // Exception messages can contain response URLs or credentials.
                if (delay == 2) log.Write("Codex Remote 连接等待重试：" + error.GetType().Name);
            }
            finally { State = "cloud_offline"; }
            await Task.Delay(TimeSpan.FromSeconds(delay) + TimeSpan.FromMilliseconds(Random.Shared.Next(500)), stoppingToken);
            delay = Math.Min(60, delay * 2);
        }
    }
}
