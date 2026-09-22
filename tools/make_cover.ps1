# 把出图结果压成番茄要求的书封文件：600×800、jpg/png、≤5MB
# （make_cover.py 的 PowerShell 等价实现，供没有 Python 的 Windows 环境使用）。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File make_cover.ps1 covers\原图.png -Out "covers\书名-封面.jpg"
#   powershell -ExecutionPolicy Bypass -File make_cover.ps1 covers\原图.png -Out covers\封面.png -Format png
#
# 用 Windows 自带的 System.Drawing，不需要装任何东西。
# 建议用 Windows PowerShell 5.1 运行（开始菜单搜索 “Windows PowerShell”）。

[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Position = 0)]
    [string]$Source,
    [string]$Out,
    [string]$Size = '600x800',
    [ValidateSet('jpg', 'png')]
    [string]$Format = 'jpg'
)

$ErrorActionPreference = 'Stop'
$MaxBytes = 5 * 1024 * 1024

function Resolve-FullPath([string]$path) {
    if ([System.IO.Path]::IsPathRooted($path)) { return [System.IO.Path]::GetFullPath($path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $path))
}

function ConvertFrom-SizeText([string]$text) {
    $parts = $text.ToLower().Split('x')
    if ($parts.Length -ne 2) { throw "尺寸格式应为 宽x高，例如 600x800，收到的是 $text" }
    return [pscustomobject]@{ Width = [int]$parts[0]; Height = [int]$parts[1] }
}

function Get-CropRect([int]$srcW, [int]$srcH, [int]$targetW, [int]$targetH) {
    # 按目标比例居中裁剪，避免拉伸变形；比例已经一致时原样返回
    if ($srcW * $targetH -eq $srcH * $targetW) {
        return [pscustomobject]@{ X = 0; Y = 0; Width = $srcW; Height = $srcH }
    }
    if ($srcW * $targetH -gt $srcH * $targetW) {
        $newW = [int][math]::Round($srcH * $targetW / $targetH)
        return [pscustomobject]@{ X = [int][math]::Floor(($srcW - $newW) / 2); Y = 0; Width = $newW; Height = $srcH }
    }
    $newH = [int][math]::Round($srcW * $targetH / $targetW)
    return [pscustomobject]@{ X = 0; Y = [int][math]::Floor(($srcH - $newH) / 2); Width = $srcW; Height = $newH }
}

# 被 . 点源加载时只导入函数，方便单独测试上面的裁剪计算
if ($MyInvocation.InvocationName -eq '.') { return }

# 不用 Mandatory：参数缺失时应当打印用法并退出，而不是挂在那里等交互输入
if (-not $Source -or -not $Out) {
    Write-Host '用法: make_cover.ps1 原图 -Out 输出文件 [-Size 600x800] [-Format jpg|png]'
    exit 2
}

$srcFull = Resolve-FullPath $Source
if (-not (Test-Path -LiteralPath $srcFull)) {
    Write-Host "找不到原图：$Source"
    exit 1
}
$outFull = Resolve-FullPath $Out
$outDir = Split-Path -Parent $outFull
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

try {
    Add-Type -AssemblyName System.Drawing
} catch {
    Write-Host '这个 PowerShell 加载不了 System.Drawing。'
    Write-Host '请改用 Windows PowerShell 5.1 运行（开始菜单搜索 “Windows PowerShell”），'
    Write-Host '或用任意图片工具把原图导出为 600×800 的 jpg（≤5MB）。'
    exit 1
}

$size = ConvertFrom-SizeText $Size
$img = [System.Drawing.Image]::FromFile($srcFull)
try {
    $crop = Get-CropRect $img.Width $img.Height $size.Width $size.Height
    $srcRect = New-Object System.Drawing.Rectangle($crop.X, $crop.Y, $crop.Width, $crop.Height)
    $dstRect = New-Object System.Drawing.Rectangle(0, 0, $size.Width, $size.Height)

    $bmp = New-Object System.Drawing.Bitmap($size.Width, $size.Height)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            # jpg 没有透明通道，先铺白底，否则 png 的透明区会变成黑块
            if ($Format -eq 'jpg') { $g.Clear([System.Drawing.Color]::White) }
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        } finally {
            $g.Dispose()
        }

        if ($Format -eq 'jpg') {
            $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
            $how = ''
            foreach ($quality in 92, 85, 78, 70, 60) {
                $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
                try {
                    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
                        [System.Drawing.Imaging.Encoder]::Quality, [int64]$quality)
                    $bmp.Save($outFull, $codec, $ep)
                } finally {
                    $ep.Dispose()
                }
                $how = "System.Drawing，JPEG 质量 $quality"
                if ((Get-Item -LiteralPath $outFull).Length -le $MaxBytes) { break }
            }
        } else {
            $bmp.Save($outFull, [System.Drawing.Imaging.ImageFormat]::Png)
            $how = 'System.Drawing，PNG'
        }
    } finally {
        $bmp.Dispose()
    }
} finally {
    $img.Dispose()
}

$bytes = (Get-Item -LiteralPath $outFull).Length
$mb = [math]::Round($bytes / 1MB, 2)
Write-Host "已生成 $Out（$($size.Width)×$($size.Height)，$mb MB，$how）"
if ($bytes -gt $MaxBytes) {
    Write-Host '文件仍超过 5MB，请降低质量或改用 jpg 格式重试'
    exit 1
}
exit 0
