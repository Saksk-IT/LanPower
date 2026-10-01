using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace LanPower.Service;

// An interactive desktop may read status without receiving the LAN power token.
// This capability is in-memory, loopback-only, and never accepted by /api/power.
public sealed class LocalStatusAccess
{
    public string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    public bool IsAuthorized(IPAddress? address, string? authorization) =>
        address is not null && IPAddress.IsLoopback(address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address) &&
        authorization is { Length: 71 } && authorization.StartsWith("Bearer ", StringComparison.Ordinal) &&
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Token), Encoding.ASCII.GetBytes(authorization[7..]));
}
