param([Parameter(Mandatory = $true)][string]$AppDir)
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '需要管理员权限。' }

$serviceExe = Join-Path $AppDir 'Service\LanPower.Service.exe'
if (-not (Test-Path -LiteralPath $serviceExe)) { throw '服务程序不存在。' }
$nic = Get-NetAdapter -Physical | Where-Object {
    $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Wi-Fi|Wireless|WLAN|802\.11'
} | Select-Object -First 1
if (-not $nic) { throw '未找到已连接的有线网卡。' }
$ip = Get-NetIPAddress -InterfaceIndex $nic.InterfaceIndex -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1
if (-not $ip) { throw '未找到有线网卡的 IPv4 地址。' }

$bytes = [System.Net.IPAddress]::Parse($ip.IPAddress).GetAddressBytes()
for ($index = 0; $index -lt 4; $index++) {
    $bits = [Math]::Max(0, [Math]::Min(8, [int]$ip.PrefixLength - 8 * $index))
    $mask = if ($bits -eq 0) { 0 } else { 256 - [int][Math]::Pow(2, 8 - $bits) }
    $bytes[$index] = [byte]($bytes[$index] -band $mask)
}
$network = ([System.Net.IPAddress]::new($bytes)).ToString() + '/' + $ip.PrefixLength
$dataDir = Join-Path $env:ProgramData 'LanPower'
$configPath = Join-Path $dataDir 'config.json'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
if (((Get-Item -LiteralPath $dataDir).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'LanPower 数据目录不能是链接。'
}
& icacls.exe $dataDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/remove:g' '*S-1-5-32-545' '*S-1-5-11' '*S-1-1-0' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护 LanPower 数据目录。' }
foreach ($protectedName in @('credentials.dat', 'cloud-replay.jsonl')) {
    $protectedPath = Join-Path $dataDir $protectedName
    if (Test-Path -LiteralPath $protectedPath) {
        & icacls.exe $protectedPath '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' '/remove:g' '*S-1-5-32-545' '*S-1-5-11' '*S-1-1-0' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '无法保护 Cloud 凭据和命令记录。' }
    }
}

$token = $null
if (Test-Path -LiteralPath $configPath) {
    try {
        $old = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($old.token -match '^[0-9a-fA-F]{64}$') { $token = $old.token }
    } catch { }
}
if (-not $token) {
    $randomBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
    $token = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })
}
$config = [ordered]@{
    token = $token
    host_ip = $ip.IPAddress
    allowed_networks = @($network)
    port = 48211
}
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
& icacls.exe $configPath '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护配对密钥文件。' }

$legacyTask = Get-ScheduledTask -TaskName 'LanPower LAN Control' -ErrorAction SilentlyContinue
if ($legacyTask) {
    Stop-ScheduledTask -TaskName 'LanPower LAN Control' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

$firewallName = 'LanPower LAN Only'
Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 48211 -LocalAddress $ip.IPAddress -RemoteAddress $network -Profile Any | Out-Null

$serviceName = 'LanPowerService'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $service) {
    $binaryPath = '"' + $serviceExe + '" --config "' + $configPath + '"'
    New-Service -Name $serviceName -DisplayName 'LanPower Service' -BinaryPathName $binaryPath `
        -StartupType Automatic -Description 'LanPower 局域网电源服务' | Out-Null
} else {
    Set-Service -Name $serviceName -StartupType Automatic
}
$serviceAccount = (Get-CimInstance Win32_Service -Filter "Name = 'LanPowerService'").StartName
if ($serviceAccount -notin @('LocalSystem', 'NT AUTHORITY\SYSTEM')) { throw '服务必须以 LocalSystem 运行。' }
try {
    Start-Service -Name $serviceName
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:48211/' -TimeoutSec 2 -UseBasicParsing
            if ($response.StatusCode -eq 200) { $healthy = $true; break }
        } catch { }
    }
    if (-not $healthy) { throw 'LAN 服务未通过启动检查。' }
    if ($legacyTask) { Unregister-ScheduledTask -TaskName 'LanPower LAN Control' -Confirm:$false }
} catch {
    if ($legacyTask) { Start-ScheduledTask -TaskName 'LanPower LAN Control' -ErrorAction SilentlyContinue }
    throw
}
