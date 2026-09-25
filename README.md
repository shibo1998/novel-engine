# novel-engine

中文长篇小说创作**引擎**：从 `novel-writing`（md 资产 + Python 检查器的 agent 插件）演进为
「headless 内核 + CLI + Web」的应用形态。一个内核，两个外壳，不再有两条轨道漂移。

## 架构

```
packages/core   @novel/core — headless 内核（零 UI 依赖、零运行时依赖）
                buildPrompt / callLLM / runGates / readState / writeState / recordFeedback
                + writeChapter / convergeChapter / applyGateResult / loadRules / summaries
apps/cli        @novel/cli  — 命令行外壳（commander，stdout 只吐 JSON）
apps/server     @novel/server — node:http 零依赖薄服务（浏览器跑不了 Python，必须有它）
apps/web        @novel/web  — Vite + React + React Query，只调 server，不 import core
gates/          Python 检查器（读 md、stdout 吐 JSON、禁止改文件）
tools/          通用 Python 工具（4 py + 3 ps1）
content/        skill 素材、docs/08 引用的脚本、迁移文档资产
docs/           旧 kit 的 20 本手册（legacy 参考；新仓契约见 docs/ne-架构与契约.md）
state/          预留状态目录（书级 state 在各书根目录下）
```

书的数据**不在仓库内**：每本书有自己的 `<bookRoot>/`（chapters/ + .soloent/ + state/）。

## 配置（环境变量 **或** 用户级配置文件）

★**LLM 凭据绝不写入 `book.json`**（那是书的配置，会进版本控制）。
配置有两种方式，**环境变量优先**，两者都配时 env 赢。

### 方式一（推荐给「不想每次 export」的人）：用户级配置文件

路径：`~/.novel-engine/config.json`（即 `C:\Users\<你>\.novel-engine\config.json`，可用 `NOVEL_CONFIG_FILE` 改）。

```json
{
  "baseUrl": "https://your-endpoint/v1",
  "apiKey": "sk-...",
  "model": "your-model",
  "models": { "judge": "更小更便宜的模型", "summary": "..." }
}
```

★**为什么放在用户主目录、而不是仓库里**：里面有 API key。
放主目录就不在任何 git 仓库内，**从根上消掉被 `git add -A` 误提交的可能**；
工具若发现配置文件落在某个 git 仓库内会警告一次。
★**工具绝不替你写这个文件**（没有 `config set`）——写密钥到磁盘的动作必须由你自己做。

### 方式二：环境变量（CI / 测试 / 临时切换）

```bash
export LLM_BASE_URL=https://your-endpoint/v1   # OpenAI 兼容端点
export LLM_API_KEY=sk-...
export LLM_MODEL=your-model
```

⚠️ **注意变量名没有 `NOVEL_` 前缀**——就是 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`。
也不支持 `.env` 文件（不引 dotenv）。

### 可选：按用途换模型（省 token）

不给就都用 `LLM_MODEL`（或配置文件里的 `model`）。★**起草与修订刻意不共用**——
定稿质量主要取决于这两步，不该被「省 token」顺手降级；蓝图起草反而建议更大。

| 用途 | 环境变量 | 配置文件键 | 建议 |
|---|---|---|---|
| 起草正文 | `NOVEL_MODEL_DRAFT` | `models.draft` | **别调小** |
| 定点修订 / 整章重写 | `NOVEL_MODEL_REVISE` | `models.revise` | **别调小** |
| 语义判据（判对错） | `NOVEL_MODEL_JUDGE` | `models.judge` | 可小 |
| 摘要 / 状态卡 | `NOVEL_MODEL_SUMMARY` | `models.summary` | 可小 |
| 事实抽取 | `NOVEL_MODEL_EXTRACT` | `models.extract` | 可小 |
| 逐层蓝图起草 | `NOVEL_MODEL_PLAN` | `models.plan` | 建议更大 |

### 其它环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `NOVEL_LLM_RETRY_ATTEMPTS` | `1` | 传输失败的重试次数；`0` = 不重试（自测/离线用） |
| `NOVEL_LLM_BREAKER_THRESHOLD` | `3` | 连续失败几次后熔断 |
| `NOVEL_LLM_BREAKER_COOLDOWN_MS` | `60000` | 熔断后冷却多久 |
| `NOVEL_GATE_TIMEOUT_MS` | `4000` | 检查器子进程超时 |
| `NOVEL_LLM_RECORD_DIR` | — | 录像：把每次请求/响应脱敏落盘 |
| `NOVEL_LLM_REPLAY_DIR` | — | 回放：不碰网络，按请求指纹取录制结果（**离线确定性测试**用） |
| `NOVEL_PYTHON` | `python` | 检查器用的 Python 解释器 |

配完自检：`novel preflight --book <书根> --chapter 1`（只报风格层是否就绪，**不消耗 token**）。

## 快速开始

```bash
corepack pnpm install
corepack pnpm -r build          # 根 typecheck 已内嵌先 build 再检查

