# 把正文整理成番茄可直接上传的 txt（export_fanqie_txt.py 的 PowerShell 等价实现，
# 供没有 Python 的 Windows 环境使用，兼容 Windows PowerShell 5.1 和 PowerShell 7）。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File export_fanqie_txt.ps1 -Book "书名" 正文目录\
#   powershell -ExecutionPolicy Bypass -File export_fanqie_txt.ps1 -Book "书名" -Out fanqie 第1章.md 第2章.md
#   powershell -ExecutionPolicy Bypass -File export_fanqie_txt.ps1 -Book "书名" -Check 正文目录\
#
# 参数与 Python 版一一对应:
#   -Book / -Out / -Mode both|single|split / -NumberStyle arabic|chinese|keep
#   -Pad / -Encoding utf-8|gbk / -Check
#
# 做的事与不做的事，见 export_fanqie_txt.py 头部注释。

[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Book,
    [string]$Out = 'fanqie',
    [ValidateSet('both', 'single', 'split')]
    [string]$Mode = 'both',
    [ValidateSet('arabic', 'chinese', 'keep')]
    [string]$NumberStyle = 'arabic',
    [switch]$Pad,
    [string]$Encoding = 'utf-8',
    [switch]$Check,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Inputs
)

$ErrorActionPreference = 'Stop'

# 点源会把被加载脚本的 param 变量带进本作用域：fix_punctuation.ps1 里的
# [string[]]$Files 会给同名变量加上类型约束，$Check 会覆盖本脚本的开关。
# 所以先把要用的参数存成不冲突的名字，再点源。
$checkOnly = $Check.IsPresent
$padNames = $Pad.IsPresent

# 复用同目录的标点修复脚本，只取函数不跑它的命令行流程
. (Join-Path $PSScriptRoot 'fix_punctuation.ps1')

# ---------- Markdown / 空白清理 ----------

$MdFrontmatterRe = [regex]'(?s)\A---\n.*?\n(?:---|\.\.\.)\n'
$MdFenceRe = [regex]'^\s*(?:```|~~~)'
$MdHrRe = [regex]'^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$'
$MdHeadingRe = [regex]'^\s{0,3}(#{1,6})\s*'
$MdQuoteRe = [regex]'^\s{0,3}>+\s?'
$MdListRe = [regex]'^\s{0,3}(?:[-*+•·]\s+|\d{1,3}[.)]\s+)'
$MdImageRe = [regex]'!\[[^\]]*\]\([^)]*\)'
$MdLinkRe = [regex]'\[([^\]]*)\]\([^)]*\)'
$MdCodeRe = [regex]'`+\s*([^`]*?)\s*`+'
$MdStrikeRe = [regex]'~~(.+?)~~'
$MdEmphRe = [regex]'(\*{1,3}|_{1,3})(?=\S)(.+?)(?<=\S)\1'
$MdZeroWidthRe = [regex]'[​-‏‪-‮﻿]'
$MdIndentRe = [regex]'^\s+'
$MdSpaceRe = [regex]'\s'

# 键是要查的字符，值是说明；反引号和直引号用码点构造，避免字符串定界冲突
$ResidualMarks = [ordered]@{
    '*'             = '星号（加粗/斜体残留）'
    '#'             = '井号（标题残留）'
    ([char]0x60)    = '反引号（代码残留）'
    '~'             = '波浪号（删除线残留）'
    ([char]0x22)    = '半角双引号'
    ([char]0x27)    = '半角单引号'
}

function Clear-InlineMarkdown([string]$line) {
    $line = $MdImageRe.Replace($line, '')
    $line = $MdLinkRe.Replace($line, '$1')
    $line = $MdCodeRe.Replace($line, '$1')
    $line = $MdStrikeRe.Replace($line, '$1')
    $prev = $null
    while ($prev -cne $line) {
        $prev = $line
        $line = $MdEmphRe.Replace($line, '$2')
    }
    return $line
}

