using System.Text.Json;
using LanPower.Service;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class WakeProfileTests
{
    private const string Origin = "https://power.example.test";
    private const string Device = "00000000-0000-0000-0000-000000000001";
    private static LanConfig Config => new() { HostIp = "192.168.1.20", AllowedNetworks = ["192.168.1.0/24"], Token = new string('a', 64) };
    private static LocalNetworkSnapshot Network => new("192.168.1.20", "02:11:22:33:44:55", "已连接", "需检查", false);
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [TestMethod]
    public void TicketOnlyReadsLocalWakeDataAndExpiresWithRotationOverlap()
    {
        var clock = new Clock();
        var service = new WakeProfileService(clock);
        var config = Config;
        var ticket = service.Issue(Origin, Device, config, Network)!;
        var profile = service.Read("Bearer " + ticket.Token, Origin, Device, config, Network)!;
        Assert.AreEqual("192.168.1.255", profile.Broadcast);
        Assert.DoesNotContain(config.Token, JsonSerializer.Serialize(profile));
        Assert.IsFalse(config.IsAuthorized("Bearer " + ticket.Token));
        Assert.IsNull(service.Read("Bearer " + config.Token, Origin, Device, config, Network));
        clock.Now = clock.Now.AddSeconds(35);
        var rotated = service.Issue(Origin, Device, config, Network)!;
        Assert.AreNotEqual(ticket.Token, rotated.Token);
        Assert.IsNotNull(service.Read("Bearer " + ticket.Token, Origin, Device, config, Network));
        clock.Now = clock.Now.AddSeconds(56);
        Assert.IsNull(service.Read("Bearer " + ticket.Token, Origin, Device, config, Network));
        Assert.IsNotNull(service.Read("Bearer " + rotated.Token, Origin, Device, config, Network));
        service.Clear();
        Assert.IsNull(service.Read("Bearer " + rotated.Token, Origin, Device, config, Network));
    }

    [TestMethod]
    public void ReenrollmentNetworkChangesAndUnavailableAdaptersInvalidateTickets()
    {
        var service = new WakeProfileService();
        var config = Config;
        var ticket = service.Issue(Origin, Device, config, Network)!;
        Assert.IsNull(service.Read("Bearer " + ticket.Token, "https://different.example.test", Device, config, Network));
        Assert.IsNull(service.Read("Bearer " + ticket.Token, Origin, Guid.NewGuid().ToString(), config, Network));
        Assert.IsNull(service.Read("Bearer " + ticket.Token, Origin, Device, config, Network with { Mac = "02:11:22:33:44:56" }));
        Assert.IsNull(service.Issue(Origin, Device, config, Network with { LanState = "未连接" }));
        Assert.IsNull(service.Issue(Origin, Device, config, Network with { Mac = "ff:ff:ff:ff:ff:ff" }));
        config.AllowedNetworks = ["192.168.1.20/32"];
        Assert.IsNull(service.Issue(Origin, Device, config, Network));
    }
}
