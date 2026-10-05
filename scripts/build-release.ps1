param([string]$DotnetPath = 'dotnet', [string]$GoPath = 'go', [string]$IsccPath = '')
$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $repoDir 'windows\out'
& python (Join-Path $repoDir 'scripts\validate-public-files.py')
if ($LASTEXITCODE -ne 0) { throw '公开文件检查失败。' }
& python (Join-Path $repoDir 'scripts\validate-release-tag.py') ('refs/tags/v' + (Get-Content -LiteralPath (Join-Path $repoDir 'VERSION') -Raw).Trim())
if ($LASTEXITCODE -ne 0) { throw '发布版本检查失败。' }
& python (Join-Path $repoDir 'scripts\verify-codex-web-assets.py') --version (Get-Content -LiteralPath (Join-Path $repoDir 'VERSION') -Raw).Trim()
if ($LASTEXITCODE -ne 0) { throw '网页资源完整性检查失败。' }
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
# Archive the committed public tree so local AppIDs and preview credentials cannot enter the package.
$miniProgramArchive = Join-Path $outputDir 'LanPower-mini-program.zip'
& git -C $repoDir archive --format=zip "--output=$miniProgramArchive" HEAD mini_program
if ($LASTEXITCODE -ne 0) { throw '小程序源码打包失败。' }
$artifacts = @('LanPowerSetup-x64.exe', 'LanPower-portable-x64.zip', 'lanpower-gateway-linux-arm64', 'LanPower-mini-program.zip')
$hashes = foreach ($name in $artifacts) {
    (Get-FileHash -LiteralPath (Join-Path $outputDir $name) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $name
}
[IO.File]::WriteAllLines((Join-Path $outputDir 'SHA256SUMS.txt'), $hashes, [Text.UTF8Encoding]::new($false))
Write-Output "发布产物已生成：$outputDir"
