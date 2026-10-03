param([switch]$SkipPublish, [string]$DotnetPath = 'dotnet')
$ErrorActionPreference = 'Stop'
$windowsDir = Split-Path -Parent $PSScriptRoot
$outputDir = [IO.Path]::GetFullPath((Join-Path $windowsDir 'out')).TrimEnd('\')
if (-not $SkipPublish) {
    foreach ($project in @('Service', 'Desktop', 'CodexHost', 'CodexServer')) {
        & $DotnetPath publish (Join-Path $windowsDir "LanPower.$project\LanPower.$project.csproj") -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o (Join-Path $outputDir $project.ToLowerInvariant())
        if ($LASTEXITCODE -ne 0) { throw "$project 发布失败。" }
    }
}
$stage = [IO.Path]::GetFullPath((Join-Path $outputDir 'portable-stage'))
if (-not $stage.StartsWith($outputDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '便携包目录校验失败。' }
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$components = [ordered]@{
    'Service/LanPower.Service.exe' = 'service/LanPower.Service.exe'
    'Service/aspnetcorev2_inprocess.dll' = 'service/aspnetcorev2_inprocess.dll'
    'Service/LanPower.Service.staticwebassets.endpoints.json' = 'service/LanPower.Service.staticwebassets.endpoints.json'
    'Service/static/index.html' = 'service/static/index.html'
    'Service/static/app.js' = 'service/static/app.js'
    'Service/static/app.css' = 'service/static/app.css'
    'Service/static/icon.svg' = 'service/static/icon.svg'
    'Desktop/LanPower.Desktop.exe' = 'desktop/LanPower.Desktop.exe'
    'Desktop/D3DCompiler_47_cor3.dll' = 'desktop/D3DCompiler_47_cor3.dll'
    'Desktop/PenImc_cor3.dll' = 'desktop/PenImc_cor3.dll'
    'Desktop/PresentationNative_cor3.dll' = 'desktop/PresentationNative_cor3.dll'
    'Desktop/vcruntime140_cor3.dll' = 'desktop/vcruntime140_cor3.dll'
    'Desktop/wpfgfx_cor3.dll' = 'desktop/wpfgfx_cor3.dll'
    'CodexHost/LanPower.CodexHost.exe' = 'codexhost/LanPower.CodexHost.exe'
    'CodexServer/1.14.0/LanPower.CodexServer.exe' = 'codexserver/LanPower.CodexServer.exe'
}
foreach ($entry in $components.GetEnumerator()) {
    $source = Join-Path $outputDir $entry.Value
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少发布组件：$($entry.Key)" }
    $destination = Join-Path $stage $entry.Key
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
}
foreach ($name in @('install-service.ps1', 'network-selection.ps1', 'install-diagnostics.ps1', 'uninstall-service.ps1')) {
    [IO.File]::WriteAllText((Join-Path $stage $name), [IO.File]::ReadAllText((Join-Path $PSScriptRoot $name), [Text.Encoding]::UTF8), [Text.UTF8Encoding]::new($true))
}
foreach ($name in @('Install.cmd', 'Open.cmd', 'Install-Portable.ps1', 'README.txt')) {
    $source = Join-Path (Join-Path $PSScriptRoot 'portable') $name
    if ($name -like '*.ps1') {
        [IO.File]::WriteAllText((Join-Path $stage $name), [IO.File]::ReadAllText($source, [Text.Encoding]::UTF8), [Text.UTF8Encoding]::new($true))
    } elseif ($name -like '*.cmd') {
        [IO.File]::WriteAllText((Join-Path $stage $name), [IO.File]::ReadAllText($source).Replace("`r`n", "`n").Replace("`n", "`r`n"), [Text.Encoding]::ASCII)
    } else { Copy-Item -LiteralPath $source -Destination (Join-Path $stage $name) }
}
$manifest = foreach ($relative in @($components.Keys) + @('install-service.ps1', 'network-selection.ps1', 'install-diagnostics.ps1', 'uninstall-service.ps1')) {
    (Get-FileHash -LiteralPath (Join-Path $stage $relative) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $relative
}
[IO.File]::WriteAllLines((Join-Path $stage 'FILES.sha256'), $manifest, [Text.UTF8Encoding]::new($false))
$zip = Join-Path $outputDir 'LanPower-portable-x64.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
Write-Output $zip
