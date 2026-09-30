$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\install-service.ps1'
$source = [IO.File]::ReadAllText($installer, [Text.Encoding]::UTF8)
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Installer script does not parse.' }
$blocks = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.TryStatementAst] -and
    $node.Body.Extent.Text.Contains('Start-Service -Name $serviceName')
}, $true))
if ($blocks.Count -ne 1) { throw 'Cannot locate the service registration and startup block.' }
$startup = [ScriptBlock]::Create($blocks[0].Extent.Text)
$traps = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.TrapStatementAst] }, $true))
if ($traps.Count -ne 1) { throw 'Cannot locate the installer failure trap.' }
$earlyFailure = [ScriptBlock]::Create($traps[0].Extent.Text + "`nthrow 'original install failure'")

# Every service, firewall and task operation in the extracted production block is
# mocked. This test never executes the rest of the installation script.
function Get-ScheduledTask { param($TaskName, $ErrorAction) return [pscustomobject]@{ TaskName = $TaskName } }
function Stop-ScheduledTask { param($TaskName, $ErrorAction) $script:stoppedTask++ }
function Start-ScheduledTask { param($TaskName, $ErrorAction) $script:restoredTask++ }
function Unregister-ScheduledTask { param($TaskName, $Confirm) $script:removedTask++ }
function Start-Sleep { param($Seconds, $Milliseconds) }
function Get-NetFirewallRule { param($DisplayName, $ErrorAction) }
function Remove-NetFirewallRule { param($ErrorAction) }
function New-NetFirewallRule {
    param($DisplayName, $Direction, $Action, $Protocol, $LocalPort, $LocalAddress, $RemoteAddress, $Program, $Profile)
    if ($script:mode -eq 'firewall failure') { throw 'original install failure' }
}
function New-Service {
    param($Name, $DisplayName, $BinaryPathName, $StartupType, $Description)
    if ($script:mode -eq 'registration failure') { throw 'original install failure' }
    $script:createdService++
}
function Get-CimInstance {
    param($ClassName, $Filter)
    $account = if ($script:mode -eq 'account failure') { 'test-user' } else { 'LocalSystem' }
    return [pscustomobject]@{ StartName = $account }
}
function Invoke-CimMethod { param($InputObject, $MethodName, $Arguments) return [pscustomobject]@{ ReturnValue = 0 } }
function Start-Service {
    param($Name)
    if ($script:mode -in @('start failure', 'cleanup failure')) { throw 'original install failure' }
}
function Get-Service {
    param($Name, $ErrorAction)
    $status = if ($script:mode -eq 'early exit') { 'Stopped' } else { 'Running' }
    return [pscustomobject]@{ Status = $status }
}
function Stop-Service {
    param($Name, [switch]$Force, $ErrorAction)
    $script:stoppedService++
    if ($script:mode -eq 'cleanup failure') { throw 'secondary cleanup failure' }
}
function sc.exe {
    param($Operation, $Name)
    if ($Operation -ne 'delete' -or $Name -ne 'LanPowerService') { throw 'Unexpected service command' }
    $script:deletedService++
}
function Test-LanPowerServiceHealth { param($Port, $Token) return $true }
function Write-LanPowerInstallFailure {
    param($Stage, $Failure, $ResultPath, $LogPath)
    $script:reported++
    $script:reportedBeforeStop = $script:stoppedService -eq 0
    if ($script:mode -eq 'cleanup failure') { throw 'secondary diagnostic failure' }
}
function Assert-Recovery($condition, [string]$message) {
    if (-not $condition) { throw $message }
    Write-Output "PASS: $message"
}
foreach ($case in @(
    @{ Mode = 'success'; Existing = $false },
    @{ Mode = 'start failure'; Existing = $false },
    @{ Mode = 'account failure'; Existing = $false },
    @{ Mode = 'early exit'; Existing = $false },
    @{ Mode = 'registration failure'; Existing = $false },
    @{ Mode = 'firewall failure'; Existing = $false },
    @{ Mode = 'cleanup failure'; Existing = $false },
    @{ Mode = 'start failure'; Existing = $true }
)) {
    $script:mode = $case.Mode
    $script:createdService = $script:deletedService = $script:stoppedService = 0
    $script:stoppedTask = $script:restoredTask = $script:removedTask = $script:reported = 0
    $serviceCreated = $false
    $failureReported = $false
    $service = if ($case.Existing) { [pscustomobject]@{ Status = 'Stopped' } } else { $null }
    $selected = [pscustomobject]@{ Address = '192.168.50.20'; Subnet = '192.168.50.0/24' }
    $serviceName = 'LanPowerService'
    $serviceExe = 'test-service.exe'
    $configPath = 'test-config.json'
    $config = @{ port = 48211 }
    $token = 'a' * 64
    $resultPath = $installLog = ''
    $caught = $null
    try { . $startup } catch { $caught = $_ }
    $label = $case.Mode + ', existing=' + $case.Existing
    if ($case.Mode -eq 'success') {
        Assert-Recovery ($null -eq $caught -and $script:removedTask -eq 1 -and $script:deletedService -eq 0 -and $script:reported -eq 0) ($label + ': legacy task removed only after success')
    } else {
        Assert-Recovery ($null -ne $caught -and $script:restoredTask -eq 1 -and $script:removedTask -eq 0) ($label + ': failure propagates and legacy task restarts')
        Assert-Recovery ($script:reported -eq 1 -and $script:reportedBeforeStop -and $failureReported) ($label + ': diagnostic captured before cleanup')
        Assert-Recovery ($script:deletedService -eq $script:createdService) ($label + ': only a service created by this attempt is deleted')
        if ($case.Mode -eq 'cleanup failure') {
            Assert-Recovery ($caught.Exception.Message -eq 'original install failure') 'Secondary cleanup and diagnostic failures do not mask the original error'
        }
    }
}
$failureReported = $false
$script:mode = 'cleanup failure'
$caught = $null
try { & $earlyFailure } catch { $caught = $_ }
Assert-Recovery ($caught.Exception.Message -eq 'original install failure') 'Early failure trap preserves the original error even if reporting fails'
