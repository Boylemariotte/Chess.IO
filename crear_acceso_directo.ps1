# Crea (o recrea) el acceso directo "Ajedrez" en el escritorio, con icono.
# Ejecuta:  click derecho > "Ejecutar con PowerShell"
#   o:      powershell -ExecutionPolicy Bypass -File crear_acceso_directo.ps1

$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$icoPath = Join-Path $proj "ajedrez.ico"

# Generar el icono si no existe.
if (-not (Test-Path $icoPath)) {
  Add-Type -AssemblyName System.Drawing
  $size = 64
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.TextRenderingHint = "AntiAliasGridFit"
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(43,47,54))), 0, 0, $size, $size)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(74,144,217))), 0, 0, $size, 8)
  $font = New-Object System.Drawing.Font("Segoe UI Symbol", 40)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = "Center"; $fmt.LineAlignment = "Center"
  $g.DrawString([char]0x265F, $font, [System.Drawing.Brushes]::White,
    (New-Object System.Drawing.RectangleF(0, 4, $size, $size)), $fmt)
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $fs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
  $icon.Save($fs); $fs.Close(); $bmp.Dispose()
}

$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "Ajedrez.lnk"
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = Join-Path $proj "Iniciar.bat"
$sc.WorkingDirectory = $proj
$sc.IconLocation = "$icoPath,0"
$sc.Description = "Analizador y juego de ajedrez"
$sc.WindowStyle = 1
$sc.Save()
Write-Host "Listo: acceso directo 'Ajedrez' creado en el escritorio." -ForegroundColor Green
