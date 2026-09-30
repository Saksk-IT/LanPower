using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using LanPower.Shared;

namespace LanPower.Service;

public sealed record WakeProfile(
    [property: JsonPropertyName("device_id")] string DeviceId,
    [property: JsonPropertyName("mac")] string Mac,
    [property: JsonPropertyName("broadcast")] string Broadcast,
    [property: JsonPropertyName("pc_ip")] string PcIp,
    [property: JsonPropertyName("port")] int Port);

public sealed record WakeProfileTicket(
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("port")] int Port,
    [property: JsonPropertyName("expires_at")] long ExpiresAt);

// These short-lived credentials can read only WOL information, never the LAN
// control credential or power endpoints. MAC and broadcast stay on the LAN.
public sealed class WakeProfileService(TimeProvider? clock = null)
{
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly object _sync = new();
    private readonly List<WakeProfileTicket> _tickets = [];
    private WakeProfile? _profile;
    private string _origin = "";

    public void Clear()
    {
        lock (_sync) { _profile = null; _origin = ""; _tickets.Clear(); }
    }

    public WakeProfileTicket? Issue(string origin, string deviceId, LanConfig config, LocalNetworkSnapshot network)
    {
        lock (_sync)
        {
            var profile = Build(deviceId, config, network);
            if (profile != _profile || origin != _origin)
            {
                _tickets.Clear();
                _profile = profile;
                _origin = origin;
            }
            if (profile is null) return null;
            var now = _clock.GetUtcNow().ToUnixTimeSeconds();
            _tickets.RemoveAll(ticket => ticket.ExpiresAt <= now);
            if (_tickets.Count == 0 || _tickets[^1].ExpiresAt - now <= 60)
                _tickets.Add(new WakeProfileTicket(Convert.ToHexString(RandomNumberGenerator.GetBytes(32)), profile.Port, now + 90));
            return _tickets[^1];
        }
    }

    public WakeProfile? Read(string? authorization, string origin, string deviceId, LanConfig config, LocalNetworkSnapshot network)
    {
        if (authorization is null || !authorization.StartsWith("Bearer ", StringComparison.Ordinal) || authorization.Length != 71)
            return null;
        lock (_sync)
        {
            if (_origin != origin || _profile is null || _profile != Build(deviceId, config, network)) return null;
            var now = _clock.GetUtcNow().ToUnixTimeSeconds();
            var provided = Encoding.ASCII.GetBytes(authorization[7..]);
            return _tickets.Any(ticket => ticket.ExpiresAt > now &&
                CryptographicOperations.FixedTimeEquals(provided, Encoding.ASCII.GetBytes(ticket.Token))) ? _profile : null;
        }
    }

    private static WakeProfile? Build(string deviceId, LanConfig config, LocalNetworkSnapshot network)
    {
        if (!Guid.TryParse(deviceId, out _) || network.LanState != "已连接" || config.HostIp != network.LanIp ||
            !LanNetworkManager.IsPrivateNetwork(network.LanIp, 32) || config.Port is < 1 or > 65535 ||
            config.AllowedNetworks.Length == 0 || !Ipv4Subnet.TryParse(config.AllowedNetworks[0], out var subnet) ||
            subnet.Prefix is < 8 or > 30 || !subnet.Contains(IPAddress.Parse(network.LanIp))) return null;
        var mac = network.Mac.Replace(":", "").Replace("-", "");
        if (mac.Length != 12) return null;
        try
        {
            var bytes = Convert.FromHexString(mac);
            if ((bytes[0] & 1) != 0 || bytes.All(value => value == 0)) return null;
        }
        catch (FormatException) { return null; }
        var address = subnet.Network | (uint.MaxValue >> subnet.Prefix);
        var broadcast = new IPAddress(new byte[] { (byte)(address >> 24), (byte)(address >> 16), (byte)(address >> 8), (byte)address });
        return new WakeProfile(deviceId, network.Mac, broadcast.ToString(), network.LanIp, config.Port);
    }
}
