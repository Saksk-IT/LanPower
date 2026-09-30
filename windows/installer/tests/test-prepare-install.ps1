$ErrorActionPreference = 'Stop'
$installerRoot = Split-Path -Parent $PSScriptRoot
$source = [IO.File]::ReadAllText((Join-Path $installerRoot 'LanPower.iss'))
$match = [regex]::Match($source, "'(?<arguments>-NoProfile -NonInteractive -Command [^\r\n]+)',")
if (-not $match.Success) { throw 'Cannot locate the installer service preparation command.' }
$arguments = $match.Groups['arguments'].Value.Replace("''", "'")
# Query a unique absent name so this check never controls a real service.
$absentName = 'LanPowerInstallerTest-' + [Guid]::NewGuid().ToString('N')
$arguments = $arguments.Replace('LanPowerService', $absentName)
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$check = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
if ($check.ExitCode -ne 0) { throw 'A missing prior service must not prevent first installation.' }
Write-Output 'PASS: installer preparation permits a first installation with no prior service'
