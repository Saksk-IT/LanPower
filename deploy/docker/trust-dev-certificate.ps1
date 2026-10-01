#Requires -Version 5.1
[CmdletBinding()]
param([switch]$WebOnly)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this script in Windows PowerShell.' }
$certificateFile = Join-Path $PSScriptRoot 'private/dev-root.crt'
if (-not (Test-Path -LiteralPath $certificateFile)) {
    throw 'Start the development environment first to export its public CA certificate.'
}
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificateFile)
$thumbprint = $certificate.Thumbprint
$certutil = Join-Path $env:SystemRoot 'System32/certutil.exe'

if (-not (Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $thumbprint))) {
    & $certutil -user -f -addstore Root $certificateFile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not trust the development CA for the current user.' }
}

if (-not $WebOnly -and -not (Test-Path -LiteralPath ('Cert:\LocalMachine\Root\' + $thumbprint))) {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        & $certutil -f -addstore Root $certificateFile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not trust the development CA for Windows services.' }
    } else {
        # Elevate only the certificate import, not Docker or credential generation.
        Write-Output 'Windows services need computer-level certificate trust. Confirm the Windows administrator prompt.'
        $process = Start-Process -FilePath $certutil -ArgumentList @('-f', '-addstore', 'Root', ('"' + $certificateFile + '"')) `
            -Verb RunAs -WindowStyle Hidden -PassThru
        if (-not $process.WaitForExit(60000)) { throw 'Certificate import is still running. Retry after it finishes.' }
        if ($process.ExitCode -ne 0) { throw 'Computer-level certificate import failed or was declined.' }
    }
    if (-not (Test-Path -LiteralPath ('Cert:\LocalMachine\Root\' + $thumbprint))) {
        throw 'The expected development CA is missing from the computer certificate store.'
    }
}

Write-Output ('Trusted development CA: ' + $thumbprint)
if ($WebOnly) {
    Write-Output 'Web-only mode: Windows service certificate trust was not configured.'
} else {
    Write-Output 'Certificate trust is ready for browsers and Windows services.'
}
