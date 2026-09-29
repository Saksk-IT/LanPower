$ErrorActionPreference = 'Stop'
$service = Get-Service -Name 'LanPowerService' -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne 'Stopped') { Stop-Service -Name 'LanPowerService' -Force }
    & sc.exe delete LanPowerService | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '无法移除 LanPower Service。' }
}
Get-NetFirewallRule -DisplayName 'LanPower LAN Only' -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
# 保留 ProgramData 中的配对配置，便于重装后继续使用已配对的手机。