function Clear-ManuscriptText([string]$text, $stats) {
    # 清 Markdown 与不可见字符，再逐行修标点。返回 [{IsHeading, Text}, ...]。
    # 顺序很重要：Markdown 必须先清干净再修标点，否则 **"对话"** 里的星号
    # 会让开引号被判成右引号。
    $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
    $text = $MdFrontmatterRe.Replace($text, '', 1)
    $text = $MdZeroWidthRe.Replace($text, '')

    $out = New-Object System.Collections.Generic.List[object]
    $inFence = $false
    foreach ($raw in $text.Split("`n")) {
        if ($MdFenceRe.IsMatch($raw)) {
            $inFence = -not $inFence
            continue
        }
        if ($MdHrRe.IsMatch($raw)) {
            Add-Stat $stats '分节符删除'
            continue
        }
        $isHeading = $false
        $line = $raw
        if (-not $inFence) {
            $isHeading = $MdHeadingRe.IsMatch($raw)
            if ($isHeading) { $line = $MdHeadingRe.Replace($raw, '', 1) }
            $line = $MdQuoteRe.Replace($line, '', 1)
            $line = $MdListRe.Replace($line, '', 1)
            $line = Clear-InlineMarkdown $line
        }
        $line = $line.Replace("`t", ' ').Replace([char]0x00A0, ' ')
        $line = $MdIndentRe.Replace($line, '', 1).TrimEnd()
        $line = Convert-Text $line $false $stats
        $out.Add([pscustomobject]@{ IsHeading = $isHeading; Text = $line })
    }
    return , $out
}

# ---------- 章节识别 ----------

$CnDigits = @{ '零' = 0; '〇' = 0; '一' = 1; '二' = 2; '两' = 2; '三' = 3; '四' = 4;
    '五' = 5; '六' = 6; '七' = 7; '八' = 8; '九' = 9
}
$CnUnits = @{ '十' = 10; '百' = 100; '千' = 1000 }

$ChapterRe = [regex]'^第\s*([0-9０-９零〇一二三四五六七八九十百千两]+)\s*([章回节话])\s*[:：.．、·~～\-—─_]*\s*(.*)$'
$SpecialRe = [regex]'^(楔子|序章|序言|序幕|序|引子|前言|尾声|终章|结局|后记|番外[^\s]{0,20})\s*[:：.．、·~～\-—─_]*\s*(.*)$'
$MaxTitleLen = 50

function ConvertFrom-CnNumber([string]$s) {
    $s = $s.Trim().Normalize([System.Text.NormalizationForm]::FormKC)
    if ($s -match '^\d+$') { return [int]$s }
    $total = 0
    $section = 0
    foreach ($c in $s.ToCharArray()) {
        $k = $c.ToString()
        if ($CnDigits.ContainsKey($k)) {
            $section = $CnDigits[$k]
        } elseif ($CnUnits.ContainsKey($k)) {
            $unit = $CnUnits[$k]
            if ($section -eq 0) { $section = 1 }
            if ($unit -eq 10) { $total += $section * 10 } else { $total += $section * $unit }
            $section = 0
        } else {
            return $null
        }
    }
    return $total + $section
}

$IntUnits = @('', '十', '百', '千')
$IntDigits = '零一二三四五六七八九'

function ConvertTo-CnNumber([int]$n) {
    if ($n -le 0 -or $n -gt 9999) { return "$n" }
    if ($n -lt 10) { return $IntDigits[$n].ToString() }
    if ($n -lt 20) {
        $r = $n % 10
        if ($r) { return '十' + $IntDigits[$r].ToString() }
        return '十'
    }
    $digits = "$n"
    $parts = New-Object System.Collections.Generic.List[string]
    $zero = $false
    for ($i = 0; $i -lt $digits.Length; $i++) {
        $d = [int]::Parse($digits[$i].ToString())
        $unit = $IntUnits[$digits.Length - 1 - $i]
        if ($d -eq 0) { $zero = $true; continue }
        if ($zero -and $parts.Count) { $parts.Add('零') }
        $zero = $false
        $parts.Add($IntDigits[$d].ToString() + $unit)
    }
    return -join $parts
}

function Get-ChapterInfo([bool]$isHeading, [string]$line) {
    # 返回 {Number, Name, Unit, Raw}；不是章节标题则返回 $null
    $s = $line.Trim()
    if (-not $s -or $s.Length -gt $MaxTitleLen) { return $null }
    $m = $ChapterRe.Match($s)
    if ($m.Success) {
        return [pscustomobject]@{
            Number = (ConvertFrom-CnNumber $m.Groups[1].Value)
            Name   = $m.Groups[3].Value.Trim()
            Unit   = $m.Groups[2].Value
            Raw    = $s
        }
    }
    $m = $SpecialRe.Match($s)
    if ($m.Success) {
        $name = $m.Groups[1].Value
        $rest = $m.Groups[2].Value.Trim()
        if ($rest) { $name = "$name $rest" }
        return [pscustomobject]@{ Number = $null; Name = $name; Unit = ''; Raw = $s }
    }
    if ($isHeading) {
        return [pscustomobject]@{ Number = $null; Name = $s; Unit = ''; Raw = $s }
    }
    return $null
}

