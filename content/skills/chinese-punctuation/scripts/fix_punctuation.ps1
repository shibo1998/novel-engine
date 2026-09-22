# 按中文标点规范批量修复正文标点（fix_punctuation.py 的 PowerShell 等价实现，
# 供没有 Python 的 Windows 环境使用，兼容 Windows PowerShell 5.1 和 PowerShell 7）。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File fix_punctuation.ps1 文件...                  就地修复
#   powershell -ExecutionPolicy Bypass -File fix_punctuation.ps1 -Check 文件...           只检查并输出改动，不写回（有问题时退出码为 1）
#   powershell -ExecutionPolicy Bypass -File fix_punctuation.ps1 -StripMarkdown 文件...   修复标点，同时删除加粗/斜体标记和分节符行
#
# 处理范围与保护规则同 fix_punctuation.py，见该文件头部注释。

param(
    [switch]$Check,
    [switch]$StripMarkdown,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Files
)

if (-not $Files) {
    Write-Host '用法: fix_punctuation.ps1 [-Check] [-StripMarkdown] 文件...'
    exit 2
}

$HAN = [regex]'[㐀-鿿豈-﫿]'
$KANA = [regex]'[぀-ヿ]'
$LATIN = [regex]'[A-Za-z]'

$InlineCodeRe = [regex]'`[^`]*`'
$UrlRe = [regex]'(?:https?://|www\.)\S+'
$EmailRe = [regex]'[\w.+-]+@[\w-]+\.[\w.-]+'
$ListNumRe = [regex]'^\s*\d{1,3}[.)]\s'

# 弯引号在 PowerShell 里也是字符串定界符，不能写进字面量，用码点构造
$LSQ = [char]0x2018  # ‘
$RSQ = [char]0x2019  # ’
$LDQ = [char]0x201C  # “
$RDQ = [char]0x201D  # ”

$OpenBefore = '([{（【《' + $LSQ + $LDQ + '「『：:，,'
$Simple = @{ ',' = '，'; ';' = '；'; ':' = '：'; '?' = '？'; '!' = '！' }

$BoldRe = [regex]'\*\*([^*\n]+)\*\*'
$ItalicRe = [regex]'(?<!\*)\*([^*\n]+)\*(?!\*)'
$HrRe = [regex]'^\s*(?:-{3,}|\*{3,}|_{3,})\s*$'

$LengthChanging = @(
    @([regex]'(?:\.{3,}|。{3,})', '……', '省略号'),
    @([regex]'(?<!…)…(?!…)', '……', '省略号'),
    @([regex]'-{2,}', '——', '破折号'),
    @([regex]'(?<!—)—(?!—)', '——', '破折号')
)

function Add-Stat($stats, [string]$key, [int]$n = 1) {
    if ($stats.ContainsKey($key)) { $stats[$key] += $n } else { $stats[$key] = $n }
}

function Get-ProtectedMask([string]$line) {
    $mask = New-Object bool[] $line.Length
    foreach ($re in @($InlineCodeRe, $UrlRe, $EmailRe)) {
        foreach ($m in $re.Matches($line)) {
            for ($i = $m.Index; $i -lt $m.Index + $m.Length; $i++) { $mask[$i] = $true }
        }
    }
    $m = $ListNumRe.Match($line)
    if ($m.Success) {
        for ($i = 0; $i -lt $m.Length; $i++) { $mask[$i] = $true }
    }
    return , $mask
}

function Test-AsciiWord([string]$ch) {
    if (-not $ch) { return $false }
    return ([int]$ch[0] -lt 128) -and [char]::IsLetterOrDigit($ch[0])
}

function Get-NextNonSpace([string]$s, [int]$i) {
    $j = $i + 1
    while ($j -lt $s.Length -and [char]::IsWhiteSpace($s[$j])) { $j++ }
    if ($j -lt $s.Length) { return $s[$j].ToString() }
    return ''
}

