# 10 · 安装与多 harness

## 这个插件为什么能跨 harness

它是**纯 Markdown + 纯标准库 Python**，没有第三方依赖。SKILL.md 的格式遵循
Anthropic Agent Skills 约定（`SKILL.md` + `scripts/` + `docs/` + `assets/`），
这是目前各家 agent 的公共分母。

不同 harness 的差别**只有一件事：技能目录放在哪**。

## 安装

两种形态。**装到多个 harness 时用链接**——否则每份副本都是一份独立实体，改了源码忘了重装就会漂移。

| 形态 | 命令 | 特点 |
|---|---|---|
| 复制（默认） | `--target workbuddy` | 各 harness 一份独立副本，互不影响 |
| **链接（推荐）** | `--target workbuddy --link` | 建一个指向插件源的 junction（Windows）/ symlink。**只有一份实体，永不漂移** |

```bash
# 看本机有哪些已知目标（★ = 已存在，并显示当前是链接还是副本）
python "<插件>/scripts/install.py" --list

# 一次性装到本机所有已存在的 harness（推荐）
python "<插件>/scripts/install.py" --all --link

# 装单个
python "<插件>/scripts/install.py" --target workbuddy --link

# 链接换回副本（某个 harness 不跟随 junction 时降级用）
python "<插件>/scripts/install.py" --target workbuddy --unlink

# 装到某个项目的技能目录
python "<插件>/scripts/install.py" --target claude --project "D:/1-work"

# 装到任意位置（dsh / pi 等未知 harness 走这条）
python "<插件>/scripts/install.py" --dir "D:/某处/skills"

# 检查已装的版本是否与源一致（换机/更新后核对）
python "<插件>/scripts/install.py" --target workbuddy --check
python "<插件>/scripts/install.py" --all --link --check
```

> **切换形态时旧副本不会丢**：从复制切到链接，原目录被改名成
> `novel-writing.bak-<时间戳>` 保留下来（脚本不替你删除）。
> 确认新链接能用后，那些 `.bak-*` 目录可以自行删掉。

> `.workbuddy-ai/`（本插件自己的工作记忆与备份）不参与复制，
> 已写进 `install.py` 的 `SKIP_DIRS`。

## 已知技能目录

| harness | 用户级 | 项目级 |
|---|---|---|
| WorkBuddy / CodeBuddy | `~/.workbuddy-ai/skills/`、`~/.codebuddy/skills/` | `.workbuddy-ai/skills/`、`.codebuddy/skills/` |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| ZCode | `~/.zcode/skills/` | `.zcode/skills/` |
| Cursor / Windsurf | `~/.cursor/skills/`、`~/.windsurf/skills/` | `.cursor/skills/` |

若某个 harness 不在表里，用 `--dir` 直接指定它的技能目录即可——
只要它认 SKILL.md 格式，就能用。

## ⚠️ 项目级 vs 全局：装哪儿

**SoloEnt 的默认是项目级**，不是全局：

| 位置 | 作用域 | 什么时候用 |
|---|---|---|
| `<项目>/.soloent/skills/novel-writing/` | **仅该项目** | 想给某一本书单独用（SoloEnt 默认） |
| 系统级技能目录（如 `~/.workbuddy-ai/skills/`） | **所有项目** | 你所有书都用同一套流程（推荐） |

官方说明：**全局技能与项目技能同名时，项目技能优先。** 所以可以「全局装一份 + 某本书装一份定制版」。

### 本插件的建议

**装全局（用户级）**。理由：这套流程和工具本来就是"所有书共用一套代码、每书只维护 `book.json`"
——装全局正好对应这个设计。某本书要定制，改它的 `.soloent/book.json` 即可，不必再装一份。

若某个 harness 只有项目级技能目录（如 SoloEnt），那就：

```bash
python "<插件>/scripts/install.py" --dir "<项目>/.soloent/skills"
```

**每本新书装一次**，或者干脆把插件源码放在作品库里，各书用 `--dir` 指过去。

