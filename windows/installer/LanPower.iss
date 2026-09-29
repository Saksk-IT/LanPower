#define AppVersion "1.4.0"

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
UninstallDisplayIcon={app}\Desktop\LanPower.Desktop.exe
CloseApplications=yes

[Languages]
Name: "zh"; MessagesFile: "ChineseSimplified.isl"

[Files]
Source: "..\out\service\*"; DestDir: "{app}\Service"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\out\desktop\*"; DestDir: "{app}\Desktop"; Excludes: "*.pdb"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "install-service.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "uninstall-service.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\LanPower"; Filename: "{app}\Desktop\LanPower.Desktop.exe"
Name: "{autodesktop}\LanPower"; Filename: "{app}\Desktop\LanPower.Desktop.exe"; Tasks: desktopicon

[Tasks]
Name: desktopicon; Description: "创建桌面快捷方式"

[Run]
Filename: "{app}\Desktop\LanPower.Desktop.exe"; Description: "打开 LanPower"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"""; RunOnceId: "LanPowerServiceCleanup"; Flags: runhidden waituntilterminated

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop LanPowerService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Script: String;
begin
  if CurStep = ssPostInstall then
  begin
    Script := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\install-service.ps1') +
      '" -AppDir "' + ExpandConstant('{app}') + '"';
    if (not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Script,
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      RaiseException('LanPower Service 安装失败，请检查服务日志。');
  end;
end;