function Get-PrevNonSpace([string]$s, [int]$i) {
    $j = $i - 1
    while ($j -ge 0 -and [char]::IsWhiteSpace($s[$j])) { $j-- }
    if ($j -ge 0) { return $s[$j].ToString() }
    return ''
}

function Repair-Quotes([string]$line, [bool[]]$mask, $stats) {
    $out = $line.ToCharArray()
    for ($i = 0; $i -lt $line.Length; $i++) {
        if ($mask[$i]) { continue }
        $ch = $line[$i]
        if ($ch -eq '"') {
            $prev = ''
            if ($i) { $prev = $out[$i - 1].ToString() }
            if (-not $prev -or [char]::IsWhiteSpace($prev[0]) -or $OpenBefore.IndexOf($prev[0]) -ge 0) {
                $out[$i] = $LDQ
            } else {
                $out[$i] = $RDQ
            }
            Add-Stat $stats '引号'
        } elseif ($ch -eq "'") {
            $prev = ''
            if ($i) { $prev = $out[$i - 1].ToString() }
            $next = ''
            if ($i + 1 -lt $line.Length) { $next = $line[$i + 1].ToString() }
            if ((Test-AsciiWord $prev) -and $next -and [char]::IsLetter($next[0])) {
                $out[$i] = $RSQ  # 撇号: it's / John's
            } elseif (-not $prev -or [char]::IsWhiteSpace($prev[0]) -or $OpenBefore.IndexOf($prev[0]) -ge 0) {
                $out[$i] = $LSQ
            } else {
                $out[$i] = $RSQ
            }
            Add-Stat $stats '引号'
        }
    }
    return -join $out
}

function Test-ChineseLine([string]$line, [bool[]]$mask) {
    if (-not $line.Length) { return $false }
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $line.Length; $i++) {
        if (-not $mask[$i]) { [void]$sb.Append($line[$i]) }
    }
    $visible = $sb.ToString()
    if ($KANA.IsMatch($visible)) { return $false }
    $han = $HAN.Matches($visible).Count
    return ($han -gt 0) -and ($han -ge $LATIN.Matches($visible).Count)
}

function Repair-Halfwidth([string]$line, [bool[]]$mask, $stats) {
    $out = $line.ToCharArray()
    for ($i = 0; $i -lt $line.Length; $i++) {
        if ($mask[$i]) { continue }
        $s = $line[$i].ToString()
        if ($Simple.ContainsKey($s) -or $s -eq '.') {
            $prev = ''
            if ($i) { $prev = $line[$i - 1].ToString() }
            if ((Test-AsciiWord $prev) -and (Test-AsciiWord (Get-NextNonSpace $line $i))) {
                continue  # 英文/数字内部: 3.14, 1,000, no, thanks
            }
            if ($s -eq '.') { $out[$i] = '。' } else { $out[$i] = $Simple[$s] }
            Add-Stat $stats '全角标点'
        }
    }
    return -join $out
}

function Repair-Parens([string]$line, [bool[]]$mask, $stats) {
    $out = $line.ToCharArray()
    $stack = New-Object 'System.Collections.Generic.Stack[int]'
    for ($i = 0; $i -lt $line.Length; $i++) {
        if ($mask[$i]) { continue }
        $ch = $line[$i]
        if ($ch -eq '(') {
            $stack.Push($i)
        } elseif ($ch -eq ')') {
            if ($stack.Count) {
                $j = $stack.Pop()
                if ($HAN.IsMatch($line.Substring($j + 1, $i - $j - 1))) {
                    $out[$j] = '（'
                    $out[$i] = '）'
                    Add-Stat $stats '全角标点' 2
                }
            } elseif ($HAN.IsMatch((Get-PrevNonSpace $line $i))) {
                $out[$i] = '）'
                Add-Stat $stats '全角标点'
            }
        }
    }
    foreach ($j in $stack) {
        if ($HAN.IsMatch((Get-NextNonSpace $line $j))) {
            $out[$j] = '（'
            Add-Stat $stats '全角标点'
        }
    }
    return -join $out
}

