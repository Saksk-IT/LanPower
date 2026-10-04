using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using LanPower.Service;
using LanPower.Shared;
using QRCoder;

var configPath = ArgumentValue(args, "--config") ?? Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "LanPower", "config.json");
var dryRun = args.Contains("--dry-run", StringComparer.Ordinal);
var config = LanConfig.Load(configPath);
var serviceLog = new ServiceLog(Path.Combine(Path.GetDirectoryName(configPath)!, "logs", "service.log"));
var dataDirectory = Path.GetDirectoryName(configPath)!;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory
});
builder.Host.UseWindowsService(options => options.ServiceName = "LanPowerService");
builder.WebHost.ConfigureKestrel(options => options.ListenAnyIP(config.Port));
builder.Services.AddSingleton(config);
builder.Services.AddSingleton(serviceLog);
builder.Services.AddSingleton(new PowerExecutor(dryRun, serviceLog));
builder.Services.AddSingleton<PowerGate>();
var network = new LanNetworkManager(config, new LanConfigStore(configPath),
    dryRun ? new DryRunLanFirewall() : new LanFirewall(), serviceLog);
builder.Services.AddSingleton(network);
builder.Services.AddSingleton<Func<LocalNetworkSnapshot>>(network.ReadStatus);
builder.Services.AddSingleton<Func<LanConfig>>(() => network.Config);
builder.Services.AddSingleton<WakeProfileService>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<LanNetworkManager>());
builder.Services.AddSingleton(new CloudCredentialStore(dataDirectory));
builder.Services.AddSingleton(new ReplayStore(dataDirectory));
// The LocalSystem agent uses direct HTTPS independently of a desktop user's proxy.
builder.Services.AddSingleton(new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false })
    { Timeout = TimeSpan.FromSeconds(35) });
builder.Services.AddSingleton<CloudAgent>();
builder.Services.AddSingleton(provider => new CloudTokenSession(provider.GetRequiredService<HttpClient>(),
    provider.GetRequiredService<CloudCredentialStore>()));
builder.Services.AddSingleton(new CodexHostBridge(dryRun));
builder.Services.AddHostedService(provider => provider.GetRequiredService<CodexHostBridge>());
builder.Services.AddSingleton<CodexRemoteAgent>();
if (!dryRun) builder.Services.AddHostedService(provider => provider.GetRequiredService<CodexRemoteAgent>());
builder.Services.AddSingleton<LocalStatusAccess>();
builder.Services.AddHostedService(provider => provider.GetRequiredService<CloudAgent>());
builder.Services.AddHostedService(provider => new PipeWorker(provider.GetRequiredService<CloudAgent>(),
    provider.GetRequiredService<ServiceLog>(), provider.GetRequiredService<LanNetworkManager>(), dryRun,
    provider.GetRequiredService<LocalStatusAccess>(), provider.GetRequiredService<CodexHostBridge>(),
    provider.GetRequiredService<CodexRemoteAgent>()));
var app = builder.Build();

app.Use(async (context, next) =>
{
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers.XContentTypeOptions = "nosniff";
    context.Response.Headers.XFrameOptions = "DENY";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    context.Response.Headers.ContentSecurityPolicy =
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
    if (!network.IsAllowed(context.Connection.RemoteIpAddress, context.Connection.LocalIpAddress))
    {
        await JsonError(context, 403, "local network only");
        return;
    }
    await next(context);
});

app.MapGet("/api/status", (HttpContext context, CloudAgent cloud, LocalStatusAccess desktop,
    CodexRemoteAgent remote, CodexHostBridge host) =>
    config.IsAuthorized(context.Request.Headers.Authorization) ||
    desktop.IsAuthorized(context.Connection.RemoteIpAddress, context.Request.Headers.Authorization) ?
        Results.Json(new { ok = true, device = Environment.MachineName, state = "online",
            cloud_connected = cloud.CloudConnected, cloud_last_seen = cloud.CloudLastSeen,
            codex_remote = remote.State == "connected" ? host.State : "cloud_offline" }) :
        Results.Json(new { error = "not paired" }, statusCode: 401));

app.MapGet("/api/wake-profile", (HttpContext context, CloudAgent cloud) =>
    cloud.ReadWakeProfile(context.Request.Headers.Authorization) is { } profile
        ? Results.Json(profile)
        : Results.Json(new { error = "wake profile unavailable" }, statusCode: 401));

