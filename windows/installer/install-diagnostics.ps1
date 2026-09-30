# Compatible with Windows PowerShell 5.1. Do not log configuration or exception messages.
function Test-LanPowerServiceHealth {
    param([int]$Port, [string]$Token)
    $response = $null
    $reader = $null
    try {
        $request = [Net.HttpWebRequest]::CreateHttp("http://127.0.0.1:$Port/api/status")
        # Installation runs as an administrator, whose Internet proxy may differ
        # from the LocalSystem service. Loopback must always use a direct request.
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.KeepAlive = $false
        $request.Timeout = 1500
        $request.ReadWriteTimeout = 1500
        $request.Headers['Authorization'] = 'Bearer ' + $Token
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200) { return $false }
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        $buffer = New-Object char[] 4097
        $length = $reader.ReadBlock($buffer, 0, $buffer.Length)
        if ($length -eq 0 -or $length -gt 4096) { return $false }
        $status = (-join $buffer[0..($length - 1)]) | ConvertFrom-Json -ErrorAction Stop
        return $status.ok -is [bool] -and $status.ok -and $status.state -ceq 'online'
    } catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [Net.WebException] -and $cause.Response) {
            $cause.Response.Dispose()
        }
        return $false
    }
    finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Get-LanPowerInstallFailure {
    param([string]$Stage, [Management.Automation.ErrorRecord]$Failure)
    $lines = @(
        'LanPower Service 安装失败'
        ('时间：' + [DateTimeOffset]::Now.ToString('O'))
        ('阶段：' + $Stage)
        ('Windows：' + [Environment]::OSVersion.Version + '；PowerShell：' + $PSVersionTable.PSVersion)
        ('脚本行号：' + $Failure.InvocationInfo.ScriptLineNumber)
    )
    $cause = $Failure.Exception
    for ($index = 0; $cause -and $index -lt 6; $index++) {
        $code = $cause.GetType().Name + (' [0x{0:X8}]' -f $cause.HResult)
        if ($cause -is [ComponentModel.Win32Exception]) { $code += ' Win32=' + $cause.NativeErrorCode }
        $lines += '错误：' + $code
        $cause = $cause.InnerException
    }
    try {
        $installed = Get-CimInstance Win32_Service -Filter "Name = 'LanPowerService'" -ErrorAction Stop
        if ($installed) {
            $lines += ('服务：{0}；Win32ExitCode={1}；ServiceSpecificExitCode={2}' -f
                $installed.State, $installed.ExitCode, $installed.ServiceSpecificExitCode)
        } else { $lines += '服务：尚未注册' }
    } catch { $lines += '服务：无法读取状态' }
    $lines += switch ($Stage) {
        '读取原配对配置' { '建议：保留并备份原配置，请勿通过删除配对数据反复重试。' }
        '设置 Windows 防火墙' { '建议：检查 Windows 防火墙服务、组织策略或安全软件的拦截记录。' }
        '选择局域网网卡' { '建议：检查网卡驱动及 Windows 网络管理组件。' }
        '启动 Windows 服务' { '建议：检查 Windows 事件查看器中的服务启动错误、端口占用和安全软件拦截记录。' }
        '验证本机服务接口' { '建议：检查服务是否退出、48211 端口冲突及服务日志。' }
        default { '建议：保留此诊断信息，并检查安装权限及安全软件拦截记录。' }
    }
    return $lines -join [Environment]::NewLine
}

function Write-LanPowerInstallFailure {
    param([string]$Stage, [Management.Automation.ErrorRecord]$Failure, [string]$ResultPath, [string]$LogPath)
    $report = Get-LanPowerInstallFailure -Stage $Stage -Failure $Failure
    if ($LogPath) {
        try {
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($LogPath)) | Out-Null
            [IO.File]::AppendAllText($LogPath, $report + [Environment]::NewLine + [Environment]::NewLine,
                [Text.UTF8Encoding]::new($true))
            $report += [Environment]::NewLine + '诊断日志：' + $LogPath
        } catch { $report += [Environment]::NewLine + '诊断日志无法写入，请保留本次弹窗内容。' }
    }
    if ($ResultPath) {
        try { [IO.File]::WriteAllText($ResultPath, $report, [Text.UTF8Encoding]::new($true)) }
        catch { } # Preserve the original installation error even if diagnostic output is unavailable.
    }
}
