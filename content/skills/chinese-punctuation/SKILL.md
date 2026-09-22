---
name: chinese-punctuation
description: 'Enforce Chinese punctuation and typography standards in prose. Two modes: (1) when writing or generating any prose (novels, chapters, copy) — e.g. "写正文第1章，用正确的标点" — follow the punctuation rules: directional quotes, full-width Chinese punctuation in Chinese text, no Markdown abuse; (2) when the user asks to fix, clean up, or normalize punctuation in existing documents — e.g. "改正文的标点用法", "优化 1-50 章的标点" — run the batch-fix script then review what the script cannot judge. Trigger on requests like 写正文, 改标点, 优化标点, 标点规范, 全角标点, fixing straight quotes or half-width punctuation, or cleaning up AI-generated formatting.'
---

# 中文标点规范

两种使用场景，先判断属于哪种：

- **写正文**（生成小说、章节、文案等任何正文）→ 按下面的标点规范直接写。
- **修复现有文档**（用户要求规范化、清理已有文件的标点）→ 用脚本批量修复。

两种场景最后都必须走「复查」步骤（见文末），不能写完/修完就交付。

## 标点规范（写正文时强制遵守）

### 1. 引号必须使用方向性字符

**绝对禁止**直引号 `'`（U+0027）和 `"`（U+0022），按上下文区分左右：

| 类型 | 左（开始） | 右（结束） |
| :--- | :--- | :--- |
| 单引号 | `‘` (U+2018) | `’` (U+2019) |
| 双引号 | `“` (U+201C) | `”` (U+201D) |

- 引号前为空白/段首/左括号/冒号/逗号/其他左引号 → 左引号
- 引号前为字/词/句末标点 → 右引号
- 撇号（缩写、所有格，如 `it’s` / `John’s`）一律用 `’`

### 2. 中文正文使用全角中文标点

一段文字主语种为中文时，全部标点用全角：`。，、；：？！“”‘’（）《》`，省略号用 `……`，破折号用 `——`。

**例外**：嵌入的英文原词、代码、URL、文件名、数字（3.14、1,000、3:15）保留半角。

### 3. 其他语言正文

- 英文/罗马字段落：半角标点，但引号仍须方向性（`“ ” ‘ ’`）
- 日文：句号 `。`，逗号 `、`，引号 `「 」` / `『 』`
- 韩文：句末 `.`，引号 `“ ”` / `‘ ’`

### 4. 正文禁止滥用 Markdown

- 禁止加粗、斜体、分节符（`---`）、列表符号
- 纯文本排版，段落间空一行
- 例外：章节标题可用 `#`

## 写正文的流程

1. 按上面的规范写。
2. 如果正文写入了文件，跑 `python3 scripts/fix_punctuation.py --check 文件` 兜底，有 diff 就修复（Windows 无 Python 时用 PowerShell 版，见「修复现有文档的流程」）。
3. 按文末「复查」清单自查一遍再交付；没写入文件的正文直接对照清单通读自查。

## 修复现有文档的流程

### 第一步：先检查，看修改规模

```bash
python3 scripts/fix_punctuation.py --check 文件1.md 文件2.md
```

输出 diff 和各类问题数量，不写回。文件多时可配合 glob：`python3 scripts/fix_punctuation.py --check 目录/*.md`。

### 第二步：批量修复

```bash
python3 scripts/fix_punctuation.py 文件...
```

就地修改。如果用户同时要求清理正文里的加粗/斜体/分节符，加 `--strip-markdown`（会删除 `**` `*` 标记和 `---` 行，先跟用户确认这是正文而不是需要保留格式的文档）。

脚本自动保护：代码块、行内代码、URL、邮箱、YAML frontmatter、有序列表编号、数字内部的标点（3.14、1,000）、日文行（含假名的行不做全角转换）。

**Windows 无 Python 环境**：改用系统自带的 PowerShell 跑等价脚本 `fix_punctuation.ps1`，行为与 Python 版一致（`-Check` 输出逐行改动而非 diff）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fix_punctuation.ps1 -Check 文件...
powershell -ExecutionPolicy Bypass -File scripts/fix_punctuation.ps1 文件...
powershell -ExecutionPolicy Bypass -File scripts/fix_punctuation.ps1 -StripMarkdown 文件...
```

### 第三步：复查

## 复查（写正文和修复文档都必须做）

脚本只做机械转换，交付前必须通读或抽样检查这些语义项，发现问题手动改：

1. **顿号**：并列词之间的 `，` 应改 `、`（如「苹果，香蕉，橘子」→「苹果、香蕉、橘子」），脚本无法判断并列关系。
2. **书名号**：作品名应加 `《 》`，脚本不识别作品名。
3. **引号方向**：脚本按前一个字符猜方向，嵌套引号或跨段引语可能出错；自己写的正文也要确认开闭配对，重点查对话密集的段落。
4. **日文/韩文段落**：日文引号 `「 」`、逗号 `、` 需按规则 3 调整。
5. **列表改写**：正文中的 Markdown 列表应改写成自然段落，`--strip-markdown` 不处理列表，需要模型改写。

改完后如果内容在文件里，再跑一次 `--check` 确认无残留（退出码 0 即干净）。
