using System.Net;
using System.Text.Json;
using LanPower.Service;
using LanPower.Shared;

namespace LanPower.UnitTests;

[TestClass]
public sealed class NetworkTests
{
    private static readonly string AdapterId = Guid.NewGuid().ToString();

    [TestMethod]
    public async Task AddressChangeUpdatesPairingAndFirewallWithoutChangingCredentials()
    {
        using var fixture = new NetworkFixture();
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        Assert.IsTrue(fixture.Manager.IsAllowed(IPAddress.Parse("192.168.1.3"), IPAddress.Parse("192.168.1.20")));
        fixture.Adapters = [new LanAdapter(AdapterId, "Ethernet", "10.1.2.20", 24, false, true)];
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        Assert.AreEqual("10.1.2.20", fixture.Manager.Config.HostIp);
        Assert.AreEqual("10.1.2.0/24", fixture.Store.Saved!.AllowedNetworks[0]);
        Assert.AreEqual(new string('a', 64), fixture.Store.Saved.Token);
        Assert.AreEqual("preserved", fixture.Store.Saved.AdditionalSettings!["legacy_field"].GetString());
        Assert.IsTrue(fixture.Firewall.Enabled);
        Assert.AreEqual("10.1.2.20", fixture.Firewall.Address);
        Assert.IsFalse(fixture.Manager.IsAllowed(IPAddress.Parse("192.168.1.3"), IPAddress.Parse("10.1.2.20")));
        Assert.IsFalse(fixture.Manager.IsAllowed(IPAddress.Parse("10.1.2.3"), IPAddress.Parse("10.1.2.21")));
        Assert.IsTrue(fixture.Manager.IsAllowed(IPAddress.Parse("10.1.2.3"), IPAddress.Parse("10.1.2.20")));
        Assert.IsTrue(fixture.Manager.IsAllowed(IPAddress.IPv6Loopback, IPAddress.IPv6Loopback));
    }

    [TestMethod]
    public async Task DisconnectDoesNotSwitchToAnotherAdapterAndReconnectRestoresTheSameOne()
    {
        using var fixture = new NetworkFixture();
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        fixture.Adapters = [new LanAdapter(Guid.NewGuid().ToString(), "Other Wi-Fi", "10.1.2.20", 24, true, true)];
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        Assert.IsFalse(fixture.Firewall.Enabled);
        Assert.IsFalse(fixture.Manager.IsAllowed(IPAddress.Parse("192.168.1.3"), IPAddress.Parse("192.168.1.20")));
        Assert.AreEqual("192.168.1.20", fixture.Manager.Config.HostIp);
        fixture.Adapters = [new LanAdapter(AdapterId, "Ethernet", "192.168.1.20", 24, false, true)];
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        Assert.IsTrue(fixture.Firewall.Enabled);
        Assert.IsTrue(fixture.Manager.IsAllowed(IPAddress.Parse("192.168.1.3"), IPAddress.Parse("192.168.1.20")));
    }

    [TestMethod]
    public async Task FixedModeRejectsChangedAddressesUntilExplicitlyUpdated()
    {
        using var fixture = new NetworkFixture();
        await fixture.Manager.ConfigureAsync(AdapterId, false, CancellationToken.None);
        fixture.Adapters = [new LanAdapter(AdapterId, "Ethernet", "192.168.1.25", 24, false, true)];
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        Assert.AreEqual("192.168.1.20", fixture.Manager.Config.HostIp);
        Assert.IsFalse(fixture.Firewall.Enabled);
        await fixture.Manager.ConfigureAsync(AdapterId, false, CancellationToken.None);
        Assert.AreEqual("192.168.1.25", fixture.Manager.Config.HostIp);
        Assert.IsTrue(fixture.Firewall.Enabled);
    }

    [TestMethod]
    [DataRow("8.8.8.8", 24, false)]
    [DataRow("169.254.1.1", 16, false)]
    [DataRow("192.168.1.2", 8, false)]
    [DataRow("172.16.1.2", 8, false)]
    [DataRow("10.1.2.3", 8, true)]
    [DataRow("172.31.1.2", 12, true)]
    [DataRow("192.168.1.2", 16, true)]
    public async Task AutomaticNetworkNeverCreatesAPublicOrOverbroadFirewallScope(string address, int prefix, bool allowed)
    {
        using var fixture = new NetworkFixture();
        fixture.Adapters = [new LanAdapter(AdapterId, "Ethernet", address, prefix, false, true)];
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        Assert.AreEqual(allowed, fixture.Firewall.Enabled);
        Assert.AreEqual(allowed, fixture.Manager.IsAllowed(IPAddress.Parse(address), IPAddress.Parse(address)));
    }

