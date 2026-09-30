$ErrorActionPreference = 'Stop'
$installerRoot = Split-Path -Parent $PSScriptRoot
# Read repository UTF-8 explicitly; release packages add a BOM for PowerShell 5.1.
. ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $installerRoot 'install-diagnostics.ps1'), [Text.Encoding]::UTF8)))
function Assert-Install($condition, [string]$message) {
    if (-not $condition) { throw $message }
    Write-Output "PASS: $message"
}

# A loopback HTTP stub on an OS-assigned port, with no service or firewall changes.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$state = [hashtable]::Synchronized(@{
    Status = 200; Body = '{"ok":true,"state":"online"}'; Redirect = $false
    Token = ('a' * 64); Requests = 0; LastPath = ''; Stop = $false
})
$server = [PowerShell]::Create()
[void]$server.AddScript({
    param($listener, $state)
    while (-not $state.Stop) {
        try { $client = $listener.AcceptTcpClient() } catch { break }
        try {
            $stream = $client.GetStream()
            $stream.ReadTimeout = 3000
            $reader = [IO.StreamReader]::new($stream)
            $requestLine = $reader.ReadLine()
            $state.LastPath = ($requestLine -split ' ')[1]
            $authorized = $false
            while ($line = $reader.ReadLine()) {
                if ($line -ceq ('Authorization: Bearer ' + $state.Token)) { $authorized = $true }
            }
            $state.Requests++
            $status = if ($authorized) { $state.Status } else { 401 }
            $body = if ($authorized) { $state.Body } else { '{}' }
            $bytes = [Text.Encoding]::UTF8.GetBytes($body)
            $headers = "HTTP/1.1 $status Test`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n"
            if ($state.Redirect) { $headers += "Location: http://127.0.0.1:$($listener.LocalEndpoint.Port)/redirect-target`r`n" }
            $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers + "`r`n")
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $client.Close() }
    }
}).AddArgument($listener).AddArgument($state)
$pending = $server.BeginInvoke()
$originalProxy = [Net.WebRequest]::DefaultWebProxy
try {
    # Force even loopback through a dead proxy to reproduce administrator proxy interference.
    Add-Type -TypeDefinition @'
using System;
using System.Net;
public sealed class InstallerTestProxy : IWebProxy {
    public ICredentials Credentials { get; set; }
    public Uri GetProxy(Uri destination) { return new Uri("http://127.0.0.1:1"); }
    public bool IsBypassed(Uri destination) { return false; }
}
'@
    [Net.WebRequest]::DefaultWebProxy = New-Object InstallerTestProxy
    $baseline = [Net.HttpWebRequest]::CreateHttp("http://127.0.0.1:$port/api/status")
    $baseline.Timeout = 1500
    $proxyFailed = $false
    try { $response = $baseline.GetResponse(); $response.Dispose() } catch { $proxyFailed = $true }
    Assert-Install $proxyFailed 'Default HTTP request fails with the forced broken proxy'
    Assert-Install (Test-LanPowerServiceHealth -Port $port -Token $state.Token) 'Health check succeeds directly despite the broken default proxy'
    Assert-Install ($state.LastPath -ceq '/api/status') 'Health check queries the authenticated status endpoint'
    Assert-Install (-not (Test-LanPowerServiceHealth -Port $port -Token ('b' * 64))) 'Unauthorized status is rejected'
    $cases = @(
        @{ Name = 'ordinary homepage'; Body = '<html>Welcome</html>'; Status = 200 },
        @{ Name = 'invalid JSON'; Body = '{invalid'; Status = 200 },
        @{ Name = 'string success flag'; Body = '{"ok":"true","state":"online"}'; Status = 200 },
        @{ Name = 'false success flag'; Body = '{"ok":false,"state":"online"}'; Status = 200 },
        @{ Name = 'offline state'; Body = '{"ok":true,"state":"offline"}'; Status = 200 },
        @{ Name = 'missing fields'; Body = '{}'; Status = 200 },
        @{ Name = 'empty body'; Body = ''; Status = 200 },
        @{ Name = 'oversized body'; Body = (' ' * 4097) + '{"ok":true,"state":"online"}'; Status = 200 },
        @{ Name = 'HTTP error'; Body = '{"ok":true,"state":"online"}'; Status = 503 },
        @{ Name = 'redirect'; Body = '{"ok":true,"state":"online"}'; Status = 302 }
    )
    foreach ($case in $cases) {
        $state.Body = $case.Body
        $state.Status = $case.Status
        $state.Redirect = $case.Status -eq 302
        $before = $state.Requests
        Assert-Install (-not (Test-LanPowerServiceHealth -Port $port -Token $state.Token)) ($case.Name + ' cannot pass installation')
        if ($state.Redirect) { Assert-Install ($state.Requests -eq $before + 1) 'Redirect target is never requested' }
    }
} finally {
    [Net.WebRequest]::DefaultWebProxy = $originalProxy
    $state.Stop = $true
    $listener.Stop()
    try { $server.EndInvoke($pending) | Out-Null } finally { $server.Dispose() }
}

