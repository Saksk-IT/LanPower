# Windows 原生图标：与 Assets/LanPower.svg 使用相同的形状和颜色。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\LanPower.Desktop\Assets'
function New-RoundedPath([single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
    $path = [Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $radius * 2
    $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
    $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
    $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return ,$path
}
$images = @()
foreach ($size in @(16, 20, 24, 32, 48, 64, 128, 256)) {
    $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform($size / 128.0, $size / 128.0)
    $navy = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#153441'))
    $mint = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#64d6bd'))
    $pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#eafff7'), 7)
    $pen.StartCap = $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
    try {
        foreach ($shape in @(@(2, 2, 124, 124, 28), @(22, 25, 84, 62, 9), @(29, 32, 70, 48, 4))) {
            $path = New-RoundedPath @shape
            try { $graphics.FillPath($(if ($shape[0] -eq 22) { $mint } else { $navy }), $path) }
            finally { $path.Dispose() }
        }
        $graphics.DrawArc($pen, 45, 42, 38, 38, -47, 274)
        $graphics.DrawLine($pen, 64, 40, 64, 57)
        $graphics.FillRectangle($mint, 58, 87, 12, 10)
        $graphics.FillRectangle($mint, 43, 100, 42, 7)
        $stream = [IO.MemoryStream]::new()
        try {
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $images += [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
            if ($size -eq 256) { [IO.File]::WriteAllBytes((Join-Path $assetDir 'LanPower.png'), $stream.ToArray()) }
        } finally { $stream.Dispose() }
    } finally {
        $pen.Dispose(); $mint.Dispose(); $navy.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
}
$output = [IO.File]::Create((Join-Path $assetDir 'LanPower.ico'))
$writer = [IO.BinaryWriter]::new($output)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($entry in $images) {
        $dimension = if ($entry.Size -eq 256) { 0 } else { $entry.Size }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$entry.Bytes.Length); $writer.Write([uint32]$offset)
        $offset += $entry.Bytes.Length
    }
    foreach ($entry in $images) { $writer.Write([byte[]]$entry.Bytes) }
} finally { $writer.Dispose(); $output.Dispose() }
Write-Host '已生成 16–256 像素的 LanPower 应用图标。'