function Format-ChapterTitle($chapter, [string]$style) {
    if ($style -eq 'keep') { return $chapter.Raw }
    if ($null -eq $chapter.Number) { return $chapter.Name }
    if ($style -eq 'chinese') { $num = ConvertTo-CnNumber $chapter.Number } else { $num = "$($chapter.Number)" }
    $unit = $chapter.Unit
    if (-not $unit) { $unit = '章' }
    return ("第$num$unit $($chapter.Name)").TrimEnd()
}

# ---------- 切分 ----------

function New-Chapter($number, [string]$name, [string]$unit, $source, [string]$raw) {
    return [pscustomobject]@{
        Number     = $number
        Name       = $name
        Unit       = $unit
        Source     = $source
        Raw        = $raw
        Paragraphs = (New-Object System.Collections.Generic.List[string])
    }
}

function Get-ChapterWordCount($chapter) {
    $n = 0
    foreach ($p in $chapter.Paragraphs) { $n += $MdSpaceRe.Replace($p, '').Length }
    return $n
}

function Split-Chapters($lines, $source, [string]$fallbackTitle) {
    $chapters = New-Object System.Collections.Generic.List[object]
    $current = $null
    $preface = New-Object System.Collections.Generic.List[string]
    foreach ($item in $lines) {
        $hit = Get-ChapterInfo $item.IsHeading $item.Text
        if ($null -ne $hit) {
            $current = New-Chapter $hit.Number $hit.Name $hit.Unit $source $hit.Raw
            $chapters.Add($current)
            continue
        }
        $content = $item.Text.Trim()
        if (-not $content) { continue }
        if ($null -eq $current) { $preface.Add($content) } else { $current.Paragraphs.Add($content) }
    }
    if ($preface.Count) {
        $head = New-Chapter $null $fallbackTitle '' $source $fallbackTitle
        foreach ($p in $preface) { $head.Paragraphs.Add($p) }
        $chapters.Insert(0, $head)
    }
    return , $chapters
}

# ---------- 输出 ----------

$InvalidNameRe = [regex]'[\\/:*?"<>|\n\r\t]'

function Get-SafeFileName([string]$name) {
    $n = $InvalidNameRe.Replace($name, '_').Trim().Trim('.')
    if ($n.Length -gt 80) { $n = $n.Substring(0, 80) }
    if (-not $n) { $n = '未命名' }
    return $n
}

function Get-ChapterText([string]$title, $chapter) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add($title)
    foreach ($p in $chapter.Paragraphs) { $lines.Add($p) }
    return (($lines -join "`n") + "`n")
}

function Resolve-TextEncoding([string]$name) {
    if ($name -in @('utf-8', 'utf8', 'UTF-8', 'UTF8')) {
        return (New-Object System.Text.UTF8Encoding($false))
    }
    try {
        return [System.Text.Encoding]::GetEncoding($name)
    } catch {
        # PowerShell 7（.NET Core）默认不带 GBK 等中文代码页，需要先注册
        [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
        return [System.Text.Encoding]::GetEncoding($name)
    }
}

function Resolve-FullPath([string]$path) {
    if ([System.IO.Path]::IsPathRooted($path)) { return [System.IO.Path]::GetFullPath($path) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $path))
}

function Write-TextFile([string]$path, [string]$text, $enc) {
    $full = Resolve-FullPath $path
    $dir = Split-Path -Parent $full
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($full, $text, $enc)
}

function Read-SourceText([string]$path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $strict = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        $text = $strict.GetString($bytes)
        if ($text.Length -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        return $text
    } catch {
        return (Resolve-TextEncoding 'gbk').GetString($bytes)
    }
}

# ---------- 自检 ----------

function Test-Chapters($chapters, $titles) {
    $problems = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    $prev = $null
    for ($i = 0; $i -lt $chapters.Count; $i++) {
        $ch = $chapters[$i]
        $idx = $i + 1
        $wc = Get-ChapterWordCount $ch
        $label = "[$idx] $($titles[$i])（$($ch.Source.Name)）"
        if ($ch.Paragraphs.Count -eq 0) {
            $problems.Add("${label}：空章，没有正文")
        } elseif ($wc -lt 500) {
            $problems.Add("${label}：仅 $wc 字，番茄读者习惯 2000–4000 字/章，建议合并或扩写")
        } elseif ($wc -gt 10000) {
            $problems.Add("${label}：$wc 字，单章过长，建议拆分")
        }
        if ($null -ne $ch.Number) {
            if ($seen.ContainsKey($ch.Number)) {
                $problems.Add("${label}：章节号与 [$($seen[$ch.Number])] 重复")
            } else {
                $seen[$ch.Number] = $idx
            }
            if ($null -ne $prev -and $ch.Number -ne $prev + 1) {
                $problems.Add("${label}：章节号不连续（上一章为第 $prev 章）")
            }
            $prev = $ch.Number
        }
        if (-not $ch.Name -and $null -ne $ch.Number) {
            $problems.Add("${label}：只有章节号，没有章节名")
        }
        $body = $ch.Paragraphs -join "`n"
        foreach ($mark in $ResidualMarks.Keys) {
            if ($body.IndexOf($mark) -ge 0) {
                $problems.Add("${label}：正文残留 $($ResidualMarks[$mark]) $mark")
            }
        }
    }
    return , $problems
}

