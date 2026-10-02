$ErrorActionPreference = 'Stop'
$installedHost = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'CodexHost\LanPower.CodexHost.exe'))
Get-CimInstance Win32_Process -Filter "Name='LanPower.CodexHost.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $installedHost } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$shortcutPath = Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'LanPower Codex Host.lnk'
if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
$service = Get-Service -Name 'LanPowerService' -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne 'Stopped') { Stop-Service -Name 'LanPowerService' -Force }
    & sc.exe delete LanPowerService | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '无法移除 LanPower Service。' }
}
Get-NetFirewallRule -DisplayName 'LanPower LAN Only' -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
# 保留 ProgramData 中的配对配置，便于重装后继续使用已配对的手机。
