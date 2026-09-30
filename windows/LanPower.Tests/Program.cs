using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using LanPower.Shared;

var token = new string('a', 64);
var config = new LanConfig
{
    Token = token,
    HostIp = "127.0.0.1",
    AllowedNetworks = ["127.0.0.0/8"],
    Port = 48211
};
config.Validate();
Check(config.IsAllowed(IPAddress.Loopback), "loopback allowed");
Check(config.IsAllowed(IPAddress.Parse("127.10.1.1")), "subnet allowed");
Check(!config.IsAllowed(IPAddress.Parse("10.0.0.2")), "outside subnet denied");
Check(config.IsAuthorized("Bearer " + token), "valid bearer token");
Check(!config.IsAuthorized("Bearer " + new string('b', 64)), "invalid bearer token denied");
Check(!config.IsAuthorized("Basic " + token), "other auth scheme denied");
Check(!LanProtocol.IsPowerAction("wake") && !LanProtocol.IsPowerAction("cmd"), "power action allowlist");
var gate = new PowerGate();
Check(gate.TryAccept() && !gate.TryAccept(), "rate limit");
var invalid = new LanConfig { Token = "short", HostIp = "127.0.0.1", AllowedNetworks = ["127.0.0.0/8"] };
try
{
    invalid.Validate();
    throw new Exception("invalid token accepted");
}
catch (InvalidDataException) { }

var repo = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
if (args.Length > 1) throw new ArgumentException("Expected an optional service executable path.");
var serviceExe = args.Length == 1 ? Path.GetFullPath(args[0])
    : Path.Combine(repo, "windows", "LanPower.Service", "bin", "Release", "net10.0-windows", "LanPower.Service.exe");
Check(File.Exists(serviceExe), "service build exists");
using var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
config.Port = ((IPEndPoint)listener.LocalEndpoint).Port;
listener.Stop();
var tempDir = Path.Combine(Path.GetTempPath(), "LanPowerTests", Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(tempDir);
var configPath = Path.Combine(tempDir, "config.json");
File.WriteAllText(configPath, JsonSerializer.Serialize(config));
using var service = Process.Start(new ProcessStartInfo(serviceExe)
{
    ArgumentList = { "--config", configPath, "--dry-run" },
    UseShellExecute = false,
    WorkingDirectory = Path.GetDirectoryName(serviceExe)!,
    CreateNoWindow = true
}) ?? throw new Exception("service did not start");
try
{
    using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{config.Port}"), Timeout = TimeSpan.FromSeconds(3) };
    var ready = false;
    for (var i = 0; i < 40; i++)
    {
        try
        {
            using var response = await client.GetAsync("/");
            if (response.IsSuccessStatusCode) { ready = true; break; }
        }
        catch (HttpRequestException) { }
        await Task.Delay(150);
    }
    Check(ready, "service responds on LAN port");
    Check((int)(await client.GetAsync("/api/status")).StatusCode == 401, "status requires pairing");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    using var status = await client.GetAsync("/api/status");
    Check(status.IsSuccessStatusCode && (await status.Content.ReadAsStringAsync()).Contains("online"), "legacy status response");
    using var setup = await client.GetAsync("/setup");
    Check(setup.IsSuccessStatusCode && (await setup.Content.ReadAsStringAsync()).Contains(token), "loopback pairing page");
    using var qr = await client.GetAsync("/setup/qr.svg");
    Check(qr.IsSuccessStatusCode && (await qr.Content.ReadAsStringAsync()).Contains("<svg"), "pairing QR code");
    using var invalidAction = await client.PostAsync("/api/power", new StringContent("{\"action\":\"wake\"}", Encoding.UTF8, "application/json"));
    Check((int)invalidAction.StatusCode == 400, "wake is not a local power action");
    using var accepted = await client.PostAsync("/api/power", new StringContent("{\"action\":\"shutdown\"}", Encoding.UTF8, "application/json"));
    Check((int)accepted.StatusCode == 202, "legacy power response");
    using var duplicate = await client.PostAsync("/api/power", new StringContent("{\"action\":\"restart\"}", Encoding.UTF8, "application/json"));
    Check((int)duplicate.StatusCode == 409, "power command cooldown");

    await using var pipe = new NamedPipeClientStream(".", LanProtocol.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
    await pipe.ConnectAsync(3000);
    using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
    await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
    await writer.WriteLineAsync("status");
    var ipc = await reader.ReadLineAsync();
    Check(ipc is not null && ipc.Contains("lan_ip") && ipc.Contains("127.0.0.1"), "desktop status over named pipe");
    using var disconnect = await RequestPipeAsync("{\"op\":\"cloud_disconnect\"}");
    Check(disconnect.RootElement.GetProperty("ok").GetBoolean(), "unconfigured Cloud can be disconnected through IPC");
    using var extraTarget = await RequestPipeAsync("{\"op\":\"cloud_disconnect\",\"device_id\":\"other\"}");
    Check(!extraTarget.RootElement.GetProperty("ok").GetBoolean(), "IPC disconnect rejects extra targets");
    Check((await client.GetAsync("/api/status")).IsSuccessStatusCode, "LAN remains paired after Cloud disconnect");
    using var networkSettings = await RequestPipeAsync("network_settings");
    Check(networkSettings.RootElement.GetProperty("ok").GetBoolean() && !networkSettings.RootElement.GetRawText().Contains(token),
        "network settings contain no pairing credential");
    using var invalidAdapter = await RequestPipeAsync("{\"op\":\"network_save\",\"adapter_id\":\"not-an-adapter\",\"automatic\":true}");
    Check(!invalidAdapter.RootElement.GetProperty("ok").GetBoolean(), "network settings reject arbitrary adapter identifiers");
    Console.WriteLine("LanPower Windows tests passed");
}
finally
{
    if (!service.HasExited) service.Kill(entireProcessTree: true);
    service.WaitForExit(5000);
    Directory.Delete(tempDir, recursive: true);
}

static void Check(bool condition, string message)
{
    if (!condition) throw new Exception("FAILED: " + message);
    Console.WriteLine("PASS: " + message);
}

static async Task<JsonDocument> RequestPipeAsync(string command)
{
    await using var pipe = new NamedPipeClientStream(".", LanProtocol.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
    await pipe.ConnectAsync(3000);
    using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
    await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
    await writer.WriteLineAsync(command);
    return JsonDocument.Parse(await reader.ReadLineAsync() ?? throw new IOException("IPC disconnected"));
}
