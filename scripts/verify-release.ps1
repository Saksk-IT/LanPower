param([string]$ArtifactDir = '')
$ErrorActionPreference = 'Stop'
if (-not $ArtifactDir) { $ArtifactDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\out' }
$names = @('LanPowerSetup-x64.exe', 'LanPower-portable-x64.zip', 'lanpower-gateway-linux-arm64')
$lines = @(Get-Content -LiteralPath (Join-Path $ArtifactDir 'SHA256SUMS.txt') -Encoding UTF8)
if ($lines.Count -ne $names.Count) { throw '发布校验清单无效。' }
foreach ($index in 0..($names.Count - 1)) {
    $name = $names[$index]
    $expected = (Get-FileHash -LiteralPath (Join-Path $ArtifactDir $name) -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $name
    if ($lines[$index] -ne $expected) { throw "发布校验失败：$name" }
}
$gateway = [IO.File]::ReadAllBytes((Join-Path $ArtifactDir 'lanpower-gateway-linux-arm64'))
if ($gateway.Length -lt 64 -or $gateway[0] -ne 127 -or $gateway[1] -ne 69 -or $gateway[2] -ne 76 -or $gateway[3] -ne 70 -or
    $gateway[4] -ne 2 -or $gateway[5] -ne 1 -or $gateway[18] -ne 183 -or $gateway[19] -ne 0) { throw 'Gateway 必须是 Linux ARM64 ELF。' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $ArtifactDir 'LanPower-portable-x64.zip'))
try {
    $expected = @(
        'Service/LanPower.Service.exe', 'Service/aspnetcorev2_inprocess.dll', 'Service/LanPower.Service.staticwebassets.endpoints.json',
        'Service/static/index.html', 'Service/static/app.js', 'Service/static/app.css', 'Service/static/icon.svg',
        'Desktop/LanPower.Desktop.exe', 'Desktop/D3DCompiler_47_cor3.dll', 'Desktop/PenImc_cor3.dll',
        'Desktop/PresentationNative_cor3.dll', 'Desktop/vcruntime140_cor3.dll', 'Desktop/wpfgfx_cor3.dll',
        'install-service.ps1', 'network-selection.ps1', 'uninstall-service.ps1', 'Install.cmd', 'Open.cmd',
        'Install-Portable.ps1', 'README.txt', 'FILES.sha256'
    )
    $actual = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if (Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)) { throw '便携包包含缺失或未允许的文件。' }
    $manifestEntry = $zip.GetEntry('FILES.sha256')
    $reader = [IO.StreamReader]::new($manifestEntry.Open(), [Text.Encoding]::UTF8)
    try { $manifest = $reader.ReadToEnd() -split '\r?\n' | Where-Object { $_ } } finally { $reader.Dispose() }
    if ($manifest.Count -ne 16) { throw '便携组件清单不完整。' }
    $manifestPaths = @()
    foreach ($line in $manifest) {
        if ($line -notmatch '^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$') { throw '便携组件清单无效。' }
        $hash = $Matches[1]
        $path = $Matches[2]
        if ($path -cnotin $expected[0..15] -or $path -cin $manifestPaths) { throw '便携组件清单含重复或未允许的文件。' }
        $manifestPaths += $path
        $entry = $zip.GetEntry($path)
        if (-not $entry) { throw '便携组件缺失。' }
        $stream = $entry.Open()
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actualHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $sha.Dispose() }
        if ($actualHash -ne $hash) { throw '便携组件哈希不匹配。' }
    }
} finally { $zip.Dispose() }
Write-Output '发布产物验证通过：三个文件哈希、ARM64 格式、便携包白名单及组件哈希。'
