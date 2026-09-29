using System.Net;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class SecurityTests
{
    private const string Token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [TestMethod]
    public void ConfigRejectsMalformedCredentialsAndNetworks()
    {
        var config = NewConfig();
        config.Token = "short";
        Assert.ThrowsExactly<InvalidDataException>(config.Validate);
        config.Token = Token;
        config.AllowedNetworks = ["10.0.0.0/33"];
        Assert.ThrowsExactly<InvalidDataException>(config.Validate);
        config.AllowedNetworks = ["192.168.1.0/24"];
        Assert.ThrowsExactly<InvalidDataException>(config.Validate);
    }

    [TestMethod]
    public void LanAuthAcceptsOnlyConfiguredSubnetAndBearerToken()
    {
        var config = NewConfig();
        config.Validate();
        Assert.IsTrue(config.IsAllowed(IPAddress.Parse("127.10.1.1")));
        Assert.IsFalse(config.IsAllowed(IPAddress.Parse("10.0.0.1")));
        Assert.IsTrue(config.IsAuthorized("Bearer " + Token));
        Assert.IsFalse(config.IsAuthorized("Bearer " + Token.ToUpperInvariant()));
        Assert.IsFalse(config.IsAuthorized("Bearer " + new string('b', 64)));
        Assert.IsFalse(config.IsAuthorized("Basic " + Token));
    }

    [TestMethod]
    public void SimultaneousPowerCommandsAcceptOnlyOne()
    {
        var gate = new PowerGate();
        var accepted = 0;
        Parallel.For(0, 32, _ =>
        {
            if (gate.TryAccept()) Interlocked.Increment(ref accepted);
        });
        Assert.AreEqual(1, accepted);
        Assert.IsFalse(LanProtocol.IsPowerAction("wake"));
        Assert.IsFalse(LanProtocol.IsPowerAction("command"));
    }

    private static LanConfig NewConfig() => new()
    {
        Token = Token,
        HostIp = "127.0.0.1",
        AllowedNetworks = ["127.0.0.0/8"]
    };
}
