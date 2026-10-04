$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
    $elevated = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    exit $elevated.ExitCode
}

# LocalSystem must not load executables from a user-writable extraction folder.
# Copy only the packaged manifest into the protected installation directory.
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$appDir = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'LanPower')).TrimEnd('\')
if ($sourceRoot -eq $appDir) { throw '请在解压目录运行安装入口。' }

function Assert-PlainPath([string]$Root, [string]$Path) {
    $current = $Root
    $segments = @('') + @($Path.Substring($Root.Length).TrimStart('\').Split('\') | Where-Object { $_ })
    foreach ($segment in $segments) {
        if ($segment) { $current = Join-Path $current $segment }
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw '安装文件及目录不能是链接。'
        }
    }
}

Assert-PlainPath $sourceRoot (Join-Path $sourceRoot 'FILES.sha256')
$manifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'FILES.sha256') -Encoding UTF8
$expected = @(
    'Service/LanPower.Service.exe', 'Service/aspnetcorev2_inprocess.dll', 'Service/LanPower.Service.staticwebassets.endpoints.json',
    'Service/static/index.html', 'Service/static/app.js', 'Service/static/app.css', 'Service/static/icon.svg',
    'Desktop/LanPower.Desktop.exe', 'Desktop/D3DCompiler_47_cor3.dll', 'Desktop/PenImc_cor3.dll',
    'Desktop/PresentationNative_cor3.dll', 'Desktop/vcruntime140_cor3.dll', 'Desktop/wpfgfx_cor3.dll',
    'CodexHost/LanPower.CodexHost.exe',
    'CodexServer/1.20.2/LanPower.CodexServer.exe',
    'install-service.ps1', 'network-selection.ps1', 'install-diagnostics.ps1', 'codex-startup.ps1', 'uninstall-service.ps1'
)
$seen = @()
$files = @(
    foreach ($line in $manifest) {
        if ($line -notmatch '^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$') { throw '便携包文件清单无效。' }
        $hash = $Matches[1]
        $entry = $Matches[2]
        if ($entry -cnotin $expected -or $entry -cin $seen) { throw '便携包文件清单不匹配。' }
        $seen += $entry
        $relative = $entry.Replace('/', '\')
        $source = [IO.Path]::GetFullPath((Join-Path $sourceRoot $relative))
        $destination = [IO.Path]::GetFullPath((Join-Path $appDir $relative))
        if (-not $source.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
            -not $destination.StartsWith($appDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '便携包路径无效。' }
        Assert-PlainPath $sourceRoot $source
        Assert-PlainPath $appDir $destination
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw '便携包校验失败，请重新下载。' }
        [pscustomobject]@{ Source = $source; Destination = $destination }
    }
)
if ($files.Count -ne $expected.Count) { throw '便携包文件不完整。' }
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
& (Join-Path $sourceRoot 'codex-startup.ps1') -AppDir $appDir -Mode Pause
$service = Get-Service -Name 'LanPowerService' -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Stopped') {
    Stop-Service -Name 'LanPowerService' -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}
foreach ($file in $files) {
    $parent = Split-Path -Parent $file.Destination
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Assert-PlainPath $appDir $file.Destination
    Copy-Item -LiteralPath $file.Source -Destination $file.Destination -Force
}
& (Join-Path $appDir 'install-service.ps1') -AppDir $appDir
if (-not $?) { throw '服务安装失败。' }
Write-Output '安装完成，请用 Open.cmd 打开 LanPower。'