app.MapPost("/api/power", async (HttpContext context, PowerGate gate, CloudAgent cloud) =>
{
    if (!config.IsAuthorized(context.Request.Headers.Authorization))
        return Results.Json(new { error = "not paired" }, statusCode: 401);
    if (context.Request.ContentLength is null or < 1 or > 512)
        return Results.Json(new { error = "invalid body size" }, statusCode: 400);
    string? action;
    try
    {
        using var document = await JsonDocument.ParseAsync(context.Request.Body);
        action = document.RootElement.ValueKind == JsonValueKind.Object &&
                 document.RootElement.TryGetProperty("action", out var element) &&
                 element.ValueKind == JsonValueKind.String ? element.GetString() : null;
    }
    catch (JsonException)
    {
        return Results.Json(new { error = "invalid JSON" }, statusCode: 400);
    }
    if (!LanProtocol.IsPowerAction(action))
        return Results.Json(new { error = "unknown action" }, statusCode: 400);
    if (!gate.TryAccept())
        return Results.Json(new { error = "wait before sending another command" }, statusCode: 409);
    _ = cloud.ExecutePowerAsync(action!);
    serviceLog.Write("已接收 LAN 电源命令：" + action);
    return Results.Json(new { ok = true, action }, statusCode: 202);
});

app.MapGet("/setup", (HttpContext context) =>
{
    if (!IsLocal(context)) return Results.Json(new { error = "open setup on the PC" }, statusCode: 403);
    var current = network.Config;
    var url = $"http://{current.HostIp}:{current.Port}/#access={current.Token}";
    var safeUrl = HtmlEncoder.Default.Encode(url);
    var html = """
        <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1"><title>CodexDock 配对</title>
        <link rel="stylesheet" href="/app.css"></head><body><main class="setup">
        <div class="setup-card"><p class="eyebrow">仅在这台电脑上显示</p><h1>用手机扫码配对</h1>
        <p>让手机连接家中的 Wi-Fi，在微信小程序中扫描此二维码。</p>
        <img src="/setup/qr.svg" alt="手机配对二维码" class="qr">
        <p class="small">也可以将下方链接复制到手机浏览器。请勿分享配对链接。</p>
        <code class="pair-url">URL_PLACEHOLDER</code></div></main></body></html>
        """.Replace("URL_PLACEHOLDER", safeUrl, StringComparison.Ordinal);
    return Results.Content(html, "text/html; charset=utf-8");
});

app.MapGet("/setup/qr.svg", (HttpContext context) =>
{
    if (!IsLocal(context)) return Results.Json(new { error = "open setup on the PC" }, statusCode: 403);
    var current = network.Config;
    var url = $"http://{current.HostIp}:{current.Port}/#access={current.Token}";
    using var qrData = QRCodeGenerator.GenerateQrCode(url, QRCodeGenerator.ECCLevel.Q);
    using var svg = new SvgQRCode(qrData);
    return Results.Content(svg.GetGraphic(6), "image/svg+xml; charset=utf-8");
});

app.MapGet("/setup/qr.png", (HttpContext context) =>
{
    if (!IsLocal(context)) return Results.Json(new { error = "open setup on the PC" }, statusCode: 403);
    var current = network.Config;
    var url = $"http://{current.HostIp}:{current.Port}/#access={current.Token}";
    using var qrData = QRCodeGenerator.GenerateQrCode(url, QRCodeGenerator.ECCLevel.Q);
    using var png = new PngByteQRCode(qrData);
    return Results.Bytes(png.GetGraphic(8), "image/png");
});

var assets = new Dictionary<string, (string File, string Type)>
{
    ["/"] = ("index.html", "text/html; charset=utf-8"),
    ["/app.js"] = ("app.js", "text/javascript; charset=utf-8"),
    ["/app.css"] = ("app.css", "text/css; charset=utf-8"),
    ["/icon.svg"] = ("icon.svg", "image/svg+xml")
};
foreach (var (path, asset) in assets)
{
    app.MapGet(path, () => Results.File(Path.Combine(AppContext.BaseDirectory, "static", asset.File), asset.Type));
}

serviceLog.Write($"LAN 服务启动，端口 {config.Port}");
await app.RunAsync();

static bool IsLocal(HttpContext context) => context.Connection.RemoteIpAddress is { } remote && IPAddress.IsLoopback(remote);

static Task JsonError(HttpContext context, int status, string error)
{
    context.Response.StatusCode = status;
    return context.Response.WriteAsJsonAsync(new { error });
}

static string? ArgumentValue(string[] arguments, string name)
{
    var index = Array.IndexOf(arguments, name);
    return index >= 0 && index + 1 < arguments.Length ? arguments[index + 1] : null;
}
