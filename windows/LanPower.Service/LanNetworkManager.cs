using System.Net;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Service;

public interface ILanConfigStore
{
    void Save(LanConfig config);
}

public sealed class LanConfigStore(string path) : ILanConfigStore
{
    public void Save(LanConfig config)
    {
        config.Validate();
        using (var file = new FileStream(path + ".new", FileMode.Create, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(file, config, new JsonSerializerOptions { WriteIndented = true });
            file.Flush(true);
        }
        File.Move(path + ".new", path, true);
    }
}

public sealed class LanNetworkManager : BackgroundService
{
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly Func<LanAdapter[]> _discover;
    private readonly Func<LanConfig, LocalNetworkSnapshot> _observe;
    private readonly ILanConfigStore _store;
    private readonly ILanFirewall _firewall;
    private readonly ServiceLog _log;
    private LanConfig _config;
    private LanAdapter[] _adapters = [];
    private LocalNetworkSnapshot _status;
    private bool _allowLan;
    private string _firewallScope = "";

    public LanNetworkManager(LanConfig config, ILanConfigStore store, ILanFirewall firewall, ServiceLog log,
        Func<LanAdapter[]>? discover = null, Func<LanConfig, LocalNetworkSnapshot>? observe = null)
    {
        _config = config;
        _store = store;
        _firewall = firewall;
        _log = log;
        _discover = discover ?? LanNetworkDiscovery.Read;
        _observe = observe ?? LocalNetworkStatus.Read;
        _status = new LocalNetworkSnapshot(config.HostIp, "", "检测中", "检测中", false);
        // Until physical discovery succeeds, only loopback is accepted.
        _allowLan = false;
    }

    public LanConfig Config => Volatile.Read(ref _config);
    public LocalNetworkSnapshot ReadStatus() => Volatile.Read(ref _status);

    public NetworkSettings Settings()
    {
        var config = Config;
        return new NetworkSettings(config.AdapterId, config.AutomaticNetwork, config.HostIp,
            config.AllowedNetworks[0], config.Port, Volatile.Read(ref _adapters));
    }

    public bool IsAllowed(IPAddress? remote, IPAddress? local)
    {
        if (remote is null) return false;
        if (remote.IsIPv4MappedToIPv6) remote = remote.MapToIPv4();
        if (IPAddress.IsLoopback(remote)) return true;
        if (local?.IsIPv4MappedToIPv6 == true) local = local.MapToIPv4();
        var config = Config;
        return Volatile.Read(ref _allowLan) && local?.Equals(IPAddress.Parse(config.HostIp)) == true && config.IsAllowed(remote);
    }

