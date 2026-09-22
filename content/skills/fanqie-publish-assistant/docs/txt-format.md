# 番茄 txt 格式规范与脚本用法

## 目标格式

分章文件（`fanqie/分章/第1章 石头开口了.txt`）：

```
第1章 石头开口了
林凡蹲在矿洞口，把最后半块干粮塞进嘴里。
“你确定是这块？”
石头没有回答。
```

整本文件（`fanqie/《书名》【全本】.txt`）：章与章之间空一行，章内不空行。

```
第1章 石头开口了
林凡蹲在矿洞口，把最后半块干粮塞进嘴里。
石头没有回答。

第2章 第一次开采
天亮之前，他又下了一次矿。
```

## 硬性规则

| 规则 | 说明 |
|------|------|
| 编码 | UTF-8 无 BOM（老工具不认时用 `--encoding gbk`） |
| 换行 | LF，不用 CRLF |
| 章节标题 | 独占一行，格式统一为「第N章 标题」，前后不加符号 |
| 段落 | 一段一行，段落之间**不空行** |
| 段首 | 不加空格、不加全角空格 |
| Markdown | 一个都不能有：`#` `*` `_` `~` `>` `-` 列表符、分节符、链接、图片、行内代码 |
| 不可见字符 | 零宽字符、NBSP、行尾空格全部清除 |
| 文件名 | 不含 `\ / : * ? " < > |` |

## 脚本用法

两个版本功能完全一致，输出逐字节相同，按环境二选一：`export_fanqie_txt.py`（需要 Python 3）和 `export_fanqie_txt.ps1`（Windows 自带 PowerShell，无需安装任何东西）。

```bash
# Python：自检，不写文件
python3 scripts/export_fanqie_txt.py 正文目录/ --book "书名" --check

# Python：正式导出（默认整本 + 分章 + 上传清单）
python3 scripts/export_fanqie_txt.py 正文目录/ --book "书名" --out fanqie

# Python：指定多个文件，按给定顺序处理
python3 scripts/export_fanqie_txt.py 第1章.md 第2章.md --book "书名"
```

```powershell
# PowerShell：自检，不写文件
powershell -ExecutionPolicy Bypass -File scripts\export_fanqie_txt.ps1 -Book "书名" -Check 正文目录\

# PowerShell：正式导出
powershell -ExecutionPolicy Bypass -File scripts\export_fanqie_txt.ps1 -Book "书名" -Out fanqie 正文目录\

# PowerShell：指定多个文件
powershell -ExecutionPolicy Bypass -File scripts\export_fanqie_txt.ps1 -Book "书名" 第1章.md 第2章.md
```

参数：

| Python | PowerShell | 默认 | 说明 |
|--------|-----------|------|------|
| `--book` | `-Book` | 必填 | 书名，用于输出文件名 |
| `--out` | `-Out` | `fanqie` | 输出目录 |
| `--mode` | `-Mode` | `both` | `single` 只出整本；`split` 只出分章 |
| `--number-style` | `-NumberStyle` | `arabic` | `chinese` 用「第一章」；`keep` 保留原标题行 |
| `--pad` | `-Pad` | 关 | 分章文件名加 `001_` 前缀，上传工具按文件名排序时打开 |
| `--encoding` | `-Encoding` | `utf-8` | 可改 `gbk` |
| `--check` | `-Check` | 关 | 只自检不写文件，有问题时退出码 1 |

**PowerShell 版的两点注意**：

1. 正文文件或目录写在最后，不加参数名；`-Book` 必须给，漏了会打印用法并以退出码 2 退出（不会挂着等输入）。
2. 首次运行如果提示"禁止运行脚本"，是系统的执行策略拦的，用上面命令里的 `-ExecutionPolicy Bypass` 即可，不需要改系统设置。

## 源文件编码

两个版本都先按 UTF-8 读（自动去 BOM），解码失败再退回 GBK。所以 Windows 上用记事本存成 ANSI 的旧稿也能直接处理。

**目录输入**会递归收集 `.md` 和 `.txt` 并按文件名排序。文件名里的章节号如果是 `第2章`、`第10章` 这种不补零的形式，排序会错（10 排在 2 前面）——这种情况改成显式列出文件，或先把源文件名补零。

## 章节识别规则

按顺序尝试：

1. `第X章/回/节/话 标题` —— X 支持阿拉伯数字、全角数字、中文数字（一、十二、一百零八）
2. `楔子 / 序章 / 序言 / 引子 / 前言 / 尾声 / 终章 / 结局 / 后记 / 番外XX`
3. Markdown 标题行（`#` 到 `######`），整行作为章节名

三条都有长度上限 50 字，超过就当正文，避免把长句误判成标题。

第一个章节标题之前的内容会被收进一个以源文件名命名的章节，需要人工确认是不是该保留。

## 自检项

脚本自动检查并列在报告里：

- 空章、字数 < 500 的短章、字数 > 10000 的超长章
- 章节号重复、章节号不连续
- 只有章节号没有章节名
- 正文残留 `*` `#` `` ` `` `~` 和半角引号

**报告里的每一项都要处理或明确确认后再上传**，不要直接忽略。

## 字数口径

统计的是去掉所有空白字符后的字符数，和番茄后台显示的字数会有小幅出入（后台通常也不计空白，但标点计入规则可能不同），用于判断章节长短足够。
