#Requires -Version 5.1
# LAN deployment configuration version: 1.1.0.

function Get-DevLanConfiguration {
    param([string]$LanAddress)

    $adapters = @(Get-NetAdapter -Physical | Where-Object Status -EQ 'Up')
    $candidates = @(foreach ($adapter in $adapters) {
        $configuration = Get-NetIPConfiguration -InterfaceIndex $adapter.InterfaceIndex
        if (-not $configuration.IPv4DefaultGateway) { continue }
        foreach ($address in @(Get-NetIPAddress -InterfaceIndex $adapter.InterfaceIndex -AddressFamily IPv4)) {
            if ($address.AddressState -ne 'Preferred') { continue }
            $bytes = [Net.IPAddress]::Parse($address.IPAddress).GetAddressBytes()
            $private = $bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
                ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
            if (-not $private -or ($LanAddress -and $address.IPAddress -ne $LanAddress)) { continue }
            $networkBytes = [byte[]]::new(4)
            for ($index = 0; $index -lt 4; $index++) {
                $bits = [Math]::Max(0, [Math]::Min(8, $address.PrefixLength - $index * 8))
                $mask = if ($bits -eq 0) { 0 } else { 256 - [Math]::Pow(2, 8 - $bits) }
                $networkBytes[$index] = $bytes[$index] -band [int]$mask
            }
            [pscustomobject]@{
                Address = $address.IPAddress
                InterfaceAlias = $adapter.Name
                Subnet = ([Net.IPAddress]::new($networkBytes)).ToString() + '/' + $address.PrefixLength
            }
        }
    })
    if ($candidates.Count -gt 1) { throw 'Multiple LAN addresses found. Run start-dev.ps1 -LanAddress <private IPv4>.' }
    if ($LanAddress -and $candidates.Count -eq 0) { throw 'The LAN address must belong to an active physical private IPv4 network with a gateway.' }
    if ($candidates.Count -eq 1) { return $candidates[0] }
}

function Test-DevLanFirewall {
    param([Parameter(Mandatory)]$Network)

    $rule = Get-NetFirewallRule -Name 'LanPower-Dev-HTTP-LAN' -ErrorAction SilentlyContinue
    if (-not $rule) { return $false }
    $port = $rule | Get-NetFirewallPortFilter
    $address = $rule | Get-NetFirewallAddressFilter
    $interface = $rule | Get-NetFirewallInterfaceFilter
    $maskBytes = [byte[]]::new(4)
    $prefixLength = [int]($Network.Subnet.Split('/')[1])
    for ($index = 0; $index -lt 4; $index++) {
        $bits = [Math]::Max(0, [Math]::Min(8, $prefixLength - $index * 8))
        $maskBytes[$index] = if ($bits -eq 0) { 0 } else { 256 - [Math]::Pow(2, 8 - $bits) }
    }
    $windowsSubnet = $Network.Subnet.Split('/')[0] + '/' + ([Net.IPAddress]::new($maskBytes)).ToString()
    return $rule.Enabled -eq 'True' -and $rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow' -and
        $rule.Profile -eq 'Any' -and $rule.EdgeTraversalPolicy -eq 'Block' -and
        $port.Protocol -eq 'TCP' -and @($port.LocalPort).Count -eq 1 -and $port.LocalPort -eq '8080' -and
        @($address.LocalAddress).Count -eq 1 -and $address.LocalAddress -eq $Network.Address -and
        @($address.RemoteAddress).Count -eq 1 -and $address.RemoteAddress -in @($Network.Subnet, $windowsSubnet) -and
        @($interface.InterfaceAlias).Count -eq 1 -and $interface.InterfaceAlias -eq $Network.InterfaceAlias
}