function Invoke-SubMasked([regex]$pattern, [string]$repl, [string]$line, [bool[]]$mask, $stats, [string]$label) {
    $sb = New-Object System.Text.StringBuilder
    $last = 0
    foreach ($m in $pattern.Matches($line)) {
        $hit = $false
        for ($i = $m.Index; $i -lt $m.Index + $m.Length; $i++) {
            if ($mask[$i]) { $hit = $true; break }
        }
        if ($hit -or $m.Value -eq $repl) { continue }
        [void]$sb.Append($line.Substring($last, $m.Index - $last)).Append($repl)
        $last = $m.Index + $m.Length
        Add-Stat $stats $label
    }
    [void]$sb.Append($line.Substring($last))
    return $sb.ToString()
}

function Convert-Text([string]$text, [bool]$stripMd, $stats) {
    $lines = $text.Split("`n")
    $outLines = New-Object System.Collections.Generic.List[string]
    $inFence = $false
    $inFront = $false
    for ($idx = 0; $idx -lt $lines.Length; $idx++) {
        $line = $lines[$idx]
        $stripped = $line.Trim()
        if ($idx -eq 0 -and $stripped -eq '---') {
            $inFront = $true
            $outLines.Add($line)
            continue
        }
        if ($inFront) {
            $outLines.Add($line)
            if ($stripped -eq '---' -or $stripped -eq '...') { $inFront = $false }
            continue
        }
        if ($stripped.StartsWith('```') -or $stripped.StartsWith('~~~')) {
            $inFence = -not $inFence
            $outLines.Add($line)
            continue
        }
        if ($inFence) {
            $outLines.Add($line)
            continue
        }
        if ($stripMd -and $HrRe.IsMatch($line)) {
            Add-Stat $stats '分节符删除'
            continue
        }
        $mask = Get-ProtectedMask $line
        $line = Repair-Quotes $line $mask $stats
        if (Test-ChineseLine $line $mask) {
            $line = Repair-Halfwidth $line $mask $stats
            $line = Repair-Parens $line $mask $stats
            foreach ($entry in $LengthChanging) {
                $mask = Get-ProtectedMask $line
                $line = Invoke-SubMasked $entry[0] $entry[1] $line $mask $stats $entry[2]
            }
        }
        if ($stripMd -and -not $stripped.StartsWith('#')) {
            $before = $line
            $line = $BoldRe.Replace($line, '$1')
            $line = $ItalicRe.Replace($line, '$1')
            if ($line -cne $before) { Add-Stat $stats '格式标记删除' }
        }
        $outLines.Add($line)
    }
    return ($outLines -join "`n")
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$dirty = $false
foreach ($f in $Files) {
    $path = (Resolve-Path $f).Path
    $text = [System.IO.File]::ReadAllText($path)
    $stats = @{}
    $new = Convert-Text $text $StripMarkdown.IsPresent $stats
    if ($new -ceq $text) {
        Write-Host "${f}: 无需修改"
        continue
    }
    $dirty = $true
    $parts = @()
    foreach ($k in $stats.Keys) { $parts += "$k $($stats[$k]) 处" }
    $summary = $parts -join '，'
    if ($Check) {
        $oldLines = $text.Split("`n")
        $newLines = $new.Split("`n")
        if ($oldLines.Length -eq $newLines.Length) {
            for ($i = 0; $i -lt $oldLines.Length; $i++) {
                if ($oldLines[$i] -cne $newLines[$i]) {
                    Write-Host "  第 $($i + 1) 行"
                    Write-Host "  - $($oldLines[$i].TrimEnd())"
                    Write-Host "  + $($newLines[$i].TrimEnd())"
                }
            }
        }
        Write-Host "${f}: 待修复 $summary"
    } else {
        [System.IO.File]::WriteAllText($path, $new, $utf8NoBom)
        Write-Host "${f}: 已修复 $summary"
    }
}
if ($Check -and $dirty) { exit 1 }
exit 0