# Diagnostic fields must remain useful without writing exception text or credentials.
function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($ClassName -ne 'Win32_Service' -or $Filter -ne "Name = 'LanPowerService'") { throw 'Unexpected CIM query' }
    if ($script:cimFails) { throw 'CIM unavailable' }
    return [pscustomobject]@{ State = 'Stopped'; ExitCode = 1067; ServiceSpecificExitCode = 42 }
}
$secret = 'test-secret-must-not-appear'
$exception = [InvalidOperationException]::new('https://private.example/ Authorization: Bearer ' + $secret,
    [ComponentModel.Win32Exception]::new(5, 'token=' + $secret))
$failure = [Management.Automation.ErrorRecord]::new($exception, 'TestFailure', 'NotSpecified', $secret)
$report = Get-LanPowerInstallFailure -Stage 'test stage' -Failure $failure
Assert-Install ($report.Contains('Win32=5') -and $report.Contains('Win32ExitCode=1067') -and $report.Contains('ServiceSpecificExitCode=42')) 'Diagnostic report retains exception and service error codes'
Assert-Install (-not ($report -match 'test-secret|private.example|Authorization|token=')) 'Diagnostic report omits exception text and credentials'
$script:cimFails = $true
Assert-Install ((Get-LanPowerInstallFailure -Stage 'test stage' -Failure $failure).Contains('Win32=5')) 'CIM failure does not hide the original error'
$script:cimFails = $false
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('LanPower-diagnostics-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDir | Out-Null
try {
    $resultPath = Join-Path $testDir 'result.txt'
    $logPath = Join-Path $testDir 'logs\install.log'
    Write-LanPowerInstallFailure -Stage 'test stage' -Failure $failure -ResultPath $resultPath -LogPath $logPath
    foreach ($path in @($resultPath, $logPath)) {
        $bytes = [IO.File]::ReadAllBytes($path)
        Assert-Install ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) 'Diagnostic output uses UTF-8 BOM'
        Assert-Install ([IO.File]::ReadAllText($path).Contains($report.Split([Environment]::NewLine)[0])) 'Chinese diagnostic title survives the file round trip'
    }
    Write-LanPowerInstallFailure -Stage 'second attempt' -Failure $failure -ResultPath $resultPath -LogPath $logPath
    Assert-Install (([IO.File]::ReadAllText($logPath)).Contains('test stage') -and ([IO.File]::ReadAllText($logPath)).Contains('second attempt')) 'Install log preserves earlier failures'
    $blocker = Join-Path $testDir 'not-a-directory'
    [IO.File]::WriteAllText($blocker, 'test')
    Write-LanPowerInstallFailure -Stage 'test stage' -Failure $failure -ResultPath (Join-Path $blocker 'result') -LogPath (Join-Path $blocker 'log')
    Assert-Install $true 'Unwritable diagnostic paths do not throw'
} finally {
    $resolved = [IO.Path]::GetFullPath($testDir)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
