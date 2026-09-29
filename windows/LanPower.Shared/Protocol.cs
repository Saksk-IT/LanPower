using System.Text.Json.Serialization;

namespace LanPower.Shared;

public static class LanProtocol
{
    public const string PipeName = "LanPower.Service";
    public static readonly string[] Actions = ["sleep", "hibernate", "restart", "shutdown"];

    public static bool IsPowerAction(string? action) => action is "sleep" or "hibernate" or "restart" or "shutdown";
}

public sealed record ServiceStatus(
    [property: JsonPropertyName("device")] string Device,
    [property: JsonPropertyName("lan_ip")] string LanIp,
    [property: JsonPropertyName("mac")] string Mac,
    [property: JsonPropertyName("wol_state")] string WolState,
    [property: JsonPropertyName("lan_state")] string LanState,
    [property: JsonPropertyName("cloud_state")] string CloudState,
    [property: JsonPropertyName("gateway_state")] string GatewayState,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("cloud_url")] string CloudUrl = "");

public sealed record CloudPairing(Guid Id, string UserCode, string VerificationUri, long ExpiresAt, int Interval);

public sealed class PowerGate
{
    private readonly TimeProvider _clock;
    private readonly object _sync = new();
    private DateTimeOffset _lastAccepted = DateTimeOffset.MinValue;

    public PowerGate(TimeProvider? clock = null) => _clock = clock ?? TimeProvider.System;

    public bool TryAccept()
    {
        lock (_sync)
        {
            var now = _clock.GetUtcNow();
            if (now - _lastAccepted < TimeSpan.FromSeconds(15)) return false;
            _lastAccepted = now;
            return true;
        }
    }
}
