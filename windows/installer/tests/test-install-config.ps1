$ErrorActionPreference = 'Stop'
# Execute the actual installer assignments, without service or firewall changes.
$installer = Join-Path $PSScriptRoot '..\install-service.ps1'
$tokens = $null
$parseErrors = $null
$source = [IO.File]::ReadAllText($installer, [Text.Encoding]::UTF8)
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer script does not parse.' }
$assignments = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
    $node.Left.VariablePath.UserPath -in @('networks', 'config')
}, $true) | Sort-Object { $_.Extent.StartOffset })
if ($assignments.Count -ne 2) { throw 'Cannot locate installer config assignments.' }
$build = [ScriptBlock]::Create(($assignments | ForEach-Object { $_.Extent.Text }) -join "`n")
$cases = @(
    @{ Name = 'single connected subnet'; Selected = @{ Subnet = '192.168.50.0/24'; AdapterId = 'test' }; Old = $null; Expected = @('192.168.50.0/24') },
    @{ Name = 'offline existing networks'; Selected = $null; Old = @{ allowed_networks = @('192.168.50.0/24', '10.0.0.0/24') }; Expected = @('192.168.50.0/24', '10.0.0.0/24') },
    @{ Name = 'offline fresh install'; Selected = $null; Old = $null; Expected = @('127.0.0.0/8') }
)
foreach ($case in $cases) {
    $selected = $case.Selected
    $old = $case.Old
    $token = 'a' * 64
    $address = '127.0.0.1'
    $automatic = $true
    $preferred = ''
    . $build
    $serialized = $config | ConvertTo-Json -Depth 4
    $decoded = $serialized | ConvertFrom-Json
    if ($decoded.allowed_networks -isnot [array] -or
        ($decoded.allowed_networks -join ',') -ne ($case.Expected -join ',')) {
        throw ($case.Name + ': allowed_networks must remain a JSON array.')
    }
}
Write-Output 'PASS: installer config preserves network arrays in Windows PowerShell.'