> SoloEnt 的一个坑：**技能包默认安装到当前活跃项目**。没打开项目就装，会装错地方。

## 装完之后

1. **重开一个会话**（技能列表通常在会话启动时加载）
2. 对 agent 说：**「我想写一本小说」**
3. 它应该会问你书名、题材、平台等，然后一条命令生成整本书的骨架

## 可选：挂钩子

钩子让「AI 愿不愿意读正典」不再是个变量：

| 钩子 | 时机 | 作用 |
|---|---|---|
| `hooks/inject_canon.py` | SessionStart | 自动把 `canon.md` + 写作纪律注入上下文 |
| `hooks/after_chapter_write.py` | PostToolUse(Write\|Edit) | 落盘的是章节文件时，自动跑对账＋过闸并把结果注入 |

把 `assets/hooks.config.example.json` 的内容合并进你的 agent 配置，
`<PLUGIN>` 换成插件的绝对路径。

**不挂也能用**，只是要靠 agent 自觉去读文件。

### 钩子配在哪：**工作区根**

钩子读的是**当前工作区根目录**下的 `.codebuddy/settings.json` —— 不是插件目录，也不是书目录本身。
所以「配置放哪」取决于**你平时从哪个目录打开工作区**：

| 你通常打开的工作区 | 该有的配置 |
|---|---|
| `novel/`（**作品库根**）← 最推荐 | `novel/.codebuddy/settings.json` |
| `novel/<某本书>/`（书根） | 该书自己的 `.codebuddy/settings.json` |
| `novel-writing/`（插件目录） | `novel-writing/.codebuddy/settings.json` |

**推荐把库根那份配好**——因为钩子脚本会从「被写文件的路径」反推书根
（`hooks/after_chapter_write.py` 的 `find_book()`），所以**库根一份就覆盖库下所有书，
包括将来新建的**，不必每加一本书补一次配置。

```bash
python "<插件>/scripts/sync.py" --all --lib "<作品库根>"   # 一次写全：库根 + 插件目录 + 每本书
```

这条命令会写**三处**：

1. `<作品库根>/.codebuddy/settings.json` —— 从库根打开工作区时生效
2. `<插件目录>/.codebuddy/settings.json` —— **从 novel-writing 目录打开工作区时生效**
   （很可能就是你的日常情形：在那跟 agent 对话让它写小说）
3. 每本书各自的 `.codebuddy/settings.json`

> **新建一本书**：`init_book.py` 会顺带生成该书自己的 `.codebuddy/settings.json`
> （因为 `sync.plan()` 已包含它），所以即使没配库根，打开新书目录时钩子也能生效。

**为什么配置里带 `--lib "<作品库根>"`**：`inject_canon.py` 要找一本书来注入正典，
它按四级找——cwd 向上 → 项目根向上 → 项目根下的书 → **作品库根下的书**。
最后一级正是为「工作区 = 插件目录」准备的：那种情形下前三级范围内**根本没有书**，
没有 `--lib` 它就只能注入一句"当前不在某本书的项目目录内"，正典注入不出来。

### 随书部署的两份配置

跑过 `sync.py` 之后，每本书下会生成**两份**钩子配置：

| 文件 | 给谁用 | schema |
|---|---|---|
| `<书>/.codebuddy/settings.json` | **CodeBuddy / WorkBuddy**（本机在跑的就是这套） | `hooks.<Event>` ＋ `type:"command"` ＋ 单条 shell 字符串 |
| `<书>/.zcode/config.json` | ZCode | `hooks.events.<Event>` ＋ `type:"process"` ＋ `command`/`args` |

⚠️ **两套 schema 不通用。** 本 harness 只读 `~/.codebuddy/settings.json`、
`<项目根>/.codebuddy/settings.json`、`<项目根>/.codebuddy/settings.local.json`
与插件 `hooks/hooks.json`，**不读 `.zcode/`**。
2026-09-19 之前只产 `.zcode` 那一份 —— 结果**钩子在本 harness 下从未触发过**，
而 `doctor.py` 还报绿（用插件自己的 schema 自证，属假绿，已修）。

