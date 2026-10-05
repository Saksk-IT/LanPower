#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([switch]$ValidateOnly, [string]$LanAddress)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
. (Join-Path $PSScriptRoot 'dev-network.ps1')
$credentialFile = Join-Path $env:ProgramData 'LanPower/credentials.dat'
if (-not (Test-Path -LiteralPath $credentialFile)) {
    Write-Output 'No existing Windows Cloud connection to migrate.'
    return
}
$localHosts = @('localhost', '127.0.0.1', '[::1]')
$network = Get-DevLanConfiguration -LanAddress $LanAddress
if ($network) { $localHosts += $network.Address }
$service = Get-Service -Name LanPowerService
$serviceInfo = Get-CimInstance Win32_Service -Filter "Name='LanPowerService'"
$binary = if ($serviceInfo.PathName -match '^"([^"]+)"') { $Matches[1] } else { $serviceInfo.PathName.Split(' ')[0] }
if ([version](Get-Item -LiteralPath $binary).VersionInfo.FileVersion -lt [version]'1.24.0.0') {
    throw 'Update the Windows application to 1.24.0 or newer before migrating its Cloud URL.'
}
$restart = $service.Status -eq 'Running'
$plain = $null
$updatedPlain = $null
$proof = $null
try {
    if (-not $ValidateOnly -and $restart) { Stop-Service -Name LanPowerService }
    $original = [IO.File]::ReadAllBytes($credentialFile)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($original, $null,
        [Security.Cryptography.DataProtectionScope]::LocalMachine)
    $saved = [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
    $origin = [Uri]$saved.CloudUrl
    if ($origin.Host -notin $localHosts -or $origin.Scheme -ne 'https' -or $origin.Port -ne 8443) {
        Write-Output 'The existing connection does not use this computer''s former development HTTPS endpoint.'
        return
    }
    $target = 'http://' + $origin.Host + ':8080'
    $health = Invoke-RestMethod -Uri ($target + '/healthz') -TimeoutSec 10
    if (-not $health.ok -or $health.protocol_version -ne '2') { throw 'The local HTTP Cloud is unavailable.' }
    # Verify the original authorization against the same database before changing any encrypted state.
    $proof = Invoke-RestMethod -Uri ($target + '/api/v2/windows/renew') -Method Post -TimeoutSec 10 `
        -ContentType 'application/json' -Body (@{device_id=$saved.DeviceId; refresh_token=$saved.RefreshToken} | ConvertTo-Json -Compress)
    if ($proof.device_id -ne $saved.DeviceId -or $proof.refresh_token -ne $saved.RefreshToken) {
        throw 'The HTTP endpoint did not preserve the existing Windows authorization.'
    }
    if ($ValidateOnly) {
        Write-Output 'The local HTTP endpoint accepts the original Windows device and authorization.'
        return
    }
    $backupDir = Join-Path $PSScriptRoot 'private/windows-http-backup'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $backupDir -AclObject $acl
    $backup = Join-Path $backupDir ('credentials-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.dat')
    [IO.File]::WriteAllBytes($backup, $original)
    $saved.CloudUrl = $target
    $updatedPlain = [Text.Encoding]::UTF8.GetBytes(($saved | ConvertTo-Json -Compress))
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($updatedPlain, $null,
        [Security.Cryptography.DataProtectionScope]::LocalMachine)
    $temporary = $credentialFile + '.new'
    [IO.File]::WriteAllBytes($temporary, $encrypted)
    [IO.File]::Replace($temporary, $credentialFile, [NullString]::Value)
    Write-Output 'The Windows development Cloud URL now uses HTTP; the device and authorization are preserved.'
} finally {
    if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
    if ($updatedPlain) { [Array]::Clear($updatedPlain, 0, $updatedPlain.Length) }
    $saved = $null
    $proof = $null
    if (-not $ValidateOnly -and $restart) { Start-Service -Name LanPowerService }
}