# ---------- 主流程 ----------

if (-not $Book -or -not $Inputs) {
    Write-Host '用法: export_fanqie_txt.ps1 -Book "书名" [-Out 目录] [-Mode both|single|split] [-Check] 正文文件或目录...'
    exit 2
}

$sourceFiles = New-Object System.Collections.Generic.List[object]
foreach ($item in $Inputs) {
    if (Test-Path -LiteralPath $item -PathType Container) {
        $found = Get-ChildItem -LiteralPath $item -Recurse -File |
            Where-Object { $_.Extension -eq '.md' -or $_.Extension -eq '.txt' } |
            Sort-Object FullName
        foreach ($f in $found) { $sourceFiles.Add($f) }
    } elseif (Test-Path -LiteralPath $item -PathType Leaf) {
        $sourceFiles.Add((Get-Item -LiteralPath $item))
    } else {
        Write-Host "跳过：找不到 $item"
    }
}
if ($sourceFiles.Count -eq 0) {
    Write-Host '没有可处理的文件'
    exit 1
}

$chapters = New-Object System.Collections.Generic.List[object]
$stats = @{}
foreach ($f in $sourceFiles) {
    $text = Read-SourceText $f.FullName
    $lines = Clear-ManuscriptText $text $stats
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
    foreach ($c in (Split-Chapters $lines $f $stem)) { $chapters.Add($c) }
}

if ($chapters.Count -eq 0) {
    Write-Host '没有识别到任何章节，请检查章节标题格式（如「第1章 标题」）'
    exit 1
}

$titles = New-Object System.Collections.Generic.List[string]
$totalWords = 0
foreach ($c in $chapters) {
    $titles.Add((Format-ChapterTitle $c $NumberStyle))
    $totalWords += Get-ChapterWordCount $c
}

Write-Host "源文件 $($sourceFiles.Count) 个，识别章节 $($chapters.Count) 章，总字数 $totalWords"
if ($stats.Count) {
    $parts = @()
    foreach ($k in $stats.Keys) { $parts += "$k $($stats[$k]) 处" }
    Write-Host ('标点修复：' + ($parts -join '，'))
}

$problems = Test-Chapters $chapters $titles
if ($problems.Count) {
    Write-Host ''
    Write-Host "自检发现 $($problems.Count) 项待确认："
    foreach ($p in $problems) { Write-Host "  - $p" }
} else {
    Write-Host '自检通过：无空章、无残留标记、章节号连续'
}

if ($checkOnly) {
    if ($problems.Count) { exit 1 }
    exit 0
}

$enc = Resolve-TextEncoding $Encoding
$written = 0

if ($Mode -eq 'both' -or $Mode -eq 'single') {
    $blocks = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $chapters.Count; $i++) {
        $blocks.Add((Get-ChapterText $titles[$i] $chapters[$i]).TrimEnd("`n"))
    }
    $whole = ($blocks -join "`n`n") + "`n"
    Write-TextFile (Join-Path $Out ((Get-SafeFileName $Book) + '【全本】.txt')) $whole $enc
    $written++
}

if ($Mode -eq 'both' -or $Mode -eq 'split') {
    $chapterDir = Join-Path $Out '分章'
    $manifest = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $chapters.Count; $i++) {
        $idx = $i + 1
        $prefix = ''
        if ($padNames) { $prefix = '{0:d3}_' -f $idx }
        $name = $prefix + (Get-SafeFileName $titles[$i]) + '.txt'
        Write-TextFile (Join-Path $chapterDir $name) (Get-ChapterText $titles[$i] $chapters[$i]) $enc
        $written++
        $manifest.Add(('{0,4}. {1}（{2} 字）' -f $idx, $titles[$i], (Get-ChapterWordCount $chapters[$i])))
    }
    $index = "$Book`n共 $($chapters.Count) 章，$totalWords 字`n`n" + ($manifest -join "`n") + "`n"
    Write-TextFile (Join-Path $Out '_上传清单.txt') $index $enc
    $written++
}

Write-Host ''
Write-Host "已输出 $written 个文件到 $Out/（编码 $Encoding）"
exit 0
