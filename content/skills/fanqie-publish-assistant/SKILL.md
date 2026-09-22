---
name: fanqie-publish-assistant
description: 'Prepare a Chinese web novel in the SoloEnt (灵蟹) workspace for upload to Fanqie 番茄小说. Normalize Chinese punctuation, strip every Markdown mark and extra blank line, split the manuscript into per-chapter TXT plus a whole-book TXT, and run a pre-upload audit. Optionally write a book blurb of 300 characters or fewer, and generate a 600x800 jpg/png cover under 5MB carrying the title and pen name. Trigger on requests like 上传番茄, 发布到番茄, 番茄发布, 导出番茄 txt, 番茄格式正文, 整理正文准备上传, 番茄书封, 番茄封面, 番茄简介, 作品简介, or any question about getting a manuscript ready for Fanqie.'
---

# 番茄发布助手

把灵蟹/SoloEnt工作区里的正文，整理成番茄作家后台可以直接上传的文件。

**能力边界**：本技能不代替作者登录番茄，也不能自动提交。它产出**上传即用的文件**（txt / 封面 / 简介），最后一步由作者在番茄后台完成上传。不要声称已经"上传成功"。

## 触发条件

- "把正文整理成番茄能传的格式" / "导出番茄 txt" / "发布到番茄"
- "我要上架番茄，帮我准备一下"
- "生成番茄书封" / "写个番茄简介"

## 交付物

| 产物 | 路径 | 必选 |
|------|------|------|
| 整本 txt | `fanqie/《书名》【全本】.txt` | 是 |
| 分章 txt | `fanqie/分章/第N章 标题.txt` | 是 |
| 上传清单 | `fanqie/_上传清单.txt` | 是 |
| 作品简介 | `fanqie/简介.txt` | 询问后 |
| 书封 | `covers/{书名}-封面.jpg` | 询问后 |

---

## 第一步：确认范围与基本信息

先自己找，不要让作者从零复述。按优先级读取：`SOLOENT.md` → 正文目录（`chapters/`、`正文/`、`第*章*`）→ 大纲设定文件。

然后**一次问清**这三项（这是事实性信息，可以打包问）：

> 1. 要发布哪些章节？（默认：找到的全部）
> 2. 书名是？
> 3. 笔名是？

补问一句：**"要顺便做书封和作品简介吗？"** 作者说不要就跳过第四、五步。

---

## 第二步：规范标点并导出 txt

脚本一次做完标点规范、Markdown 清除、空行清理、按章切分、自检。

**每个脚本都有 Python 和 PowerShell 两个版本，功能完全一致。先判断环境再选：**

- 有 `python3`（macOS 一般自带）→ 用 `.py`
- Windows 且没装 Python → 用 `.ps1`，**不需要装任何东西**
- 拿不准就先跑 `python3 --version`，报错就切 PowerShell 版

```bash
# Python
python3 tools/export_fanqie_txt.py 正文目录/ --book "书名" --out fanqie
```

```powershell
# Windows PowerShell（等价）
powershell -ExecutionPolicy Bypass -File tools\export_fanqie_txt.ps1 -Book "书名" -Out fanqie 正文目录\
```

先跑一次自检看结果再正式导出，是更稳的做法：

```bash
python3 tools/export_fanqie_txt.py 正文目录/ --book "书名" --check
```

```powershell
powershell -ExecutionPolicy Bypass -File tools\export_fanqie_txt.ps1 -Book "书名" -Check 正文目录\
```

常用参数（PowerShell 版把 `--xxx-yyy` 写成 `-XxxYyy`）：

| Python | PowerShell | 用途 |
|--------|-----------|------|
| `--mode single` / `split` | `-Mode single` / `split` | 只要整本 / 只要分章（默认两者都出） |
| `--number-style chinese` | `-NumberStyle chinese` | 章节号用「第一章」而非「第1章」 |
| `--pad` | `-Pad` | 分章文件名加 `001_` 前缀，上传工具按文件名排序时用 |
| `--encoding gbk` | `-Encoding gbk` | 老工具不认 UTF-8 时改用 GBK |

脚本已经保证的格式（不需要再手工确认）：章节标题独占一行并统一成「第N章 标题」；段落之间无空行；无 `#` `*` `_` `~` `>` 和列表符号；无行尾空格、段首缩进、零宽字符；输出 UTF-8 无 BOM。

格式细则与逐条自检标准：加载 `docs/txt-format.md`。

---

## 第三步：复查（必做，不能跳）

脚本只做机械转换。**把脚本报告里的每一项问题都处理掉**，再通读或抽样检查下面这些脚本判断不了的：

1. **顿号**：并列词之间的 `，` 改 `、`（"刀，剑，枪" → "刀、剑、枪"）
2. **书名号**：作品名加 `《 》`
3. **引号方向**：脚本按前一个字符猜方向，对话密集段和嵌套引语要重点核对开闭配对
4. **场景分隔**：原文用 `---` 或 `***` 分隔场景的地方已被删掉，需要的话改写成一句过渡文字
5. **章节号连续性**：脚本报告的"不连续/重复"要么改对，要么确认是有意为之（如插入番外）
6. **空章与超短章**：番茄连载节奏一般 2000–4000 字/章，脚本标出的短章要合并或扩写