⚠️ **为什么必须写绝对路径**：早期版本用 `${ZCODE_PROJECT_DIR}/../novel-writing/hooks/...`，
那个相对路径只有在「工作区根目录 = `novel/`」时才解析得出来。打开某本书时它指向
`<书>/../novel-writing/`（不存在）→ **钩子静默失效，且毫无报错**。
绝对路径与工作区打开位置无关，所以打开库根或打开书根都能生效。

> 钩子脚本自己从「被写文件的路径」反推书根（`hooks/after_chapter_write.py` 的 `find_book()`），
> 所以配置里**不需要**传 `--root`。
> 若你自己改过某本书的钩子配置，`sync.py` 不会覆盖它（视为本书定制）。

## 换机器 / 插件挪位置后要做什么

`book.json` 里 `vault` 写的是 `$PLUGIN/assets` 而不是绝对路径——
所以插件挪了位置之后，只要重跑一次同步，所有书的 `AGENTS.md` 会重新渲染成正确路径：

```bash
python "<插件>/scripts/sync.py" --all --lib "<作品库根目录>"
```

各书的 `tools/` 薄壳里存的是插件的绝对路径。**插件挪了位置也要重跑同步**，
否则薄壳会指向旧位置。

> 一句话：**插件挪位置 → 跑一次 `sync --all`。**
> 若各 harness 是用 `--link` 装的，junction 里存的也是旧路径，还要再跑一次
> `install.py --all --link` 重建链接。

## 目录说明

```
novel-writing/
├── SKILL.md              入口（agent 读这个决定怎么用）
├── README.md             给人看的说明
├── .codebuddy-plugin/    插件清单（供识别为插件而非裸技能）
├── scripts/              ★ 工具真身（与书无关）
│   ├── kit.py            共享模块
│   ├── init_book.py      新书初始化
│   ├── brief.py / consistency_check.py / state_sync.py
│   ├── ledger.py / preflight.py / watch_and_check.py
│   ├── sync.py           生成各书的 AGENTS.md 与 tools/ 薄壳
│   ├── selftest.py       插件自检
│   ├── bundle_vault.py   从 writing-vault 重新打包规则与技能
│   └── install.py        安装到各 harness
├── docs/                 分阶段手册（00 总览 … 13 版本控制，按需加载）
├── templates/            新书骨架模板（SOLOENT.md / canon.md / ledger.tsv / now.md …）
├── assets/               打包进来的库与配置模板
│   ├── rules/            打包的规则（14 个）
│   ├── skills/           打包的技能（12 个）
│   ├── workflows/        打包的工作流（7 个）
│   ├── book.example.json 配置模板
│   ├── AGENTS.template.md 运行守则模板
│   ├── hooks.config.example.json
│   └── _bundle.json      打包来源与时间
└── hooks/                可选钩子
```

> 支撑目录名沿用 **SoloEnt 官方约定**（`templates/` · `docs/` · `scripts/`）。
> 部分 harness 把后两个叫 `references/` 与 `assets/`——名称只是约定，
> `SKILL.md` 按显式路径引用，两套都能用。

## 更新插件

| 改什么 | 怎么做 | 影响 |
|---|---|---|
| 规则 / 技能 | 改 `writing-vault` → 跑 `bundle_vault.py` | 所有书 |
| 流程 / 纪律 | 改 `assets/AGENTS.template.md` → 跑 `sync --all` | 所有书 |
| 工具逻辑 | 改 `scripts/` | 所有书，立即生效 |
| 某本书的正典/数值/账本 | 改该书 `book.json` | 那一本 |
| 本书专属文风 | 改该书 `.soloent/rules/story-style.md` | 那一本 |

改完之后要不要重装，取决于安装形态：

| 形态 | 改完插件源码 |
|---|---|
| **链接（junction）** | **什么都不用做**——各 harness 看到的就是源目录本身 |
| 复制 | 必须逐一重装，否则各 harness 停留在旧版本 |

```bash
python "<插件>/scripts/install.py" --all          # 复制模式下重刷所有副本
```
