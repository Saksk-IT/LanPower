using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using LanPower.Shared;

namespace LanPower.Service;

public sealed class PowerExecutor(bool dryRun, ServiceLog log)
{
    public bool DryRun => dryRun;

    public bool Execute(string action)
    {
        if (!LanProtocol.IsPowerAction(action)) throw new ArgumentException("未知电源动作", nameof(action));
        if (dryRun)
        {
            log.Write("演练模式，未执行电源动作：" + action);
            return true;
        }
        try
        {
            if (action == "sleep")
            {
                if (!SetSuspendState(false, false, false)) throw new Win32Exception(Marshal.GetLastWin32Error());
                return true;
            }
            var parameters = action switch
            {
                "hibernate" => "/h",
                "restart" => "/r /t 0",
                "shutdown" => "/s /t 0",
                _ => throw new ArgumentException("未知电源动作", nameof(action))
            };
            var executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "shutdown.exe");
            using var process = Process.Start(new ProcessStartInfo(executable, parameters)
            {
                UseShellExecute = false,
                CreateNoWindow = true
            }) ?? throw new InvalidOperationException("无法启动 Windows 电源命令");
            if (!process.WaitForExit(5000) || process.ExitCode != 0)
                throw new InvalidOperationException("Windows 电源命令执行失败");
            return true;
        }
        catch (Exception error)
        {
            log.Write($"电源动作 {action} 失败：{error.GetType().Name}");
            return false;
        }
    }

    [DllImport("PowrProf.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetSuspendState(
        [MarshalAs(UnmanagedType.Bool)] bool hibernate,
        [MarshalAs(UnmanagedType.Bool)] bool forceCritical,
        [MarshalAs(UnmanagedType.Bool)] bool disableWakeEvent);
}
