param([string]$DotnetPath = 'dotnet', [string]$IsccPath = '')
$ErrorActionPreference = 'Stop'
$windowsDir = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $windowsDir 'out'
if (-not $IsccPath) {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { $IsccPath = $command.Source }
    else {
        $systemCompiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
        $userCompiler = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
        $IsccPath = if (Test-Path -LiteralPath $systemCompiler) { $systemCompiler } else { $userCompiler }
    }
}
if (-not (Test-Path -LiteralPath $IsccPath)) { throw '找不到 Inno Setup 6 的 ISCC.exe。' }
$resolvedOutput = [System.IO.Path]::GetFullPath($outputDir).TrimEnd('\')
foreach ($name in @('service', 'desktop', 'codexhost', 'codexserver')) {
    $target = [System.IO.Path]::GetFullPath((Join-Path $resolvedOutput $name))
    if (-not $target.StartsWith($resolvedOutput + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw '发布目录校验失败。'
    }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
& $DotnetPath publish (Join-Path $windowsDir 'LanPower.Service\LanPower.Service.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o (Join-Path $outputDir 'service')
if ($LASTEXITCODE -ne 0) { throw 'Service 发布失败。' }
& $DotnetPath publish (Join-Path $windowsDir 'LanPower.Desktop\LanPower.Desktop.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o (Join-Path $outputDir 'desktop')
if ($LASTEXITCODE -ne 0) { throw 'Desktop 发布失败。' }
& $DotnetPath publish (Join-Path $windowsDir 'LanPower.CodexHost\LanPower.CodexHost.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o (Join-Path $outputDir 'codexhost')
if ($LASTEXITCODE -ne 0) { throw 'Codex Host 发布失败。' }
& $DotnetPath publish (Join-Path $windowsDir 'LanPower.CodexServer\LanPower.CodexServer.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o (Join-Path $outputDir 'codexserver')
if ($LASTEXITCODE -ne 0) { throw 'Codex 共享服务发布失败。' }
# Windows PowerShell 5.1 reads non-BOM files using the system ANSI code page.
# Package UTF-8 BOM scripts so Chinese error messages survive installation.
$setupDir = Join-Path $outputDir 'setup'
New-Item -ItemType Directory -Path $setupDir -Force | Out-Null
foreach ($name in @('install-service.ps1', 'network-selection.ps1', 'install-diagnostics.ps1', 'uninstall-service.ps1')) {
    [IO.File]::WriteAllText((Join-Path $setupDir $name),
        [IO.File]::ReadAllText((Join-Path $PSScriptRoot $name), [Text.Encoding]::UTF8), [Text.UTF8Encoding]::new($true))
}
& $IsccPath (Join-Path $PSScriptRoot 'LanPower.iss')
if ($LASTEXITCODE -ne 0) { throw '安装包构建失败。' }
Write-Host (Join-Path $outputDir 'LanPowerSetup-x64.exe')
