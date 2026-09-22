# 作品简介与书封

简介和封面一起交付：先写简介，再把简介里的核心意象喂进封面提示词，两者气质才一致。

---

# 一、作品简介（300 字以内）

## 番茄简介的真实作用

它不是内容摘要，是**转化文案**。读者在列表页只看到前两行就决定要不要点。所以第一句必须自带冲突或反差，不能用来交代世界观。

## 硬约束

- 正文 ≤ 300 字（含标点），实际写到 150–250 字最好
- 不剧透结局、不写"本文慢热"、不写作者感言、不写更新说明、不求票
- 不出现微信/QQ/网址/其他平台名
- 短句为主，口语化，不用生僻词和长定语

## 四段结构

按顺序写，**不要标小标题**，直接连成 3–5 个自然段。

| 段 | 写什么 | 字数 |
|----|--------|------|
| 1 | **钩子**：身份反差 / 极端处境 / 高冲突事件，一句话 | ≤30 字 |
| 2 | **金手指或核心设定**：主角凭什么翻盘，简单直给 | 40–60 字 |
| 3 | **爽点承诺**：读者能反复看到什么（打脸、扮猪吃虎、逆袭、追妻火葬场） | 60–100 字 |
| 4 | **钩子收尾**：一句悬念，或一句主角台词，不给答案 | ≤30 字 |

## 反例与正例

✗ **世界观开场**（第一句就劝退）：

> 大陆分为九州，各州之间以灵脉相连。三千年前，一场浩劫让灵脉断绝……

✓ **事件开场**：

> 被退婚那天，林凡在废矿里捡到一块会说话的石头。
>
> 石头说：你每挖一锹，我还你一百倍。
>
> 三天后他挖穿了整座矿山。半个月后，昔日退婚的名门找上门来，跪在他家门口，只求他抬手匀出一块灵石。
>
> 林凡把玩着手里那块石头：“当初是谁说我一辈子挖矿的？”

## 交付方式

1. 先把简介贴给作者看，问一句"这版简介确认吗？"
2. 确认后写入 `fanqie/简介.txt`（纯文本，无 Markdown）
3. 和封面提示词一起呈现

---

# 二、书封

## 番茄封面规格（硬性）

| 项 | 要求 |
|----|------|
| 尺寸 | 600 × 800 像素（3:4 竖版） |
| 格式 | jpg / png / jpeg |
| 体积 | ≤ 5MB |
| 必含内容 | 清晰的作品名 + 作者笔名 |
| 内容元素 | 贴合作品题材与基调 |
| 画风 | 有设计感和艺术性，不是随便贴字 |

**出图不能直接传 600×800**——多数出图模型要求长宽是 16 的倍数，600 不是。做法：用 **768×1024** 出图（3:4，两边都能被 16 整除），再用 `tools/make_cover.py` 缩到 600×800 并压到 5MB 以内。

## 红线（出图前自查）

不得出现：二维码、网址、微信/QQ 等联系方式、其他平台水印或 logo、真人明星肖像、他人作品截图、露骨或血腥画面、除书名与笔名之外的任何文字或乱码字符。

## 中文提示词模板

```text
【题材基调】[题材] + [基调]，专业小说封面
【画面主体】[主角描写 / 或核心意象；言情写明男女主站位与互动]
【背景】[符合世界观的场景与氛围]
【色彩】[主色 + 辅色 + 点缀色，说明情绪指向]
【关键道具】[象征物及其在画面中的位置与光效]
【书名设计】书名《[书名]》，[字形如何结合作品元素]，位于[位置]，占画面宽度约 [X]%
【作者署名】[笔名]，[字体与位置]，字号明显小于书名但清晰可辨
【风格】[所选视觉方向]，电影级光影，高细节，专业出版级平面设计
【规格】768 × 1024 像素出图，3:4 竖版（后期缩至 600 × 800）
【禁止】除书名与笔名外不出现任何文字、水印、二维码、乱码字符
```

## 英文提示词模板

```text
Professional [genre] novel book cover, [tone] mood.
Subject: [protagonist / core imagery, with staging for dual leads if romance].
Background: [setting and atmosphere].
Color: [primary + secondary + accent], conveying [emotion].
Key prop: [symbolic object], [placement and lighting].
Title typography: "[Title]" rendered as [how the lettering embodies a story element], placed at [position], occupying about [X]% of the width.
Author byline: "[Pen name]", [typeface and position], clearly legible but smaller than the title.
Style: [chosen direction], cinematic lighting, highly detailed, publication-grade graphic design.
Aspect ratio: strictly 3:4 vertical, 768x1024 pixels.
Negative: no extra text, no watermark, no QR code, no garbled characters, no extra limbs.
```

## 书名字体设计要求（不可省略）

必须给出**具体字形改造方案**，禁止只写"优雅衬线体"这类空话。四种可用手法：

- **笔画替换**：某一笔化为关键道具（剑、藤蔓、锁链、光缆、矿镐）
- **材质附着**：烫金、裂纹、锈蚀、结霜、灼烧、水墨晕染
- **结构变形**：字体被贯穿、断裂、倒影、生长
- **光效绑定**：与画面光源同向的高光或投影

示例：「书名《噬矿》，‘噬’字的口部化作一道裂开的矿脉，露出内里的金色光芒；‘矿’字最后一竖拉长成一柄插进地面的矿镐，笔画边缘有锈蚀与碎石质感，位于画面上方三分之一处」

## 缩到番茄规格

```bash
python3 tools/make_cover.py covers/原图.png --out "covers/书名-封面.jpg"
```

```powershell
powershell -ExecutionPolicy Bypass -File tools\make_cover.ps1 covers\原图.png -Out "covers\书名-封面.jpg"
```

按 3:4 居中裁剪后缩放到 600×800，jpg 自动降质直到 ≤5MB。需要 png 时加 `--format png` / `-Format png`。

各版本的实现依赖：

| 版本 | 用什么 | 缺失时 |
|------|--------|--------|
| `make_cover.py` | Pillow | macOS 回退到系统自带 `sips`；都没有则提示手动导出 |
| `make_cover.ps1` | Windows 自带 System.Drawing | 提示改用 Windows PowerShell 5.1 运行 |

PowerShell 版在 macOS / Linux 上跑不了（System.Drawing 在 .NET 6+ 是 Windows 专属），非 Windows 环境请用 Python 版。

## 缩图后必看

600×800 是手机列表页里的小图，缩完必须自己看一眼：

1. 书名在小图上还认得出吗？认不出就加大字号或加描边重出
2. 笔名有没有被裁掉或糊成一团
3. 主体在小图上是否还成立（复杂构图缩小后经常糊成一片）
