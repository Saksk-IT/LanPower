param(
    [Parameter(Mandatory = $true)][string]$AppDir,
    [ValidateSet('Register', 'Pause', 'Remove')][string]$Mode = 'Register',
    [string]$TaskName = 'LanPower Codex Remote'
)
$ErrorActionPreference = 'Stop'
$hostExe = [IO.Path]::GetFullPath((Join-Path $AppDir 'CodexHost\LanPower.CodexHost.exe'))
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and (@($task.Actions).Count -ne 1 -or
    [IO.Path]::GetFullPath($task.Actions[0].Execute) -ne $hostExe)) {
    throw '同名 Codex 启动任务属于其他安装目录，已保留，请先检查安装路径。'
}

if ($Mode -eq 'Register') {
    if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) { throw 'Codex Host 程序不存在。' }
    $action = New-ScheduledTaskAction -Execute $hostExe -WorkingDirectory (Split-Path -Parent $hostExe)
    $logon = New-ScheduledTaskTrigger -AtLogOn
    # An unlimited repetition also recovers a Host that exits normally or is terminated.
    $retry = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    # INTERACTIVE is language independent and uses the logged-in user's limited token.
    # No password is saved and Codex never runs as LocalSystem / in session zero.
    $principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-4' -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $retry) `
        -Principal $principal -Settings $settings -Description '登录 Windows 后自动启动 Codex Remote，退出后自动恢复。' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
} else {
    if ($task) {
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
        Stop-ScheduledTask -TaskName $TaskName
        if ($Mode -eq 'Remove') { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    }
    # Pause before copying files; otherwise a repeating trigger could lock the old Host again.
    Get-CimInstance Win32_Process -Filter "Name='LanPower.CodexHost.exe'" |
        Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $hostExe } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Mode -ne 'Pause' -and $TaskName -eq 'LanPower Codex Remote') {
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('CommonStartup')) 'LanPower Codex Host.lnk'
    if (Test-Path -LiteralPath $shortcutPath) {
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
        if ($shortcut.TargetPath -and [IO.Path]::GetFullPath($shortcut.TargetPath) -eq $hostExe) {
            Remove-Item -LiteralPath $shortcutPath -Force
        }
    }
}
