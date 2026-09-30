param([string]$IsccPath = '')
$ErrorActionPreference = 'Stop'
if (-not $IsccPath) {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { $IsccPath = $command.Source }
    else {
        $systemCompiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
        $userCompiler = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
        $IsccPath = if (Test-Path -LiteralPath $systemCompiler) { $systemCompiler } else { $userCompiler }
    }
}
if (-not (Test-Path -LiteralPath $IsccPath)) { throw 'Inno Setup compiler is required.' }
$installerRoot = Split-Path -Parent $PSScriptRoot
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('LanPower-setup-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDir | Out-Null
$utf8 = [Text.UTF8Encoding]::new($true)
try {
    # This installer runs without elevation, writes only in its temporary directory,
    # and uses a mock script instead of touching the installed Windows service.
    $mock = @'
param([string]$AppDir, [string]$ResultPath)
$ErrorActionPreference = 'Stop'
$mode = [IO.File]::ReadAllText((Join-Path $AppDir '..\mode.txt'))
if ($mode -eq 'success') { exit 0 }
if ($mode -eq 'no-report') { exit 23 }
. (Join-Path $AppDir 'install-diagnostics.ps1')
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    [pscustomobject]@{ State = 'Stopped'; ExitCode = 1067; ServiceSpecificExitCode = 0 }
}
try { throw [ComponentModel.Win32Exception]::new(1067, 'do-not-log-this-private-message') }
catch {
    Write-LanPowerInstallFailure -Stage 'mock service start' -Failure $_ -ResultPath $ResultPath -LogPath (Join-Path $AppDir 'logs\install.log')
}
exit 1
'@
    [IO.File]::WriteAllText((Join-Path $testDir 'install-service.ps1'), $mock, $utf8)
    [IO.File]::WriteAllText((Join-Path $testDir 'mark-started.ps1'),
        '[IO.File]::WriteAllText((Join-Path $PSScriptRoot ''started.txt''), ''started'')', $utf8)
    [IO.File]::WriteAllText((Join-Path $testDir 'install-diagnostics.ps1'),
        [IO.File]::ReadAllText((Join-Path $installerRoot 'install-diagnostics.ps1'), [Text.Encoding]::UTF8), $utf8)
    $definition = @'
[Setup]
AppId=LanPowerInstallerFlowTest
AppName=LanPower installer flow test
AppVersion=1.0
DefaultDirName=__TEST_DIR__\installed
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
DisableProgramGroupPage=yes
DisableDirPage=yes
UsePreviousAppDir=no
OutputDir=__TEST_DIR__
OutputBaseFilename=flow-test
Compression=none
SetupLogging=yes
[Files]
Source: "__TEST_DIR__\install-diagnostics.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "__TEST_DIR__\mark-started.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "__TEST_DIR__\install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion; AfterInstall: InstallLanPowerService
[Icons]
Name: "{app}\test-shortcut"; Filename: "{sys}\cmd.exe"; Check: ServiceIsReady
[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\mark-started.ps1"""; Flags: runhidden; Check: ServiceIsReady
[Code]
#include "__SERVICE_SETUP__"
procedure DeinitializeSetup;
begin
  if ServiceInstallFailed then
  begin
    // Silent setup skips the final page; exercise the same page event explicitly.
    CurPageChanged(wpFinished);
    if WizardForm.FinishedHeadingLabel.Caption = 'LanPower 安装未完成' then
      SaveStringToFile('__TEST_DIR__\failure-page.txt', 'failure page verified', False);
  end;
end;
'@
    $definition = $definition.Replace('__TEST_DIR__', $testDir).Replace('__SERVICE_SETUP__', (Join-Path $installerRoot 'service-setup.iss'))
    $issPath = Join-Path $testDir 'flow-test.iss'
    [IO.File]::WriteAllText($issPath, $definition, $utf8)
    & $IsccPath '/Q' $issPath
    if ($LASTEXITCODE -ne 0) { throw 'Test installer compilation failed.' }
    foreach ($mode in @('failure', 'no-report', 'success')) {
        $pageMarker = Join-Path $testDir 'failure-page.txt'
        if (Test-Path -LiteralPath $pageMarker) { Remove-Item -LiteralPath $pageMarker }
        [IO.File]::WriteAllText((Join-Path $testDir 'mode.txt'), $mode)
        $appDir = Join-Path $testDir $mode
        $logPath = Join-Path $testDir ($mode + '.log')
        $process = Start-Process -FilePath (Join-Path $testDir 'flow-test.exe') -WindowStyle Hidden -PassThru -ArgumentList (
            '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /DIR="' + $appDir + '" /LOG="' + $logPath + '"')
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Test installer timed out.' }
        $shortcut = Test-Path -LiteralPath (Join-Path $appDir 'test-shortcut.lnk')
        $started = Test-Path -LiteralPath (Join-Path $appDir 'started.txt')
        $log = [IO.File]::ReadAllText($logPath)
        if ($mode -eq 'success') {
            if ($process.ExitCode -ne 0 -or -not $shortcut -or -not $started) { throw 'Successful service setup must create a shortcut and allow launch.' }
            Write-Output 'PASS: successful setup creates its shortcut and launches only after the service check'
        } else {
            if ($process.ExitCode -eq 0 -or $shortcut -or $started) { throw 'Failed service setup must fail installation without a shortcut or launch.' }
            if (-not (Test-Path -LiteralPath $pageMarker)) { throw 'Failed setup must show an incomplete installation heading.' }
            if ($mode -eq 'failure' -and (-not $log.Contains('mock service start') -or -not $log.Contains('Win32ExitCode=1067'))) {
                throw 'The installation error must include the diagnostic report.'
            }
            if ($mode -eq 'no-report' -and -not $log.Contains('23')) { throw 'Missing report must still show the process exit code.' }
            if ($log.Contains('do-not-log-this-private-message')) { throw 'Private exception text reached the setup log.' }
            Write-Output "PASS: $mode returns $($process.ExitCode), records the failure, updates the final page, creates no shortcut and does not launch"
        }
    }
} finally {
    $resolved = [IO.Path]::GetFullPath($testDir)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
