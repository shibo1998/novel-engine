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

## 快速开始

```bash
corepack pnpm install
corepack pnpm -r build          # 根 typecheck 已内嵌先 build 再检查

# LLM 凭据（只走 env，绝不写入 book.json）
export LLM_BASE_URL=https://your-endpoint/v1
export LLM_API_KEY=sk-...
export LLM_MODEL=your-model

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
| `init --dir <目录> --title <书名>` | 开新书骨架（book.json 一次通过机检校验；非空目录拒绝） |
| `write --book <书根> --chapter <n>` | 起草一章（draft 流水线） |
| `generate --book <书根> --chapter <n>` | 收敛循环：缺章先起草，gate→revise 至 clean |
| `prompt --book <书根> --chapter <n> [--mode revise] [--dump]` | 预览 PromptBundle |
| `gates --book <书根> [--write]` | 跑检查器；默认只读预览，--write 回填 gateStatus |
| `state --book <书根> [--rebuild] [--set <json>]` | 读/写/重建章节索引 |
| `feedback add --book <书根> --chapter <n> --file <改后稿>` | 落 `.soloent/feedback.jsonl` + diff 聚合规则候选到 `_candidates/` |
| `novel --help` | 完整参数 |

## server 端点（:4319，可用 NOVEL_SERVER_PORT 改）

`GET /state?bookRoot=` ｜ `GET /chapter?bookRoot=&file=` ｜ `POST /prompt` ｜ `POST /write` ｜ `POST /gates`（body 带 `write:true` 回填）

## 关键边界（不可违反）

- `state/story.json` 是**派生缓存**：真相源只有 `chapters/*.md` 和 `.soloent/book.json`，丢了能重建
- **正文永不入 JSON**；JSON 只存索引与摘要
- core 六函数**无副作用**；写盘集中在编排层（CLI / server / generate）
- rules **显式声明**（book.json 的 `rules.author`/`plugin`），不扫目录；声明了但文件不存在 → `RuleFileMissing`
  - 排查「改了规则没效果」用 `auditRules`：会列出 `rules/` 下（含子目录）**文件在但没声明**的项，那些等于没加载
- recordFeedback 写两处：`.soloent/feedback.jsonl`（**唯一不可重建的人工数据**，追加式，永不整份替换）+ `_candidates/` 候选（派生，可重生成）
- `feedback.jsonl` 不放 `state/`：那目录的语义是「随时可清空重建」，而改稿记录丢了就永远没有
- 门禁状态带**内容指纹** `checkedMtimeMs`：检查时刻的文件 mtime。内容变了、指纹不匹配 → 该章状态自动置 null（过期好过假绿）
- `hook.ts` 的锚词校验**只报线索不当结论**：实测证实「细纲标意图、正文写变体」，词面匹配在这个粒度不可靠，红灯 ≠ 没留钩子

详见 [docs/ne-架构与契约.md](docs/ne-架构与契约.md)。
