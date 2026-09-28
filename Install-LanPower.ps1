$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
    if (-not $pwsh) { $pwsh = (Get-Command powershell.exe).Source }
    $quotedScript = '"' + $PSCommandPath.Replace('"', '""') + '"'
    $elevated = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $quotedScript) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($elevated.ExitCode -ne 0) { throw "管理员安装进程失败，退出码：$($elevated.ExitCode)" }
    Start-Process 'http://127.0.0.1:48211/setup'
    return
}

$packageDir = Join-Path $PSScriptRoot 'LanPower'
$packageExe = Join-Path $packageDir 'LanPower.exe'
if (-not (Test-Path -LiteralPath $packageExe)) { throw "找不到 $packageExe" }

$nic = Get-NetAdapter -Physical | Where-Object {
    $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Wi-Fi|Wireless|WLAN|802\.11'
} | Select-Object -First 1
if (-not $nic) { throw '没有找到已连接的有线网卡。' }
$ip = Get-NetIPAddress -InterfaceIndex $nic.InterfaceIndex -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1
if (-not $ip) { throw '没有找到有线网卡的 IPv4 地址。' }

$bytes = [System.Net.IPAddress]::Parse($ip.IPAddress).GetAddressBytes()
for ($index = 0; $index -lt 4; $index++) {
    $bits = [Math]::Max(0, [Math]::Min(8, [int]$ip.PrefixLength - 8 * $index))
    $mask = if ($bits -eq 0) { 0 } else { 256 - [int][Math]::Pow(2, 8 - $bits) }
    $bytes[$index] = [byte]($bytes[$index] -band $mask)
}
$network = ([System.Net.IPAddress]::new($bytes)).ToString() + '/' + $ip.PrefixLength

$installDir = Join-Path $env:ProgramData 'LanPower'
$targetAppDir = Join-Path $installDir 'bin'
$targetExe = Join-Path $targetAppDir 'LanPower.exe'
$configPath = Join-Path $installDir 'config.json'
$taskName = 'LanPower LAN Control'
$firewallName = 'LanPower LAN Only'
$port = 48211
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$running = Get-CimInstance Win32_Process -Filter "Name = 'LanPower.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $targetExe }
foreach ($process in $running) { Stop-Process -Id $process.ProcessId -Force }
if (Test-Path -LiteralPath $targetAppDir) {
    $resolvedInstall = [System.IO.Path]::GetFullPath($installDir).TrimEnd('\')
    $resolvedTarget = [System.IO.Path]::GetFullPath($targetAppDir)
    if (([System.IO.Path]::GetDirectoryName($resolvedTarget) -ne $resolvedInstall) -or
        ([System.IO.Path]::GetFileName($resolvedTarget) -ne 'bin')) {
        throw '程序目录校验失败。'
    }
    $targetItem = Get-Item -LiteralPath $targetAppDir -Force
    if ($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw '程序目录是重解析点，已停止更新。' }
    Remove-Item -LiteralPath $targetAppDir -Recurse -Force
}
Copy-Item -LiteralPath $packageDir -Destination $targetAppDir -Recurse

$token = $null
if (Test-Path -LiteralPath $configPath) {
    try {
        $oldConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($oldConfig.token -match '^[0-9a-fA-F]{64}$') { $token = $oldConfig.token }
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
    port = $port
}
$json = $config | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))
& icacls.exe $configPath '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护配对密钥文件的访问权限。' }

Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $port -LocalAddress $ip.IPAddress -RemoteAddress $network -Profile Any | Out-Null

$action = New-ScheduledTaskAction -Execute $targetExe -Argument ('--config "' + $configPath + '"')
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $taskPrincipal -Settings $settings -Description 'LAN-only phone power control' | Out-Null
Start-ScheduledTask -TaskName $taskName

$healthy = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 2 -UseBasicParsing
        if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
}
if (-not $healthy) { throw "服务未成功启动，请查看 $installDir\lanpower.log" }

Write-Host "安装完成。电脑端地址：http://$($ip.IPAddress):$port/"
Write-Host "配对页面：http://127.0.0.1:$port/setup"
