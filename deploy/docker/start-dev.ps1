#Requires -Version 5.1
[CmdletBinding()]
param([switch]$Build, [switch]$WebOnly, [switch]$LocalOnly, [string]$LanAddress)

$ErrorActionPreference = 'Stop'
$composeArgs = @('compose', '-p', 'lanpower-dev', '-f', (Join-Path $PSScriptRoot 'compose.dev.yml'))
$image = 'codexdock-cloud:1.21.1-dev.1'
$privateDir = Join-Path $PSScriptRoot 'private'
$envFile = Join-Path $PSScriptRoot '.env.dev'
$loginFile = Join-Path $privateDir 'dev-login.txt'
$certificateFile = Join-Path $privateDir 'dev-root.crt'
$utf8 = [Text.UTF8Encoding]::new($false)

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE)." }
}

function Test-Docker {
    # Windows PowerShell 5.1 must allow expected native stderr before checking the exit code.
    $ErrorActionPreference = 'Continue'
    & docker @args 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

if ($env:OS -ne 'Windows_NT') { throw 'Run this script in Windows PowerShell.' }
if ($LocalOnly -and $LanAddress) { throw 'Use either -LocalOnly or -LanAddress.' }
. (Join-Path $PSScriptRoot 'dev-network.ps1')
$network = if (-not $LocalOnly) { Get-DevLanConfiguration -LanAddress $LanAddress }
New-Item -ItemType Directory -Force -Path $privateDir | Out-Null
if ($network) {
    $networkEnvFile = Join-Path $privateDir 'dev-network.env'
    [IO.File]::WriteAllText($networkEnvFile, "LANPOWER_DEV_LAN_IP=$($network.Address)`n", $utf8)
    $composeArgs += @('--env-file', $networkEnvFile, '-f', (Join-Path $PSScriptRoot 'compose.dev.lan.yml'))
}
Get-Command docker -ErrorAction Stop | Out-Null
if (-not (Test-Docker info --format '{{.OSType}}')) {
    Invoke-Docker desktop start
}
Invoke-Docker @composeArgs config --quiet

# An existing volume must keep its original login configuration.
$hasDataVolume = Test-Docker volume inspect lanpower-dev_cloud-data
if ($hasDataVolume -and -not (Test-Path -LiteralPath $envFile)) {
    throw 'The dev data volume exists, but .env.dev is missing. Restore its private configuration before starting.'
}

New-Item -ItemType Directory -Force -Path $privateDir | Out-Null
if ($Build -or -not (Test-Docker image inspect $image)) { Invoke-Docker @composeArgs build cloud }

if ($hasDataVolume) {
    $backupName = 'dev-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.db'
    $backupDir = Join-Path $PSScriptRoot 'backups'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    # Use only SQLite in a separate helper, so backup precedes application migrations.
    $backupCode = 'import pathlib, sqlite3, sys; dest = pathlib.Path("/backups") / sys.argv[1]; src = sqlite3.connect("file:/var/lib/lanpower-cloud/platform.db?mode=ro", uri=True); backup = sqlite3.connect(dest); src.backup(backup); assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"; backup.close(); src.close()'
    $backupCode | & docker run --rm -i --network none --read-only --entrypoint python `
        --volume lanpower-dev_cloud-data:/var/lib/lanpower-cloud `
        --mount "type=bind,source=$backupDir,target=/backups" $image - $backupName
    if ($LASTEXITCODE -ne 0) { throw 'The existing dev database backup failed.' }
    Write-Output 'The existing dev database was backed up and checked.'
}

if (-not (Test-Path -LiteralPath $envFile)) {
    $passwordCode = 'import json, secrets; from cloud_app.password import hash_password; password = secrets.token_urlsafe(24); print(json.dumps({"password": password, "hash": hash_password(password)}))'
    $credentialsJson = $passwordCode | & docker run --rm -i --network none --read-only --entrypoint python $image -
    if ($LASTEXITCODE -ne 0) { throw 'Could not generate the development login.' }
    $credentials = $credentialsJson | ConvertFrom-Json
    [IO.File]::WriteAllText($envFile, "LANPOWER_ADMIN_PASSWORD_HASH='$($credentials.hash)'`n", $utf8)
    [IO.File]::WriteAllText($loginFile, "Local development only`r`nURL: https://localhost:8443`r`nUsername: admin`r`nPassword: $($credentials.password)`r`n", $utf8)
    # Restrict generated credentials to this Windows user and SYSTEM.
    foreach ($path in @($envFile, $loginFile)) {
        $acl = [Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User,
                           [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
        }
        Set-Acl -LiteralPath $path -AclObject $acl
    }
    $credentials = $null
    $credentialsJson = $null
}

Invoke-Docker @composeArgs up -d --no-build --wait --wait-timeout 120
Invoke-Docker @composeArgs cp caddy:/data/caddy/pki/authorities/local/root.crt $certificateFile
& (Join-Path $PSScriptRoot 'trust-dev-certificate.ps1') -WebOnly:$WebOnly
if ($network -and -not (Test-DevLanFirewall -Network $network)) {
    $firewallScript = Join-Path $PSScriptRoot 'configure-dev-firewall.ps1'
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        & $firewallScript -LanAddress $network.Address
    } else {
        Write-Output 'LAN HTTPS needs a scoped firewall rule. Confirm the Windows administrator prompt.'
        $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $process = Start-Process -FilePath $powershell -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $firewallScript + '"'), '-LanAddress', $network.Address)
        if (-not $process.WaitForExit(60000)) { throw 'Firewall configuration is still running. Retry after it finishes.' }
        if ($process.ExitCode -ne 0) { throw 'LAN firewall configuration failed or was declined.' }
    }
    if (-not (Test-DevLanFirewall -Network $network)) { throw 'The scoped LAN firewall rule is missing.' }
}
$health = Invoke-RestMethod -Uri 'https://localhost:8443/healthz' -TimeoutSec 15
if (-not $health.ok) { throw 'The Cloud health check failed.' }
Write-Output ('CodexDock Cloud ' + $health.version + ' is ready: https://localhost:8443')
if ($network) {
    $lanUrl = 'https://' + $network.Address + ':8443'
    $lanHealth = Invoke-RestMethod -Uri ($lanUrl + '/healthz') -TimeoutSec 15
    if (-not $lanHealth.ok) { throw 'The LAN HTTPS health check failed.' }
    Write-Output ('LAN HTTPS is ready: ' + $lanUrl + ' (network configuration 1.0.0)')
    Write-Output ('Other LAN devices must trust the public development CA: ' + $certificateFile)
} else {
    Write-Output 'Local-only HTTPS: no physical private IPv4 network selected.'
}
Write-Output ('Local login details: ' + $loginFile)