# LLM 凭据见上方「配置」一节（只走 env，绝不写入 book.json）

# 开一本新书
node apps/cli/dist/index.js init --dir "D:/path/to/新书" --title "书名" --genre 都市 --platform 番茄

# 写第 1 章（LLM 失败不落盘、不改 state）
node apps/cli/dist/index.js write --book "D:/path/to/新书" --chapter 1

# 收敛循环：过闸 → revise → 直到 clean（上限 3 轮）
node apps/cli/dist/index.js generate --book "D:/path/to/新书" --chapter 1

# Web 界面（两个进程）
node apps/server/dist/index.js                  # :4319
cd apps/web && node node_modules/vite/bin/vite.js   # :5319
```

## CLI 命令

| 命令 | 作用 |
|---|---|
| `init --dir <目录> --title <书名> [--no-plan]` | 开新书骨架（book.json 一次通过机检校验；非空目录拒绝）；**默认一并开启逐层流程**（建 `plan.json`），`--no-plan` 走旧路径 |
| `write --book <书根> --chapter <n>` | 起草一章（draft 流水线） |
| `generate --book <书根> --chapter <n> [--local-rounds n] [--rewrite-rounds n] [--no-judge]` | 收敛循环：缺章先起草 → **定点修订 ≤2** → **整章重写 ≤1** → 仍不过闸则**停下等人**（退出码 3，交接清单落 `state/handoff/`） |
| `prompt --book <书根> --chapter <n> [--mode revise] [--dump]` | 预览 PromptBundle |
| `preflight --book <书根> --chapter <n>` | 正典与 `outline/ch-NN.md` 准备情况（**只提示**）；另含**风格/红线层**与**逐层蓝图**两道闸门——任一未就绪则非 0 退出、阻断开写 |
| `plan init\|status\|position\|draft\|confirm` | 逐层递进建书：定位 → 设定 → 总纲 → 卷纲 → 细纲，**每层经作者确认才解锁下一层** |
| `judge --book <书根> --chapter <n> [--advisory] [--write]` | 语义审稿（J1 蓝图契约 / J2 章末钩子 / J3 连续性）；另有 `--list` / `--scaffold` / `--status`。**证据引句命不中即降 `unsure`** |
| `gates --book <书根> [--gate <名>] [--write]` | 跑检查器（缺省 `consistency_check`；另有 `sensitive_check` / `duplicate_check` / `style_doc_check`）；默认只读预览，`--write` 回填 gateStatus（**仅 `consistency_check`**——书级闸门 `chapter_count` 恒 0，接不上回填） |
| `state --book <书根> [--rebuild] [--set <json>]` | 读/重建章节索引；`--set` 可写数据字段，但**结论字段一律被摘掉**（`gateStatus` + `needsReview`；绿只能由 `gates` 跑出来） |
| `summarize --book <书根> --chapter <n>` | 生成或刷新长篇上下文摘要 |
| `rules audit --book <书根>` | 检查规则文件遗漏声明或声明路径缺失 |
| `extract --book <书根> --chapter <n>` | 抽一章的事实（人物状态/伏笔/时间线）。★**引句命不中正文的条目整条丢弃**（会喂给后续 prompt，宁可少不可假）。另有 `--from/--to` 批量、`--status`、`--rollback <n>`、`--character <名>` |
| `foreshadow sync\|list\|set --book <书根>` | 伏笔台账：★**id 由引擎分配**（`f-001`，模型不得自造）；等级/计划回收章/放弃由人定；**逾期按当前进度读时现算** |
| `lookup character\|timeline\|conflicts --book <书根>` | 结构化反查（只读）：角色出场史与状态变化、时间线、事实层矛盾提示。★会报**抽取覆盖率**——「没记录」≠「没出场」 |
| `checkpoint list\|commit\|resume\|restore\|rollback\|prune\|journal --book <书根>` | 两步提交与快照回退。★`resume` 按**目标指纹**判定「补完还是回退」；★`restore` 对**来历不明**的 state 拒绝覆盖；★`rollback` **不改正文**（那由书仓 git 回退） |
| `eval --book <书根> [--dir <d>] [--judge <id>]` | 跑评测集度量 Judge 的**检出率/假红率**。评测集在 `<书根>/evals/<用例名>/`（`chapter.md` + `outline.md` + `expect.json`）。★**在临时目录里跑，不碰真书** |
| `arbiter kinds\|ask\|decide\|list --book <书根>` | 四类封闭裁定（走哪条线/波及面/怎么脱身/爽点派给谁）。★**默认交人**（不开 `--auto` 连模型都不调，exit 3）；★**候选集由调用方给全**，选到集外判无效；★`--auto` 时**自洽采样 3 次**，不一致仍交人；★**只选不写**（不生成正文） |
| `planner next\|compass\|expand --book <书根>` | 滚动展开：先 `compass`（基于**已写档案**校准总纲）再 `expand`（展**下一卷**）。★**顺序不可反**由形状强制（总纲没校准过就拒绝展开）；★**一次只展一卷**（远卷只留一行标题） |
| `style-anchor --book <书根> [--from <样板书目录>] [--write]` | 从实测样本提炼文风节拍，给出可粘贴的 `checks.rhythm` 阈值。★**判据不重写**（调用检查器的 `--suggest-rhythm`）；★没样本时**明确报错**不返回「指标全 0」；★`anchors/style.md` 是**锚点不是闸门**（改它不生效） |
| `impact --book <书根> --term <词> [--term ...]` | 设定变更影响分析（**只读**）。★人工圈定 `--chapters 3,7,12` 后加 `--rewrite --instruction "改成什么"` 才动手，且**按章号升序**逐章定点改 |
| `wrapup --book <书根> [--top <n>]` | 完本报告：伏笔回收率、角色成长线完整性、时间线收束。★**只报事实不评好坏**；所有比率都带「分母可信吗」（抽取覆盖率不满即进 blockers） |
| `commit --book <书根> [--chapter <n>] [--title <t>]` | 提交书目录改动（**不 push**）。不是 git 仓库 / 树干净时明说跳过。开 `book.json` 的 `git.autoCommit` 可在收敛结束后自动提交 |
| `migrate-numbering --book <书根> [--apply]` | 章号编号迁移 `ch-NN.md → ch-0001.md`。★**默认只出计划**，重命名会动 git 历史与习惯，是作者的决定 |
| `stats --book <书根> [--per-chapter]` | 全书度量：★北极星 = **人工改稿行数/千字**；机器返工次数、gates 与 Judge 通过率。**不含成本统计**（能在模型后台看） |
| `lock status\|release --book <书根>` | 书级写锁的查看与强制释放（锁由 `writeChapter`/`convergeChapter` 自动获取） |
| `hooks --book <书根> [--all]` | 章末钩子锚词校验（**只读线索报告**：不计入拦截、不影响退出码，红灯须人工复核） |
| `feedback add --book <书根> --chapter <n> --file <改后稿>` | 落 `.soloent/feedback.jsonl` + diff 聚合规则候选到 `_candidates/` |
| `novel --help` | 完整参数 |

## server 端点（:4319，可用 NOVEL_SERVER_PORT 改）

`GET /state?bookRoot=` ｜ `GET /chapter?bookRoot=&file=` ｜ `PUT /chapter`（保存正文） ｜ `POST /prompt` ｜ `POST /preflight` ｜ `POST /write` ｜ `POST /generate`（收敛并返回门禁明细） ｜ `POST /gates`（回填并返回 findings） ｜ `POST /summarize` ｜ `POST /feedback` ｜ `POST /rules/audit`

新书的可选章纲路径为 `outline/ch-NN.md`（如 `outline/ch-01.md`）。存在时自动注入起稿提示词；缺失或正典仍含「待填」时会提示，但不会阻断自由起稿。

## 关键边界（不可违反）

- `state/story.json` 是**派生缓存**：真相源只有 `chapters/*.md` 和 `.soloent/book.json`，丢了能重建
- **正文永不入 JSON**；JSON 只存索引与摘要
- core 六函数**无副作用**；写盘集中在编排层（CLI / server / generate）
- rules **显式声明**（book.json 的 `rules.author`/`plugin`），不扫目录；声明了但文件不存在 → `RuleFileMissing`
  - 排查「改了规则没效果」用 `auditRules`：会列出 `rules/` 下（含子目录）**文件在但没声明**的项，那些等于没加载
- recordFeedback 写两处：`.soloent/feedback.jsonl`（**唯一不可重建的人工数据**，追加式，永不整份替换）+ `_candidates/` 候选（派生，可重生成）
- `feedback.jsonl` 不放 `state/`：那目录的语义是「随时可清空重建」，而改稿记录丢了就永远没有
- 门禁状态带**内容指纹** `checkedHash`（v2 起，取代 v1 的 mtime）：内容变了、指纹不匹配 → 该章状态自动置 null（过期好过假绿）。
  **全项目只有一种指纹**（`packages/core/src/hash.ts` 的 `contentHash`）——两个机制必然漂移
- 任何**不经检查就能写出「绿」**的路都必须堵掉：`novel state --set` 保留入口（fixture／迁移用途），但落盘前一律摘除**结论字段**（`gateStatus` + `needsReview`）——「绿」只能由 `gates` 跑出来
- **所有会产生新正文的入口用同一道前置闸门**：`write` / `generate` / `book` / server 的 `/write`·`/generate` / `preflight`。
  少挡一处就等于留了一条绕过路径（本项目已为此吃过多次亏）。两道闸门分别是**风格/红线层**与**逐层蓝图**
  - **不连坐旧书**：没有 `.soloent/plan.json` 的书，逐层闸门恒为就绪
  - ★`PUT /chapter`（人工改稿）**刻意不设闸门**——作者是权威。**别把它当成漏接的漏洞去「修」**，
    那会把作者本人挡在门外
- **gates 退出码只表示脚本有没有跑完**：`0` 跑完（结论只看 stdout 的 JSON）/ `1` 崩溃 / `2` 环境或配置错。
  非 0 一律当失败处理，**绝不允许读成「查了没问题」**。CLI 退出码：`0` 成功 / `1` 内容未通过 / `2` 环境或参数错误 / `3` 需要人工介入
- **判据结论与门禁结论分开落盘**（`state/judge.json` / `story.json` 的 `gateStatus`）：
  两者不查同一项（机械 gates 判词面、Judge 判意图），合成一个字段会丢信息；
  做决定时取**并集**当拦截集
- 章末钩子锚词校验（`packages/core/src/hooks.ts`，入口 `novel hooks`）**只报线索不当结论**：实测证实「细纲标意图、正文写变体」，词面匹配在这个粒度不可靠，红灯 ≠ 没留钩子。故它**不接 CI 硬失败**，只出只读报告

详见 [docs/ne-架构与契约.md](docs/ne-架构与契约.md)。
