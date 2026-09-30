using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using LanPower.Shared;

namespace LanPower.Service;

public static class LanNetworkDiscovery
{
    // Fixed local discovery command. Remote commands cannot provide a script,
    // executable, adapter name or other arguments to this process.
    private const string PhysicalAdapters = "Get-NetAdapter -Physical -ErrorAction Stop | Select-Object InterfaceGuid,Name | ConvertTo-Json -Compress";

    public static LanAdapter[] Read()
    {
        var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        using var process = Process.Start(new ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            ArgumentList = { "-NoProfile", "-NonInteractive", "-EncodedCommand",
                Convert.ToBase64String(Encoding.Unicode.GetBytes("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" + PhysicalAdapters)) }
        }) ?? throw new IOException("无法检测物理网卡");
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(5000))
        {
            process.Kill(entireProcessTree: true);
            throw new IOException("检测物理网卡超时");
        }
        _ = errors.GetAwaiter().GetResult();
        if (process.ExitCode != 0) throw new IOException("无法检测物理网卡");
        var text = output.GetAwaiter().GetResult();
        if (string.IsNullOrWhiteSpace(text)) return [];
        using var document = JsonDocument.Parse(text);
        var rows = document.RootElement.ValueKind == JsonValueKind.Array ? document.RootElement.EnumerateArray().ToArray() : [document.RootElement];
        var physical = rows.ToDictionary(row => Guid.Parse(row.GetProperty("InterfaceGuid").GetString()!).ToString("D"),
            row => row.GetProperty("Name").GetString() ?? "网卡", StringComparer.OrdinalIgnoreCase);
        return NetworkInterface.GetAllNetworkInterfaces().Where(adapter =>
                Guid.TryParse(adapter.Id, out var id) && physical.ContainsKey(id.ToString("D")))
            .Select(adapter =>
            {
                var address = adapter.GetIPProperties().UnicastAddresses.FirstOrDefault(value =>
                    value.Address.AddressFamily == AddressFamily.InterNetwork &&
                    LanNetworkManager.IsPrivateNetwork(value.Address.ToString(), value.PrefixLength));
                var id = Guid.Parse(adapter.Id).ToString("D");
                return new LanAdapter(id, physical[id], address?.Address.ToString() ?? "", address?.PrefixLength ?? 0,
                    adapter.NetworkInterfaceType == NetworkInterfaceType.Wireless80211,
                    adapter.OperationalStatus == OperationalStatus.Up && address is not null);
            }).OrderBy(adapter => !adapter.Connected).ThenBy(adapter => adapter.Wireless).ThenBy(adapter => adapter.Name).ToArray();
    }
}