    public static bool IsPrivateNetwork(string address, int prefix)
    {
        if (!IPAddress.TryParse(address, out var ip) || ip.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
        var bytes = ip.GetAddressBytes();
        var minimum = bytes[0] == 10 ? 8 : bytes[0] == 172 && bytes[1] is >= 16 and <= 31 ? 12 :
            bytes[0] == 192 && bytes[1] == 168 ? 16 : 33;
        return prefix >= minimum && prefix <= 32;
    }

    public static bool HasPrivateScopes(LanConfig config) => config.AllowedNetworks.All(value =>
        Ipv4Subnet.TryParse(value, out var subnet) && IsPrivateNetwork(value.Split('/')[0], subnet.Prefix));

    public async Task ConfigureAsync(string adapterId, bool automatic, CancellationToken token)
    {
        if (!Guid.TryParse(adapterId, out var id)) throw new ArgumentException("请选择物理网卡");
        await _lock.WaitAsync(token);
        try
        {
            var adapters = _discover();
            var selected = adapters.SingleOrDefault(adapter => Guid.TryParse(adapter.Id, out var candidate) && candidate == id)
                ?? throw new ArgumentException("未找到所选物理网卡");
            if (!automatic && !selected.Connected) throw new ArgumentException("固定地址模式需要已连接的局域网网卡");
            var config = Clone(Config);
            config.AdapterId = id.ToString("D");
            config.AutomaticNetwork = automatic;
            await UpdateAsync(config, adapters, true, token);
        }
        finally { _lock.Release(); }
    }

    public async Task RefreshAsync(CancellationToken token)
    {
        await _lock.WaitAsync(token);
        try { await UpdateAsync(Clone(Config), _discover(), false, token); }
        finally { _lock.Release(); }
    }

    private Task UpdateAsync(LanConfig config, LanAdapter[] adapters, bool explicitChange, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        Volatile.Write(ref _adapters, adapters);
        var selected = adapters.FirstOrDefault(adapter => string.Equals(adapter.Id, config.AdapterId, StringComparison.OrdinalIgnoreCase));
        if (string.IsNullOrEmpty(config.AdapterId))
        {
            selected = adapters.FirstOrDefault(adapter => adapter.Connected && adapter.Address == config.HostIp);
            if (config.AutomaticNetwork) selected ??= adapters.FirstOrDefault(adapter => adapter.Connected);
            if (selected is not null) config.AdapterId = selected.Id;
        }
        var connected = selected?.Connected == true && IsPrivateNetwork(selected.Address, selected.PrefixLength);
        if (connected && (config.AutomaticNetwork || explicitChange))
        {
            config.HostIp = selected!.Address;
            Ipv4Subnet.TryParse($"{selected.Address}/{selected.PrefixLength}", out var subnet);
            config.AllowedNetworks = [subnet.ToString()];
        }
        connected &= selected?.Address == config.HostIp;
        connected &= HasPrivateScopes(config);
        var previous = Config;
        var changed = config.HostIp != previous.HostIp || config.AdapterId != previous.AdapterId ||
                      config.AutomaticNetwork != previous.AutomaticNetwork || !config.AllowedNetworks.SequenceEqual(previous.AllowedNetworks);
        var scope = connected ? $"{config.HostIp}|{string.Join(',', config.AllowedNetworks)}|{config.Port}" : "disabled";
        try
        {
            if (_firewallScope != scope || changed)
            {
                Volatile.Write(ref _allowLan, false);
                _firewall.Apply(config, connected);
            }
            if (changed) _store.Save(config);
            Volatile.Write(ref _config, config);
            _firewallScope = scope;
            Volatile.Write(ref _allowLan, connected);
            var status = connected ? _observe(config) : new LocalNetworkSnapshot(config.HostIp, "",
                selected?.Connected == true ? "地址已变化，请更新网络设置" : "局域网未连接", "未检测到可用局域网网卡", false);
            if (connected) status = status with { LanState = "已连接" };
            Volatile.Write(ref _status, status);
            if (changed) _log.Write("局域网配置已更新，请用手机重新扫码确认地址");
        }
        catch
        {
            _firewallScope = "";
            Volatile.Write(ref _allowLan, false);
            Volatile.Write(ref _status, new LocalNetworkSnapshot(previous.HostIp, "", "网络设置未完成，请重试", "无法确认", false));
            throw;
        }
        return Task.CompletedTask;
    }

    private static LanConfig Clone(LanConfig config) => new()
    {
        Token = config.Token, HostIp = config.HostIp, AllowedNetworks = [.. config.AllowedNetworks], Port = config.Port,
        AdapterId = config.AdapterId, AutomaticNetwork = config.AutomaticNetwork, AdditionalSettings = config.AdditionalSettings
    };

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await RefreshAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                // Unknown physical adapters must not expand LAN access.
                Volatile.Write(ref _allowLan, false);
                Volatile.Write(ref _status, new LocalNetworkSnapshot(Config.HostIp, "", "无法检测网络，请检查服务", "无法确认", false));
                _log.Write("网络检测失败：" + error.GetType().Name);
            }
            try { await Task.Delay(TimeSpan.FromSeconds(25), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }
}
