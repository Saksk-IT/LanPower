using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using LanPower.Shared;

namespace LanPower.Service;

public sealed record LocalNetworkSnapshot(string LanIp, string Mac, string LanState, string WolState, bool WolCapable);

public static class LocalNetworkStatus
{
    public static LocalNetworkSnapshot Read(LanConfig config)
    {
        var adapter = NetworkInterface.GetAllNetworkInterfaces().FirstOrDefault(nic =>
            nic.OperationalStatus == OperationalStatus.Up &&
            nic.GetIPProperties().UnicastAddresses.Any(address => address.Address.Equals(IPAddress.Parse(config.HostIp))));
        var mac = adapter?.GetPhysicalAddress().ToString() ?? "";
        if (mac.Length == 12) mac = string.Join(":", Enumerable.Range(0, 6).Select(i => mac.Substring(i * 2, 2)));
        var wake = DetectWake(adapter);
        return new LocalNetworkSnapshot(config.HostIp, mac, adapter is null ? "地址已变化或网络未连接" : "已连接",
            wake, wake == "系统允许唤醒");
    }

    private static string DetectWake(NetworkInterface? adapter)
    {
        if (adapter is null) return "未检测到网卡";
        try
        {
            using var process = Process.Start(new ProcessStartInfo(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "powercfg.exe"),
                "/devicequery wake_armed")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true
            });
            if (process is null) return "无法确认";
            var output = process.StandardOutput.ReadToEndAsync();
            if (!process.WaitForExit(2000))
            {
                process.Kill();
                return "无法确认";
            }
            if (process.ExitCode != 0) return "无法确认";
            var text = output.GetAwaiter().GetResult();
            return text.Contains(adapter.Name, StringComparison.OrdinalIgnoreCase) ||
                   text.Contains(adapter.Description, StringComparison.OrdinalIgnoreCase) ? "系统允许唤醒" : "需检查";
        }
        catch { return "无法确认"; }
    }
}
