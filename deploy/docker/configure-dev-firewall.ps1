#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([Parameter(Mandatory)][string]$LanAddress)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dev-network.ps1')
$network = Get-DevLanConfiguration -LanAddress $LanAddress
$parameters = @{
    Name = 'LanPower-Dev-HTTP-LAN'
    DisplayName = 'LanPower development HTTP (LAN)'
    Description = 'LAN deployment 1.1.0: HTTP 8080 from the selected physical subnet only.'
    Enabled = 'True'
    Direction = 'Inbound'
    Action = 'Allow'
    Protocol = 'TCP'
    LocalPort = 8080
    LocalAddress = $network.Address
    RemoteAddress = $network.Subnet
    InterfaceAlias = $network.InterfaceAlias
    Profile = 'Any'
    EdgeTraversalPolicy = 'Block'
}
if (Get-NetFirewallRule -Name $parameters.Name -ErrorAction SilentlyContinue) {
    $updatedParameters = $parameters.Clone()
    $updatedParameters.Remove('DisplayName')
    $updatedParameters.NewDisplayName = $parameters.DisplayName
    Set-NetFirewallRule @updatedParameters | Out-Null
} else {
    New-NetFirewallRule @parameters | Out-Null
}
if (-not (Test-DevLanFirewall -Network $network)) { throw 'The scoped LAN firewall rule was not applied.' }
Get-NetFirewallRule -Name 'LanPower-Dev-HTTPS-LAN' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Output 'The development HTTP firewall rule is ready for the selected LAN.'
