using System.Net;
using LanPower.Service;

namespace LanPower.UnitTests;

[TestClass]
public sealed class ConnectionStatusTests
{
    private sealed class Clock : TimeProvider
    {
        public long Seconds { get; set; } = 1000;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeSeconds(Seconds);
        public override long GetTimestamp() => Seconds;
        public override long TimestampFrequency => 1;
    }

    [TestMethod]
    public void ConnectionRequiresSuccessfulPollWithinNinetySeconds()
    {
        var clock = new Clock();
        var status = new CloudConnectionStatus(clock);
        Assert.IsFalse(status.Connected);
        Assert.AreEqual(0L, status.LastSeen);
        status.RecordSuccess();
        Assert.IsFalse(status.Connected, "Heartbeats alone must not mark command polling as connected");
        status.RecordSuccess(poll: true);
        Assert.IsTrue(status.Connected);
        clock.Seconds += 90;
        Assert.IsTrue(status.Connected);
        clock.Seconds++;
        status.RecordSuccess();
        Assert.IsFalse(status.Connected);
        Assert.AreEqual(clock.Seconds, status.LastSeen);
        status.RecordSuccess(poll: true);
        Assert.IsTrue(status.Connected);
        status.Reset();
        Assert.IsFalse(status.Connected);
    }

    [TestMethod]
    public void DesktopStatusCapabilityIsLoopbackOnlyAndCannotBeGuessed()
    {
        var status = new LocalStatusAccess();
        Assert.IsTrue(status.IsAuthorized(IPAddress.Loopback, "Bearer " + status.Token));
        Assert.IsTrue(status.IsAuthorized(IPAddress.IPv6Loopback, "Bearer " + status.Token));
        Assert.IsFalse(status.IsAuthorized(IPAddress.Parse("192.168.1.8"), "Bearer " + status.Token));
        Assert.IsFalse(status.IsAuthorized(IPAddress.Loopback, "Bearer " + new string('x', 64)));
        Assert.IsFalse(status.IsAuthorized(IPAddress.Loopback, null));
    }
}
