#define AppVersion "1.24.7"

[Setup]
AppId={{8A2B40CB-05CD-4A61-8A72-CFE71A60A8B2}
AppName=CodexDock
AppVersion={#AppVersion}
AppPublisher=CodexDock
DefaultDirName={autopf}\LanPower
DefaultGroupName=CodexDock
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\out
OutputBaseFilename=LanPowerSetup-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\LanPower.Desktop\Assets\LanPower.ico
UninstallDisplayIcon={app}\Desktop\LanPower.Desktop.exe
CloseApplications=yes
CloseApplicationsFilter=LanPower.Service.exe,LanPower.Desktop.exe,LanPower.CodexHost.exe
SetupLogging=yes

[Languages]
Name: "zh"; MessagesFile: "ChineseSimplified.isl"

[Files]
Source: "..\out\service\*"; DestDir: "{app}\Service"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\out\desktop\*"; DestDir: "{app}\Desktop"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\out\codexhost\LanPower.CodexHost.exe"; DestDir: "{app}\CodexHost"; Flags: ignoreversion
Source: "..\out\codexserver\LanPower.CodexServer.exe"; DestDir: "{app}\CodexServer\{#AppVersion}"; Flags: ignoreversion
Source: "..\out\setup\install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\out\setup\network-selection.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\out\setup\install-diagnostics.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\out\setup\codex-startup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\out\setup\codex-startup.ps1"; Flags: dontcopy
Source: "..\out\setup\uninstall-service.ps1"; DestDir: "{app}"; Flags: ignoreversion; AfterInstall: InstallLanPowerService

[Icons]
Name: "{group}\CodexDock"; Filename: "{app}\Desktop\LanPower.Desktop.exe"; Check: ServiceIsReady
Name: "{autodesktop}\CodexDock"; Filename: "{app}\Desktop\LanPower.Desktop.exe"; Tasks: desktopicon; Check: ServiceIsReady

[Tasks]
Name: desktopicon; Description: "创建桌面快捷方式"

[Run]
Filename: "{app}\CodexHost\LanPower.CodexHost.exe"; Description: "启动当前用户 Codex Host"; Flags: nowait postinstall skipifsilent runasoriginaluser; Check: ServiceIsReady
Filename: "{app}\Desktop\LanPower.Desktop.exe"; Description: "打开 CodexDock"; Flags: nowait postinstall skipifsilent runasoriginaluser; Check: ServiceIsReady

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"""; RunOnceId: "LanPowerServiceCleanup"; Flags: runhidden waituntilterminated

[Code]
#include "service-setup.iss"

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  ExtractTemporaryFile('codex-startup.ps1');
  if (not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\codex-startup.ps1') +
    '" -AppDir "' + ExpandConstant('{app}') + '" -Mode Pause',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
  begin
    Result := '无法暂停现有 CodexDock 后台进程，请稍后重试。';
    Exit;
  end;
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop LanPowerService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if (not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "try { $s = Get-Service LanPowerService -ErrorAction SilentlyContinue; if ($s) { $s.WaitForStatus(''Stopped'', [TimeSpan]::FromSeconds(30)) }; exit 0 } catch { exit 1 }"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
  begin
    Result := '无法停止现有 CodexDock Service，请稍后重试。';
    Exit;
  end;
  Result := '';
end;