标点规范全文：加载 `docs/punctuation.md`。

改完后重跑一次 `--check` / `-Check`，退出码 0 才算干净。

---

## 第四步（可选）：作品简介，300 字以内

**硬约束**：正文不超过 300 字；不剧透结局；不写作者感言、求票、更新说明；不出现联系方式和外站引流。

结构（按顺序写，不要标小标题，直接连成 3–5 个自然段）：

1. **前两行定生死**（≤30 字）：番茄列表页只露出开头两行，第一句必须是身份反差、极端处境或高冲突事件，不能是世界观铺垫。
2. **核心设定 / 金手指**：一句话说清主角凭什么翻盘，要简单直给。
3. **爽点承诺**：读者能持续看到什么（打脸、扮猪吃虎、逆袭、追妻火葬场……）。
4. **钩子收尾**：一句悬念或一句主角台词，不给答案。

写完先给作者看，确认后再写入 `fanqie/简介.txt`。模板与正反例：加载 `docs/cover-and-blurb.md`。

---

## 第五步（可选）：书封，600×800

番茄硬性要求：**600×800 像素、jpg/png/jpeg、≤5MB**，封面上必须有**清晰的作品名和作者笔名**，内容元素要贴合作品风格。

### 5.1 提取要素

从第一步已读到的材料里提取：题材、基调、主角核心特点（言情要男女主）、贯穿全文的关键道具。提取不到的标注"待确认"，**不要编造**。

### 5.2 依次确认（一次只问一个问题）

每个问题一屏：一句问题 + 3 个互斥选项，推荐项标注"（推荐）"。作者一次答多个就逐条复述，只追问没答的。

1. **封面主体**：A. 主角为核心（言情可男女主同框） B. 场景/意象/道具为核心，主角作剪影或不出现 C. 自行描述
2. **视觉风格**：结合题材只给三个方向，每个配一句画面感描述（古言→工笔／水墨写意／国潮撞色；都市→电影感光影／时尚摩登／复古胶片；玄幻→史诗厚涂／暗黑哥特／东方浮雕；科幻→赛博霓虹／冷硬科技／废土质感；悬疑→冷色极简／暗黑纪实／超现实拼贴）

### 5.3 输出中英双语提示词，等待确认

中文版给作者读，英文版用于出图，两版一一对应。**书名必须给出具体字形改造方案**（笔画替换、材质附着、结构变形、光效绑定），禁止只写"优雅衬线体"这类空话。提示词连同第四步的简介一起呈现，存到 `covers/{书名}.md`。

模板全文：加载 `docs/cover-and-blurb.md`。

**输出后停下**，问："提示词确认吗？确认后我直接出图。"未获确认不得调用出图工具。

### 5.4 出图并压成番茄规格

1. 检查本回合是否有 `generate_image` 工具。**没有就停下**，告知作者去 设置 → Features → Tools 启用 **SoloEnt Image Tools** 并确认已登录。不要用 shell 伪造、不要编造图片路径、不要声称已出图。
2. 用英文提示词出图，尺寸传 **768×1024**（3:4 竖版，长宽均为 16 的倍数）。600×800 不是 16 的倍数，不能直接作为出图尺寸。
3. 压成番茄规格：

```bash
python3 tools/make_cover.py covers/原图.png --out "covers/书名-封面.jpg"
```

```powershell
powershell -ExecutionPolicy Bypass -File tools\make_cover.ps1 covers\原图.png -Out "covers\书名-封面.jpg"
```

脚本按 3:4 居中裁剪后缩放到 600×800，自动降质直到 ≤5MB。PowerShell 版用 Windows 自带的 System.Drawing，若报错提示加载不了，让作者改用「Windows PowerShell 5.1」运行。

4. 交付时告知相对路径，并主动提供两个选项：调整画面元素重出、换视觉风格重出。

### 5.5 封面红线（出图前自查）

不得出现：二维码、网址、微信/QQ 等联系方式、其他平台水印或 logo、真人明星肖像、他人作品截图、露骨或血腥画面、除书名与笔名外的任何文字。

---

## 第六步：上传指引

告诉作者接下来怎么做，用他实际拿到的文件名：

1. 打开番茄作家后台，进入这本书的章节管理。
2. 后台有批量导入入口 → 传 `fanqie/《书名》【全本】.txt`，导入后核对章节数与 `_上传清单.txt` 是否一致。
3. 没有批量导入入口 → 按 `_上传清单.txt` 的顺序，逐章复制 `fanqie/分章/` 下的文件内容粘贴。**每个文件的第一行是章节标题，粘正文时不要带进正文框**。
4. 封面在作品信息页上传 `covers/{书名}-封面.jpg`，简介粘 `fanqie/简介.txt`。
5. 提醒：首次上传后在番茄的预览里看一眼排版，段落是否断行正常、有没有多余空行。

不要编造后台的具体按钮名称和菜单路径——按上面这样描述目标，让作者在自己的后台里找。
