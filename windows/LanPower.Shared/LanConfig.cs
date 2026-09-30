using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LanPower.Shared;

public sealed class LanConfig
{
    [JsonPropertyName("token")]
    public string Token { get; set; } = "";

    [JsonPropertyName("host_ip")]
    public string HostIp { get; set; } = "";

    [JsonPropertyName("allowed_networks")]
    public string[] AllowedNetworks { get; set; } = [];

    [JsonPropertyName("port")]
    public int Port { get; set; } = 48211;

    [JsonPropertyName("adapter_id")]
    public string AdapterId { get; set; } = "";

    [JsonPropertyName("automatic_network")]
    public bool AutomaticNetwork { get; set; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalSettings { get; set; }

    public static LanConfig Load(string path)
    {
        var config = JsonSerializer.Deserialize<LanConfig>(File.ReadAllText(path))
            ?? throw new InvalidDataException("配置文件为空");
        config.Validate();
        return config;
    }

    public void Validate()
    {
        if (Token is null || Token.Length != 64 || !IsHex(Token))
            throw new InvalidDataException("配对密钥必须是 64 位十六进制字符串");
        if (Port is < 1 or > 65535)
            throw new InvalidDataException("LAN 端口无效");
        if (!IPAddress.TryParse(HostIp, out var host) || host.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
            throw new InvalidDataException("LAN IPv4 地址无效");
        if (AllowedNetworks is null || AllowedNetworks.Length == 0 || AllowedNetworks.Any(network => !Ipv4Subnet.TryParse(network, out _)))
            throw new InvalidDataException("至少需要一个有效的 IPv4 网段");
        if (!Ipv4Subnet.TryParse(AllowedNetworks[0], out var first) || !first.Contains(host))
            throw new InvalidDataException("LAN 地址必须属于第一个允许的网段");
        if (AdapterId is null || AdapterId.Length != 0 && !Guid.TryParse(AdapterId, out _))
            throw new InvalidDataException("网卡标识无效");
    }

    public bool IsAllowed(IPAddress? address)
    {
        if (address is null) return false;
        if (IPAddress.IsLoopback(address)) return true;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        return AllowedNetworks.Any(value => Ipv4Subnet.TryParse(value, out var subnet) && subnet.Contains(address));
    }

    public bool IsAuthorized(string? header)
    {
        if (header is null || !header.StartsWith("Bearer ", StringComparison.Ordinal)) return false;
        var presented = header[7..];
        if (presented.Length != 64) return false;
        return CryptographicOperations.FixedTimeEquals(
            MemoryMarshal.AsBytes(presented.AsSpan()), MemoryMarshal.AsBytes(Token.AsSpan()));
    }

    private static bool IsHex(string value)
    {
        try { return Convert.FromHexString(value).Length == 32; }
        catch (FormatException) { return false; }
    }
}

public readonly record struct Ipv4Subnet(uint Network, int Prefix)
{
    public static bool TryParse(string? value, out Ipv4Subnet subnet)
    {
        subnet = default;
        if (string.IsNullOrWhiteSpace(value)) return false;
        var parts = value.Split('/');
        if (parts.Length != 2 || !IPAddress.TryParse(parts[0], out var address) ||
            address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork ||
            !int.TryParse(parts[1], out var prefix) || prefix is < 0 or > 32) return false;
        var mask = prefix == 0 ? 0U : uint.MaxValue << (32 - prefix);
        subnet = new Ipv4Subnet(ReadAddress(address) & mask, prefix);
        return true;
    }

    public bool Contains(IPAddress address)
    {
        if (address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
        var mask = Prefix == 0 ? 0U : uint.MaxValue << (32 - Prefix);
        return (ReadAddress(address) & mask) == Network;
    }

    public override string ToString() => $"{new IPAddress(new byte[] { (byte)(Network >> 24), (byte)(Network >> 16), (byte)(Network >> 8), (byte)Network })}/{Prefix}";

    private static uint ReadAddress(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        return ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
    }
}
