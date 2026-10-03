#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$LanAddress)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-network.ps1')
$network = Get-DevLanConfiguration -LanAddress $LanAddress
$parameters = @{
    Name = 'LanPower-Dev-HTTPS-LAN'
    DisplayName = 'LanPower development HTTPS (LAN)'
    Description = 'LAN deployment 1.0.0: HTTPS 8443 from the selected physical subnet only.'
    Enabled = 'True'
    Direction = 'Inbound'
    Action = 'Allow'
    Protocol = 'TCP'
    LocalPort = 8443
    LocalAddress = $network.Address
    RemoteAddress = $network.Subnet
    InterfaceAlias = $network.InterfaceAlias
    Profile = 'Any'
    EdgeTraversalPolicy = 'Block'
}
if (Get-NetFirewallRule -Name $parameters.Name -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule @parameters | Out-Null
} else {
    New-NetFirewallRule @parameters | Out-Null
}
if (-not (Test-DevLanFirewall -Network $network)) { throw 'The scoped LAN firewall rule was not applied.' }
Write-Output 'The development HTTPS firewall rule is ready for the selected LAN.'
