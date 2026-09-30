param([string]$DotnetPath = 'dotnet', [string]$GoPath = 'go', [string]$IsccPath = '')
$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $repoDir 'windows\out'
& (Join-Path $repoDir 'windows\installer\build-installer.ps1') -DotnetPath $DotnetPath -IsccPath $IsccPath
& (Join-Path $repoDir 'windows\installer\build-portable.ps1') -SkipPublish -DotnetPath $DotnetPath
$previousGoOs = [Environment]::GetEnvironmentVariable('GOOS', 'Process')
$previousGoArch = [Environment]::GetEnvironmentVariable('GOARCH', 'Process')
$previousCgo = [Environment]::GetEnvironmentVariable('CGO_ENABLED', 'Process')
Push-Location (Join-Path $repoDir 'router_gateway')
try {
    $env:GOOS = 'linux'
    $env:GOARCH = 'arm64'
    $env:CGO_ENABLED = '0'
    & $GoPath build -trimpath '-ldflags=-s -w' -o (Join-Path $outputDir 'lanpower-gateway-linux-arm64') ./cmd/lanpower-gateway
    if ($LASTEXITCODE -ne 0) { throw 'Gateway ARM64 构建失败。' }
} finally {
    Pop-Location
    [Environment]::SetEnvironmentVariable('GOOS', $previousGoOs, 'Process')
    [Environment]::SetEnvironmentVariable('GOARCH', $previousGoArch, 'Process')
    [Environment]::SetEnvironmentVariable('CGO_ENABLED', $previousCgo, 'Process')
}
$artifacts = @('LanPowerSetup-x64.exe', 'LanPower-portable-x64.zip', 'lanpower-gateway-linux-arm64')
$hashes = foreach ($name in $artifacts) {
    (Get-FileHash -LiteralPath (Join-Path $outputDir $name) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $name
}
[IO.File]::WriteAllLines((Join-Path $outputDir 'SHA256SUMS.txt'), $hashes, [Text.UTF8Encoding]::new($false))
Write-Output "发布产物已生成：$outputDir"