    [TestMethod]
    [DataRow("firewall")]
    [DataRow("config")]
    public async Task PartialUpdateFailsClosedAndCanBeRetried(string failure)
    {
        using var fixture = new NetworkFixture();
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        fixture.Adapters = [new LanAdapter(AdapterId, "Ethernet", "10.1.2.20", 24, false, true)];
        fixture.Firewall.Fail = failure == "firewall";
        fixture.Store.Fail = failure == "config";
        await Assert.ThrowsExactlyAsync<IOException>(() => fixture.Manager.RefreshAsync(CancellationToken.None));
        Assert.IsFalse(fixture.Manager.IsAllowed(IPAddress.Parse("192.168.1.3"), IPAddress.Parse("192.168.1.20")));
        Assert.IsFalse(fixture.Manager.IsAllowed(IPAddress.Parse("10.1.2.3"), IPAddress.Parse("10.1.2.20")));
        fixture.Firewall.Fail = fixture.Store.Fail = false;
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        Assert.IsTrue(fixture.Manager.IsAllowed(IPAddress.Parse("10.1.2.3"), IPAddress.Parse("10.1.2.20")));
    }

    [TestMethod]
    public async Task UserCannotSelectAnUnobservedVirtualAdapter()
    {
        using var fixture = new NetworkFixture();
        await Assert.ThrowsExactlyAsync<ArgumentException>(() => fixture.Manager.ConfigureAsync(Guid.NewGuid().ToString(), true, CancellationToken.None));
        Assert.IsNull(fixture.Store.Saved);
        Assert.IsFalse(fixture.Firewall.Enabled);
        Assert.DoesNotContain(new string('a', 64), JsonSerializer.Serialize(fixture.Manager.Settings()));
    }

    [TestMethod]
    public void AtomicConfigSavePreservesLegacyFieldsAndNewSettings()
    {
        using var fixture = new NetworkFixture();
        var path = Path.Combine(fixture.Folder, "config.json");
        new LanConfigStore(path).Save(fixture.Manager.Config);
        var loaded = LanConfig.Load(path);
        Assert.IsTrue(loaded.AutomaticNetwork);
        Assert.AreEqual(AdapterId, loaded.AdapterId);
        Assert.AreEqual("preserved", loaded.AdditionalSettings!["legacy_field"].GetString());
        Assert.IsFalse(File.Exists(path + ".new"));
    }

    [TestMethod]
    public async Task LegacyAdditionalPublicSubnetsCannotExpandTheFirewall()
    {
        using var fixture = new NetworkFixture();
        fixture.Manager.Config.AutomaticNetwork = false;
        fixture.Manager.Config.AllowedNetworks = ["192.168.1.0/24", "0.0.0.0/0"];
        await fixture.Manager.RefreshAsync(CancellationToken.None);
        Assert.IsFalse(fixture.Firewall.Enabled);
        Assert.IsFalse(fixture.Manager.IsAllowed(IPAddress.Parse("8.8.8.8"), IPAddress.Parse("192.168.1.20")));
        await fixture.Manager.ConfigureAsync(AdapterId, false, CancellationToken.None);
        Assert.IsTrue(fixture.Firewall.Enabled);
        CollectionAssert.AreEqual(new[] { "192.168.1.0/24" }, fixture.Manager.Config.AllowedNetworks);
    }

    private sealed class NetworkFixture : IDisposable
    {
        public string Folder { get; } = Path.Combine(Path.GetTempPath(), "LanPowerNetworkTests", Guid.NewGuid().ToString("N"));
        public LanAdapter[] Adapters = [new LanAdapter(AdapterId, "Ethernet", "192.168.1.20", 24, false, true)];
        public MemoryStore Store { get; } = new();
        public FakeFirewall Firewall { get; } = new();
        public LanNetworkManager Manager { get; }
        public NetworkFixture()
        {
            Directory.CreateDirectory(Folder);
            Manager = new LanNetworkManager(new LanConfig
            {
                Token = new string('a', 64), HostIp = "192.168.1.20", AllowedNetworks = ["192.168.1.0/24"],
                AdapterId = AdapterId, AutomaticNetwork = true,
                AdditionalSettings = new() { ["legacy_field"] = JsonSerializer.SerializeToElement("preserved") }
            }, Store, Firewall, new ServiceLog(Path.Combine(Folder, "service.log")), () => Adapters,
                config => new LocalNetworkSnapshot(config.HostIp, "02:00:00:00:00:01", "已连接", "系统允许唤醒", true));
        }
        public void Dispose() { Manager.Dispose(); Directory.Delete(Folder, true); }
    }

    private sealed class MemoryStore : ILanConfigStore
    {
        public LanConfig? Saved;
        public bool Fail;
        public void Save(LanConfig config)
        {
            if (Fail) throw new IOException("test config failure");
            Saved = config;
        }
    }

    private sealed class FakeFirewall : ILanFirewall
    {
        public bool Enabled;
        public string Address = "";
        public bool Fail;
        public void Apply(LanConfig config, bool enabled)
        {
            if (Fail) throw new IOException("test firewall failure");
            Enabled = enabled;
            Address = config.HostIp;
        }
    }
}
