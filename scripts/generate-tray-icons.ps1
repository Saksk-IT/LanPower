# Reproducible 16 x 16 status icons; no machine-specific assets.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$trayResourceDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\LanPower.Desktop\Resources'
[IO.Directory]::CreateDirectory($trayResourceDir) | Out-Null
foreach ($entry in @(@('green', '#17865b'), @('yellow', '#d9a620'), @('gray', '#8e9ba5'))) {
    $bitmap = [Drawing.Bitmap]::new(16, 16, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($entry[1]))
    $pen = [Drawing.Pen]::new([Drawing.Color]::White, 1.5)
    $png = [IO.MemoryStream]::new()
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.FillEllipse($brush, 1, 1, 14, 14)
        $graphics.DrawArc($pen, 4.5, 4.5, 7, 7, -45, 270)
        $graphics.DrawLine($pen, 8, 3.5, 8, 7.5)
        $bitmap.Save($png, [Drawing.Imaging.ImageFormat]::Png)
        $bytes = $png.ToArray()
        $file = [IO.File]::Create((Join-Path $trayResourceDir ('tray-' + $entry[0] + '.ico')))
        $writer = [IO.BinaryWriter]::new($file)
        try {
            $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
            $writer.Write([byte]16); $writer.Write([byte]16); $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$bytes.Length); $writer.Write([uint32]22); $writer.Write($bytes)
        } finally { $writer.Dispose(); $file.Dispose() }
    } finally { $png.Dispose(); $pen.Dispose(); $brush.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}
