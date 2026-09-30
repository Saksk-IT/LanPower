$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'network-selection.ps1')
$wiredId = '00000000-0000-0000-0000-000000000001'
$wifiId = '00000000-0000-0000-0000-000000000002'
$script:Adapters = @(
    [pscustomobject]@{ InterfaceGuid = $wifiId; InterfaceDescription = 'Wireless Adapter'; InterfaceIndex = 2; Status = 'Up' },
    [pscustomobject]@{ InterfaceGuid = $wiredId; InterfaceDescription = 'Ethernet Adapter'; InterfaceIndex = 1; Status = 'Up' }
)
$script:Addresses = @{
    1 = @([pscustomobject]@{ IPAddress = '192.168.1.20'; PrefixLength = 24 })
    2 = @([pscustomobject]@{ IPAddress = '192.168.2.20'; PrefixLength = 24 })
}
function Get-NetAdapter {
    [CmdletBinding()]
    param([switch]$Physical)
    if (-not $Physical) { throw 'Physical adapter filter required' }
    return $script:Adapters
}
function Get-NetIPAddress {
    [CmdletBinding()]
    param([int]$InterfaceIndex, [string]$AddressFamily)
    if ($AddressFamily -ne 'IPv4') { throw 'IPv4 filter required' }
    return $script:Addresses[$InterfaceIndex]
}
function Assert-Selection($condition, [string]$message) {
    if (-not $condition) { throw $message }
    Write-Output "PASS: $message"
}
$result = Get-LanPowerNetwork
Assert-Selection ($result.AdapterId -eq $wiredId -and $result.Subnet -eq '192.168.1.0/24') 'Wired preferred when both connected'
$result = Get-LanPowerNetwork -PreferredAdapterId $wifiId
Assert-Selection ($result.AdapterId -eq $wifiId) 'Existing Wi-Fi selection preserved'
$script:Adapters[1].Status = 'Down'
$result = Get-LanPowerNetwork
Assert-Selection ($result.AdapterId -eq $wifiId) 'Wi-Fi-only installation supported'
$script:Addresses[2] = @([pscustomobject]@{ IPAddress = '169.254.1.20'; PrefixLength = 16 })
Assert-Selection ($null -eq (Get-LanPowerNetwork)) 'Offline and link-local addresses require no inbound rule'
$script:Addresses[2] = @([pscustomobject]@{ IPAddress = '192.168.1.20'; PrefixLength = 8 })
Assert-Selection ($null -eq (Get-LanPowerNetwork)) 'Overbroad subnet rejected'
$script:Addresses[2] = @([pscustomobject]@{ IPAddress = '8.8.8.8'; PrefixLength = 24 })
Assert-Selection ($null -eq (Get-LanPowerNetwork)) 'Public adapter address rejected'
