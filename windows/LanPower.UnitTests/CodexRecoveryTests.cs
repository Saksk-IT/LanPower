using LanPower.CodexHost;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class CodexRecoveryTests
{
    private sealed class ManualClock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [TestMethod]
    public async Task MissingDesktopRetriesWithBackoffAndStopsWhenAuthorizationIsRevoked()
    {
        var clock = new ManualClock();
        var config = new CodexHostSettings(true, [], SharedControl: true);
        var attempts = 0;
        await using var remote = new RemoteRuntime(() => config, _ =>
        {
            attempts++;
            return Task.FromException<RuntimeClient>(new IOException("shared_runtime_unavailable"));
        }, clock: clock);
        foreach (var seconds in new[] { 2, 4, 8, 16, 30, 30 })
        {
            await Assert.ThrowsAsync<IOException>(() => remote.ReconnectAsync(CancellationToken.None));
            Assert.IsFalse(await remote.ReconnectAsync(CancellationToken.None));
            clock.Now = clock.Now.AddSeconds(seconds - 1);
            Assert.IsFalse(await remote.ReconnectAsync(CancellationToken.None));
            clock.Now = clock.Now.AddSeconds(1);
        }
        Assert.AreEqual(6, attempts);
        config = config with { Enabled = false };
        Assert.IsFalse(await remote.ReconnectAsync(CancellationToken.None));
        Assert.AreEqual(6, attempts, "A revoked configuration must not reconnect.");
        config = config with { Enabled = true, SharedControl = false };
        Assert.IsFalse(await remote.ReconnectAsync(CancellationToken.None), "Independent task workers must not be restarted by native recovery.");
    }
}
