$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
$installerRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('LanPowerStartupTests-' + [Guid]::NewGuid().ToString('N'))
$script:task = $null
$script:registered = $null
$script:stopped = @()
$script:disabled = $false
$script:removed = $false
$script:started = $false
function Assert-Startup([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-ScheduledTask { param($TaskName, $ErrorAction) $script:task }
function Register-ScheduledTask { param($TaskName, $Action, $Trigger, $Principal, $Settings, $Description, [switch]$Force)
    $script:registered = @{ Action=$Action; Trigger=$Trigger; Principal=$Principal; Settings=$Settings }
}
function Start-ScheduledTask { param($TaskName) $script:started = $true }
function Disable-ScheduledTask { param($TaskName) $script:disabled = $true }
function Stop-ScheduledTask { param($TaskName) }
function Unregister-ScheduledTask { param($TaskName, [switch]$Confirm) $script:removed = $true }
function Get-CimInstance { param($ClassName, $Filter) @(
    [pscustomobject]@{ExecutablePath=(Join-Path $testRoot 'CodexHost\LanPower.CodexHost.exe'); ProcessId=101},
    [pscustomobject]@{ExecutablePath=(Join-Path $testRoot 'Other\LanPower.CodexHost.exe'); ProcessId=102}
) }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) $script:stopped += $Id }
try {
    New-Item -ItemType Directory -Path (Join-Path $testRoot 'CodexHost') -Force | Out-Null
    $exe = Join-Path $testRoot 'CodexHost\LanPower.CodexHost.exe'
    [IO.File]::WriteAllBytes($exe, [byte[]]@())
    $helper = Join-Path $testRoot 'codex-startup.ps1'
    [IO.File]::WriteAllText($helper, [IO.File]::ReadAllText((Join-Path $installerRoot 'codex-startup.ps1'), [Text.Encoding]::UTF8), [Text.UTF8Encoding]::new($true))
    $arguments = @{AppDir=$testRoot; TaskName='LanPower Startup Unit Test'}
    . $helper @arguments
    Assert-Startup ($script:registered.Action.Execute -eq $exe -and $script:started) 'Register must start the installed Host without a desktop UI.'
    Assert-Startup ($script:registered.Principal.LogonType -eq 'Group' -and $script:registered.Principal.GroupId -eq 'INTERACTIVE' -and $script:registered.Principal.RunLevel -eq 'Limited') 'Host must use a limited interactive user token.'
    Assert-Startup ($script:registered.Trigger.Count -eq 2 -and $script:registered.Trigger[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') 'A Windows logon trigger is required.'
    $repeat = $script:registered.Trigger[1].Repetition
    Assert-Startup ($repeat.Interval -eq 'PT1M' -and -not $repeat.Duration) 'Recovery must repeat each minute indefinitely.'
    $settings = $script:registered.Settings
    Assert-Startup ($settings.MultipleInstances -eq 'IgnoreNew' -and $settings.ExecutionTimeLimit -eq 'PT0S' -and -not $settings.DisallowStartIfOnBatteries -and -not $settings.StopIfGoingOnBatteries) 'Task must remain available after three days and on battery.'
    $script:task = [pscustomobject]@{Actions=@([pscustomobject]@{Execute=$exe})}
    . $helper @arguments -Mode Pause
    Assert-Startup ($script:disabled -and $script:stopped.Count -eq 1 -and $script:stopped[0] -eq 101) 'Upgrade must pause recovery and stop only this installation.'
    . $helper @arguments -Mode Remove
    Assert-Startup $script:removed 'Uninstall must remove recovery.'
    $script:task = [pscustomobject]@{Actions=@([pscustomobject]@{Execute=(Join-Path $testRoot 'Other\LanPower.CodexHost.exe')})}
    $script:disabled = $false
    $rejected = $false
    try { . $helper @arguments -Mode Pause } catch { $rejected=$true }
    Assert-Startup ($rejected -and -not $script:disabled) 'A task for a different installation must be preserved.'
    Write-Output 'Codex startup checks passed: logon, user identity, recovery, battery, upgrade isolation and uninstall.'
} finally {
    $absolute = [IO.Path]::GetFullPath($testRoot)
    if (-not $absolute.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup path rejected.' }
    Remove-Item -LiteralPath $absolute -Recurse -Force
}
