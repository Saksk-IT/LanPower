function Get-LanPowerNetwork {
    param([string]$PreferredAdapterId = '')
    $choices = @(
        foreach ($adapter in @(Get-NetAdapter -Physical -ErrorAction Stop)) {
            if ($adapter.Status -ne 'Up') { continue }
            $id = ([guid]$adapter.InterfaceGuid).ToString('D')
            if ($PreferredAdapterId -and $id -ne $PreferredAdapterId.Trim('{}')) { continue }
            foreach ($address in @(Get-NetIPAddress -InterfaceIndex $adapter.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
                $ip = $null
                if (-not [Net.IPAddress]::TryParse($address.IPAddress, [ref]$ip)) { continue }
                $bytes = $ip.GetAddressBytes()
                if ($bytes.Length -ne 4) { continue }
                $minimum = if ($bytes[0] -eq 10) { 8 }
                    elseif ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) { 12 }
                    elseif ($bytes[0] -eq 192 -and $bytes[1] -eq 168) { 16 }
                    else { 33 }
                if ($address.PrefixLength -lt $minimum -or $address.PrefixLength -gt 32) { continue }
                for ($index = 0; $index -lt 4; $index++) {
                    $bits = [Math]::Max(0, [Math]::Min(8, [int]$address.PrefixLength - 8 * $index))
                    $mask = if ($bits -eq 0) { 0 } else { 256 - [int][Math]::Pow(2, 8 - $bits) }
                    $bytes[$index] = [byte]($bytes[$index] -band $mask)
                }
                [pscustomobject]@{
                    AdapterId = $id
                    Address = $address.IPAddress
                    Subnet = ([Net.IPAddress]::new($bytes)).ToString() + '/' + $address.PrefixLength
                    Wireless = $adapter.InterfaceDescription -match 'Wi-Fi|Wireless|WLAN|802\.11'
                    InterfaceIndex = $adapter.InterfaceIndex
                }
                break
            }
        }
    )
    return $choices | Sort-Object Wireless, InterfaceIndex | Select-Object -First 1
}
