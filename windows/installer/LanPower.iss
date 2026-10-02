#define AppVersion "1.7.2"

[Setup]
AppId={{8A2B40CB-05CD-4A61-8A72-CFE71A60A8B2}
AppName=LanPower
AppVersion={#AppVersion}
AppPublisher=LanPower
DefaultDirName={autopf}\LanPower
DefaultGroupName=LanPower
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
SetupLogging=yes

[Languages]
Name: "zh"; MessagesFile: "ChineseSimplified.isl"

[Files]
Source: "..\out\service\*"; DestDir: "{app}\Service"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\out\desktop\*"; DestDir: "{app}\Desktop"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\out\setup\install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\out\setup\network-selection.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\out\setup\install-diagnostics.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\out\setup\uninstall-service.ps1"; DestDir: "{app}"; Flags: ignoreversion; AfterInstall: InstallLanPowerService

[Icons]
Name: "{group}\LanPower"; Filename: "{app}\Desktop\LanPower.Desktop.exe"; Check: ServiceIsReady
Name: "{autodesktop}\LanPower"; Filename: "{app}\Desktop\LanPower.Desktop.exe"; Tasks: desktopicon; Check: ServiceIsReady

[Tasks]
Name: desktopicon; Description: "创建桌面快捷方式"

[Run]
Filename: "{app}\Desktop\LanPower.Desktop.exe"; Description: "打开 LanPower"; Flags: nowait postinstall skipifsilent runasoriginaluser; Check: ServiceIsReady

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"""; RunOnceId: "LanPowerServiceCleanup"; Flags: runhidden waituntilterminated

[Code]
#include "service-setup.iss"

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop LanPowerService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if (not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "try { $s = Get-Service LanPowerService -ErrorAction SilentlyContinue; if ($s) { $s.WaitForStatus(''Stopped'', [TimeSpan]::FromSeconds(30)) }; exit 0 } catch { exit 1 }"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
  begin
    Result := '无法停止现有 LanPower Service，请稍后重试。';
    Exit;
  end;
  Result := '';
end;
