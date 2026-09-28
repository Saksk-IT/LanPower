$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
    if (-not $pwsh) { $pwsh = (Get-Command powershell.exe).Source }
    $quotedScript = '"' + $PSCommandPath.Replace('"', '""') + '"'
    $elevated = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $quotedScript) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($elevated.ExitCode -ne 0) { throw "管理员卸载进程失败，退出码：$($elevated.ExitCode)" }
    return
}
$taskName = 'LanPower LAN Control'
$firewallName = 'LanPower LAN Only'
$programDataRoot = [System.IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\')
$actual = [System.IO.Path]::GetFullPath((Join-Path $programDataRoot 'LanPower'))
$targetExe = Join-Path (Join-Path $actual 'bin') 'LanPower.exe'
if (([System.IO.Path]::GetDirectoryName($actual) -ne $programDataRoot) -or
    ([System.IO.Path]::GetFileName($actual) -ne 'LanPower')) {
    throw '安装目录校验失败。'
}
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$running = Get-CimInstance Win32_Process -Filter "Name = 'LanPower.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $targetExe }
foreach ($process in $running) { Stop-Process -Id $process.ProcessId -Force }
Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (Test-Path -LiteralPath $actual) {
    $target = Get-Item -LiteralPath $actual -Force
    if ($target.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw '安装目录是重解析点，已停止删除。'
    }
    Remove-Item -LiteralPath $actual -Recurse -Force
}
Write-Host 'LanPower 已卸载。'
