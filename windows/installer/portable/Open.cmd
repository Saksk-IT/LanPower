@echo off
if exist "%ProgramFiles%\LanPower\Desktop\LanPower.Desktop.exe" (
  start "" "%ProgramFiles%\LanPower\Desktop\LanPower.Desktop.exe"
) else (
  echo Run Install.cmd first.
  pause
)
