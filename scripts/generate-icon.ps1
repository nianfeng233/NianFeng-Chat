# 念风chat · 本地优先、插件化的 AI 聊天客户端（cordis v4 内核 + Node 本地后端）
# 项目全称：念风 Chat（NianFeng-Chat）
# 仓库：https://github.com/nianfeng233/NianFeng-Chat
param(
  [string]$Source = (Join-Path $PSScriptRoot '..\logo.png'),
  [string]$Destination = (Join-Path $PSScriptRoot 'desktop-wrapper\app.ico'),
  [string]$RgbaDestination = (Join-Path $PSScriptRoot 'desktop-wrapper\app.rgba')
)

Add-Type -AssemblyName System.Drawing

function New-RoundedIconBitmap {
  param(
    [System.Drawing.Image]$SourceImage,
    [int]$Size
  )

  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $radius = [Math]::Max(2, [int]($Size * 0.22))
  $diameter = $radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
  $path.AddArc($Size - $diameter, 0, $diameter, $diameter, 270, 90)
  $path.AddArc($Size - $diameter, $Size - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc(0, $Size - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()

  $graphics.SetClip($path)
  $graphics.FillRectangle([System.Drawing.Brushes]::White, 0, 0, $Size, $Size)
  $graphics.DrawImage($SourceImage, 0, 0, $Size, $Size)

  $graphics.Dispose()
  $path.Dispose()
  return $bitmap
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$sourceImage = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
$pngs = @()

foreach ($size in $sizes) {
  $bitmap = New-RoundedIconBitmap -SourceImage $sourceImage -Size $size
  $stream = [System.IO.MemoryStream]::new()
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  $pngs += ,$stream.ToArray()
  $stream.Dispose()
}

$directory = Split-Path -Parent $Destination
if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force $directory | Out-Null }

$file = [System.IO.File]::Create($Destination)
$writer = [System.IO.BinaryWriter]::new($file)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($index = 0; $index -lt $sizes.Count; $index++) {
  $size = $sizes[$index]
  $dimension = [byte]0
  if ($size -ne 256) { $dimension = [byte]$size }
  $writer.Write($dimension)
  $writer.Write($dimension)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$pngs[$index].Length)
  $writer.Write([UInt32]$offset)
  $offset += $pngs[$index].Length
}
foreach ($png in $pngs) { $writer.Write($png) }
$writer.Flush()
$writer.Close()
$file.Close()

$rgbaSize = 64
$rgbaBitmap = New-RoundedIconBitmap -SourceImage $sourceImage -Size $rgbaSize
$rgba = [byte[]]::new($rgbaSize * $rgbaSize * 4)
$index = 0
for ($y = 0; $y -lt $rgbaSize; $y++) {
  for ($x = 0; $x -lt $rgbaSize; $x++) {
    $color = $rgbaBitmap.GetPixel($x, $y)
    $rgba[$index] = $color.R
    $rgba[$index + 1] = $color.G
    $rgba[$index + 2] = $color.B
    $rgba[$index + 3] = $color.A
    $index += 4
  }
}
$rgbaBitmap.Dispose()
$sourceImage.Dispose()

$rgbaDirectory = Split-Path -Parent $RgbaDestination
if (-not (Test-Path $rgbaDirectory)) { New-Item -ItemType Directory -Force $rgbaDirectory | Out-Null }
[System.IO.File]::WriteAllBytes($RgbaDestination, $rgba)

Write-Output "Icon generated: $Destination"
Write-Output "Window RGBA generated: $RgbaDestination"