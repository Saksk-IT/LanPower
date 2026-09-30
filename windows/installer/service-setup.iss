// Run after the last installed file, before shortcuts and successful completion.
var
  ServiceInstallFailed: Boolean;
  ServiceInstallReady: Boolean;

function ServiceIsReady: Boolean;
begin
  Result := ServiceInstallReady;
end;

function GetCustomSetupExitCode: Integer;
begin
  if ServiceInstallFailed then
    Result := 10
  else
    Result := 0;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and ServiceInstallFailed then
  begin
    WizardForm.FinishedHeadingLabel.Caption := 'LanPower 安装未完成';
    WizardForm.FinishedLabel.Caption := '后台服务安装失败，应用暂时无法使用。' + #13#10 + #13#10 +
      '请保留错误弹窗内容。若已生成诊断日志，可在 ProgramData\LanPower\logs\install.log 中查看。' + #13#10 +
      '请先确认失败原因，再重新安装。原配对数据已保留。';
  end;
end;

procedure InstallLanPowerService;
var
  ResultCode: Integer;
  Script, ResultFile, Details: String;
  Lines: TArrayOfString;
  Index: Integer;
begin
  ServiceInstallReady := False;
  ResultFile := ExpandConstant('{tmp}\LanPower-install-result.txt');
  DeleteFile(ResultFile);
  Script := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}\install-service.ps1') + '" -AppDir "' +
    ExpandConstant('{app}') + '" -ResultPath "' + ResultFile + '"';
  if (not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Script,
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
  begin
    ServiceInstallFailed := True;
    Details := 'LanPower Service 安装失败，安装未完成。' + #13#10 +
      'PowerShell 返回码：' + IntToStr(ResultCode);
    if LoadStringsFromFile(ResultFile, Lines) then
      for Index := 0 to GetArrayLength(Lines) - 1 do
        Details := Details + #13#10 + Lines[Index];
    Details := Details + #13#10 + '请保留错误信息，以便确认失败原因。';
    Log(Details);
    // Exceptions in AfterInstall are caught by Inno and do not cancel setup.
    // Keep the failure explicit in the dialog, final page and process exit code.
    SuppressibleMsgBox(Details, mbCriticalError, MB_OK, IDOK);
    Exit;
  end;
  ServiceInstallFailed := False;
  ServiceInstallReady := True;
end;
