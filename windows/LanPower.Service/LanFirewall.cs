using System.Runtime.InteropServices;
using LanPower.Shared;

namespace LanPower.Service;

public interface ILanFirewall
{
    void Apply(LanConfig config, bool enabled);
}

public sealed class LanFirewall(string ruleName = LanFirewall.RuleName) : ILanFirewall
{
    public const string RuleName = "LanPower LAN Only";

    // Windows Firewall COM API. Only this application's named rule is changed;
    // its local address and remote subnet are always explicit IPv4 values.
    public void Apply(LanConfig config, bool enabled)
    {
        dynamic? policy = null;
        dynamic? rules = null;
        dynamic? rule = null;
        try
        {
            policy = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FwPolicy2", throwOnError: true)!);
            rules = policy!.Rules;
            try { rule = rules.Item(ruleName); }
            catch (COMException) { }
            if (rule is null)
            {
                if (!enabled) return;
                rule = Activator.CreateInstance(Type.GetTypeFromProgID("HNetCfg.FWRule", throwOnError: true)!);
                rule!.Name = ruleName;
                rule.Enabled = false;
                rule.Direction = 1;
                rule.Protocol = 6;
                rule.Action = 1;
                rule.Profiles = int.MaxValue;
                rules.Add(rule);
            }
            rule.Enabled = false;
            if (!enabled) return;
            if (!LanNetworkManager.HasPrivateScopes(config) ||
                !LanNetworkManager.IsPrivateNetwork(config.HostIp, Ipv4Subnet.TryParse(config.AllowedNetworks[0], out var subnet) ? subnet.Prefix : 0))
                throw new InvalidDataException("防火墙只能允许局域网地址");
            rule.Direction = 1;
            rule.Protocol = 6;
            rule.LocalPorts = config.Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
            rule.LocalAddresses = config.HostIp;
            rule.RemoteAddresses = string.Join(",", config.AllowedNetworks);
            rule.ApplicationName = Environment.ProcessPath!;
            rule.Action = 1;
            rule.Enabled = true;
        }
        finally
        {
            foreach (object? value in new object?[] { rule, rules, policy })
                if (value is not null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }
    }
}

public sealed class DryRunLanFirewall : ILanFirewall
{
    public void Apply(LanConfig config, bool enabled) { }
}
