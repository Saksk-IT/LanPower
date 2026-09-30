param([Parameter(Mandatory = $true)][string]$AppDir, [string]$ResultPath = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-diagnostics.ps1')
$stage = '检查安装权限和文件'
$installLog = ''
$failureReported = $false
$serviceCreated = $false
trap {
    $originalFailure = $_
    if (-not $failureReported) {
        try { Write-LanPowerInstallFailure -Stage $stage -Failure $originalFailure -ResultPath $ResultPath -LogPath $installLog }
        catch { } # A diagnostic failure must not replace the installation error.
    }
    throw $originalFailure
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '需要管理员权限。' }

$serviceExe = Join-Path $AppDir 'Service\LanPower.Service.exe'
if (-not (Test-Path -LiteralPath $serviceExe)) { throw '服务程序不存在。' }
$serviceName = 'LanPowerService'
$stage = '停止已有服务'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
    $serviceAccount = (Get-CimInstance Win32_Service -Filter "Name = 'LanPowerService'").StartName
    if ($serviceAccount -notin @('LocalSystem', 'NT AUTHORITY\SYSTEM')) { throw '服务必须以 LocalSystem 运行。' }
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $serviceName -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
}
. (Join-Path $PSScriptRoot 'network-selection.ps1')
$stage = '保护运行数据'
$dataDir = Join-Path $env:ProgramData 'LanPower'
$configPath = Join-Path $dataDir 'config.json'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
if (((Get-Item -LiteralPath $dataDir).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'LanPower 数据目录不能是链接。'
}
& icacls.exe $dataDir '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '/remove:g' '*S-1-5-32-545' '*S-1-5-11' '*S-1-1-0' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护 LanPower 数据目录。' }
$installLog = Join-Path $dataDir 'logs\install.log'
foreach ($protectedName in @('credentials.dat', 'cloud-replay.jsonl')) {
    $protectedPath = Join-Path $dataDir $protectedName
    if (Test-Path -LiteralPath $protectedPath) {
        & icacls.exe $protectedPath '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' '/remove:g' '*S-1-5-32-545' '*S-1-5-11' '*S-1-1-0' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '无法保护 Cloud 凭据和命令记录。' }
    }
}

$token = $null
$old = $null
$stage = '读取原配对配置'
if (Test-Path -LiteralPath $configPath) {
    try {
        $old = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($old.token -match '^[0-9a-fA-F]{64}$') { $token = $old.token }
    } catch { throw '现有局域网配置损坏，已保留原文件；请先备份并修复配置。' }
    if (-not $token) { throw '现有局域网配对密钥无效，已保留原文件；请先备份并修复配置。' }
}
if (-not $token) {
    $randomBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
    $token = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })
}
$preferred = if ($old -and $old.adapter_id) { [string]$old.adapter_id } else { '' }
$stage = '选择局域网网卡'
$selected = Get-LanPowerNetwork -PreferredAdapterId $preferred
$address = if ($selected) { $selected.Address } elseif ($old -and $old.host_ip) { [string]$old.host_ip } else { '127.0.0.1' }
$networks = if ($selected) { @($selected.Subnet) } elseif ($old -and $old.allowed_networks) { @($old.allowed_networks) } else { @('127.0.0.0/8') }
$automatic = if ($old -and $null -ne $old.automatic_network) { [bool]$old.automatic_network } else { $true }
$config = [ordered]@{
    token = $token
    host_ip = $address
    allowed_networks = @($networks)
    port = 48211
    adapter_id = if ($selected) { $selected.AdapterId } else { $preferred }
    automatic_network = $automatic
}
if ($old) {
    foreach ($property in $old.PSObject.Properties) {
        if (-not $config.Contains($property.Name)) { $config[$property.Name] = $property.Value }
    }
}
$stage = '保存局域网配置'
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
& icacls.exe $configPath '/inheritance:r' '/grant:r' '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw '无法保护配对密钥文件。' }

$legacyTask = $null
try {
    $stage = '停止旧版后台任务'
    $legacyTask = Get-ScheduledTask -TaskName 'LanPower LAN Control' -ErrorAction SilentlyContinue
    if ($legacyTask) {
        Stop-ScheduledTask -TaskName 'LanPower LAN Control' -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    $firewallName = 'LanPower LAN Only'
    $stage = '设置 Windows 防火墙'
    Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    if ($selected) {
        New-NetFirewallRule -DisplayName $firewallName -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort 48211 -LocalAddress $selected.Address -RemoteAddress $selected.Subnet `
            -Program $serviceExe -Profile Any | Out-Null
    }

    $stage = '注册 Windows 服务'
    if (-not $service) {
        $binaryPath = '"' + $serviceExe + '" --config "' + $configPath + '"'
        New-Service -Name $serviceName -DisplayName 'LanPower Service' -BinaryPathName $binaryPath `
            -StartupType Automatic -Description 'LanPower 局域网电源服务' | Out-Null
        $serviceCreated = $true
    } else {
        if ($service.Status -ne 'Stopped') {
            Stop-Service -Name $serviceName -Force
            $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        }
        $installed = Get-CimInstance Win32_Service -Filter "Name = 'LanPowerService'"
        $binaryPath = '"' + $serviceExe + '" --config "' + $configPath + '"'
        $changed = Invoke-CimMethod -InputObject $installed -MethodName Change -Arguments @{
            PathName = $binaryPath
            StartMode = 'Automatic'
        }
        if ($changed.ReturnValue -ne 0) { throw '无法更新服务安装路径。' }
    }
    $serviceAccount = (Get-CimInstance Win32_Service -Filter "Name = 'LanPowerService'").StartName
    if ($serviceAccount -notin @('LocalSystem', 'NT AUTHORITY\SYSTEM')) { throw '服务必须以 LocalSystem 运行。' }
    $stage = '启动 Windows 服务'
    Start-Service -Name $serviceName
    $stage = '验证本机服务接口'
    $healthy = $false
    $healthTimer = [Diagnostics.Stopwatch]::StartNew()
    while ($healthTimer.Elapsed.TotalSeconds -lt 45) {
        Start-Sleep -Milliseconds 500
        $currentService = Get-Service -Name $serviceName -ErrorAction Stop
        if ($currentService.Status -eq 'Stopped') { throw 'LAN 服务在启动检查期间退出。' }
        if ($currentService.Status -eq 'Running' -and (Test-LanPowerServiceHealth -Port $config.port -Token $token)) {
            $healthy = $true
            break
        }
    }
    if (-not $healthy) { throw 'LAN 服务未通过启动检查。' }
    if ($legacyTask) { Unregister-ScheduledTask -TaskName 'LanPower LAN Control' -Confirm:$false }
} catch {
    # Capture service exit codes before stopping or deleting a failed new service.
    try { Write-LanPowerInstallFailure -Stage $stage -Failure $_ -ResultPath $ResultPath -LogPath $installLog }
    catch { }
    $failureReported = $true
    try { Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue } catch { }
    if ($serviceCreated) { try { & sc.exe delete $serviceName | Out-Null } catch { } }
    if ($legacyTask) {
        try { Start-ScheduledTask -TaskName 'LanPower LAN Control' -ErrorAction SilentlyContinue } catch { }
    }
    throw
}
