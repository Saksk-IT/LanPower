@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-LanPower.ps1"
if errorlevel 1 (
  echo Uninstall failed. See the message above.
  pause
  exit /b 1
)
