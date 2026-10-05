param([string]$ArtifactDir = '')
$ErrorActionPreference = 'Stop'
if (-not $ArtifactDir) { $ArtifactDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\out' }
$repoDir = Split-Path -Parent $PSScriptRoot
$names = @('LanPowerSetup-x64.exe', 'LanPower-portable-x64.zip', 'lanpower-gateway-linux-arm64', 'LanPower-mini-program.zip')
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
        'CodexHost/LanPower.CodexHost.exe',
        'CodexServer/1.22.1/LanPower.CodexServer.exe',
        'install-service.ps1', 'network-selection.ps1', 'install-diagnostics.ps1', 'codex-startup.ps1', 'uninstall-service.ps1', 'Install.cmd', 'Open.cmd',
        'Install-Portable.ps1', 'README.txt', 'FILES.sha256'
    )
    $actual = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    if (Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)) { throw '便携包包含缺失或未允许的文件。' }
    $manifestEntry = $zip.GetEntry('FILES.sha256')
    $reader = [IO.StreamReader]::new($manifestEntry.Open(), [Text.Encoding]::UTF8)
    try { $manifest = $reader.ReadToEnd() -split '\r?\n' | Where-Object { $_ } } finally { $reader.Dispose() }
    if ($manifest.Count -ne 20) { throw '便携组件清单不完整。' }
    $manifestPaths = @()
    foreach ($line in $manifest) {
        if ($line -notmatch '^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$') { throw '便携组件清单无效。' }
        $hash = $Matches[1]
        $path = $Matches[2]
        if ($path -cnotin $expected[0..19] -or $path -cin $manifestPaths) { throw '便携组件清单含重复或未允许的文件。' }
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
$miniZip = [IO.Compression.ZipFile]::OpenRead((Join-Path $ArtifactDir 'LanPower-mini-program.zip'))
try {
    $expected = @(& git -C $repoDir ls-tree -r --name-only HEAD -- mini_program)
    if ($LASTEXITCODE -ne 0 -or $expected.Count -eq 0) { throw '无法读取小程序公开文件清单。' }
    $actual = @($miniZip.Entries | Where-Object { -not $_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName })
    if (Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)) { throw '小程序包包含缺失或未允许的文件。' }
    foreach ($path in @('mini_program/project.config.json', 'mini_program/utils/version.js')) {
        $reader = [IO.StreamReader]::new($miniZip.GetEntry($path).Open(), [Text.Encoding]::UTF8)
        try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($path.EndsWith('.json')) {
            if (($content | ConvertFrom-Json).appid -ne 'touristappid') { throw '小程序包包含个人 AppID。' }
        } elseif ($content.Trim() -ne (Get-Content -LiteralPath (Join-Path $repoDir $path) -Raw).Trim()) {
            throw '小程序包版本与当前源码不一致；请先提交发布改动。'
        }
    }
} finally { $miniZip.Dispose() }
Write-Output '发布产物验证通过：四个文件哈希、ARM64 格式、便携包白名单与组件哈希、小程序公开文件和版本。'
