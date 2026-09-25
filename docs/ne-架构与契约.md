# novel-engine 架构与契约（以仓内代码为唯一准）

> 本文描述**当前仓内已实现**的契约。docs/ 下 00–19 编号手册是旧 kit 的 legacy 参考；
> 凡两处冲突，以本文与代码为准。规格书 PART 3 仅作形状参考，已于 2026-09-23 裁定作废。

## 1. 内核函数（packages/core）

| 函数 | 签名要点 | 副作用 |
|---|---|---|
| `buildPrompt` | `(o: BuildPromptOptions) => Promise<PromptBundle>` | 只读 |
| `callLLM` | `(b: PromptBundle, o?: CallLLMOptions) => Promise<LLMResult>` | 网络 |
| `runGates` | `(o: RunGatesOptions) => Promise<GateResult>` | 子进程 |
| `readState` | `(o: ReadStateOptions) => Promise<StoryState>` | 只读（不写盘） |
| `writeState` | `(state: StoryState) => Promise<void>` | 原子写 |
| `saveChapterText` | `(o: {bookRoot, chapterNo, text}) => Promise<{file,text}>` | 原子保存正文，强制重建并落盘章节索引；旧门禁状态失效 |
| `recordFeedback` | `(i: FeedbackInput) => Promise<{candidates: string[]}>` | 追加 `.soloent/feedback.jsonl` + 写 `_candidates/` |

编排层扩展：`writeChapter` / `convergeChapter` / `applyGateResult` / `loadRules` /
`readSummaries` / `assembleLongContext` / `updateChapterSummary` / `isRetryable` /
`loadFeedback` / `auditRules` / `checkChapterReadiness` / `checkHookAnchor` /
`parseHookSpecs` / `auditHooks`。

### 1.1 写前准备与正文编辑

- `checkChapterReadiness(bookRoot, chapterNo)` 检查 `.soloent/canon.md` 与
  `outline/ch-NN.md`，只返回提醒，不阻断起稿；存在的章纲会注入 `buildPrompt` 的 draft/revise 提示词。
- `saveChapterText` 保存后立即强制重建 `state/story.json`，因此标题、字数会同步更新，已有 `gateStatus` 会清空，避免正文变更后继续显示假绿。
- 章纲采用每章一个 Markdown 文件：`outline/ch-01.md`、`outline/ch-02.md`……缺失时仍允许自由起稿，避免把准备工作变成创作硬阻塞。

### 反馈落点（2026-09-23 裁定）

`recordFeedback` 同时写两处，**不可合并**：

| 落点 | 性质 | 写法 |
|---|---|---|
| `.soloent/feedback.jsonl` | **唯一不可重建的人工数据** —— 丢了就永远没有 | 追加式，旧行永不改写；残行只可能是最后一行，读取时丢弃 |
| `.soloent/rules/_candidates/<date>-ch-NN.md` | 派生自 diff，可重生成 | 整份覆盖 |

**为什么不放 `state/`**：`state/story.json` 是可丢弃的派生缓存（从 `chapters/` 重建），
把唯一不可重建的数据放进「随时可以清空重来」的目录，是迟早会丢的。
放 `.soloent/` 与 `book.json`、`canon.md` 同级——那里是「作者给这本书的输入」。

反查用 `loadFeedback(bookRoot, {category, limit})`；`limit` 取**最近** N 条（尾部）。

## 2. 门禁契约（gates/ ↔ runGates）

- 检查器：`gates/consistency_check.py`，spawn 参数 `[gatePath, '--root', bookRoot]`
  （**位置参数无效**，会被当章节白名单，exit 2）。
- stdout 单行 JSON：
  `{gate, book_root, chapter_count, counts: Partial<Record<severity, number>>, findings: [...]}`
- `findings[]` = `{severity, chapter, line, check, detail}`；severity 中文四档
  **严重/中等/轻微/提示**（提示仅在书开 `gate.draft_free` 时出现）；`line: 0` = 整章级。
- **退出码语义：发现问题也返回 0**；非 0（exit 2）才是执行失败。`runGates` 按此判定，不得反转。
- 检查器零写文件（原版的 notes/ 报告与趋势 CSV 已移除）；人类可读输出全走 stderr。

## 3. 状态契约（state/story.json）

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "ISO8601",
  "bookRoot": "归一化绝对路径（path.resolve，平台分隔符）",
  "chapters": [{
    "chapterNo": 1,          // fileRegex 捕获组 1，按数值升序
    "file": "ch-01.md",      // 与 GateFinding.chapter 同键，直接对齐
    "title": "首行 H1 剥「第NNN章」前缀；无 H1 为空串",
    "wordCount": 3265,       // 全文件去空白后码点数（全项目唯一口径）
    "gateStatus": null | { "worst": "clean|提示|轻微|中等|严重", "count": 1,
                           "checkedAt": "ISO8601", "checkedMtimeMs": 1789636028300 }
  }]
}
```

- `readState` 三分支：缓存命中（schemaVersion+bookRoot 双校验）→ 返回；否则**内存重建不写盘**；bookRoot 非目录 → throw。
- **过期清扫**：返回前逐章 stat，`mtimeMs !== checkedMtimeMs` 或文件消失 → `gateStatus = null`（防「假绿」）。
- `writeState`：tmp→rename 原子写（Windows EPERM → `fs.rm` 后 rename）；写前归一（排序 + 刷 generatedAt + bookRoot 归一化）。
- `summaries.json` 同目录同哲学（`sourceMtimeMs` 指纹）；`updateChapterSummary` 是 LLM 挂点。

## 4. Prompt 契约（buildPrompt）

- `system = IDENTITY → canon.md → author rules → plugin rules`（顺序不可乱）。
- rules **显式声明**：book.json 的 `rules.author` / `rules.plugin`（相对 `.soloent/` 的路径，
  不扫目录、不递归；子目录文件须写全路径）。缺失文件 → 抛 `RuleFileMissing`。
  与旧 schema `{system, load, forbid}` **并存**，互不覆盖。
- `user`：draft = 书籍信息 + 既定标题 + prevTail（上一章文件尾 800 码点）+ 长文上下文段 + 要求；
  revise = findings 逐条（行号 0 渲染为「整章」）+ 当前正文。revise 不带 findings 立即 throw。
- 长文上下文段（4.9）：最近 2 章摘要 + 关键词（二字 bigram 重合）相关 2 章摘要，
  总上限 `CONTEXT_CHAR_CAP = 4000` 码点；无摘要时显式标注「暂无」。
- `ruleRefs: {author, plugin}` 回报告**实际加载**清单（缺失先 throw，声明==加载由构造保证）。

## 5. LLM 契约（callLLM）

- env：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`；缺失 → `{ok:false, kind:"config"}`。
- OpenAI 兼容端点 `${base}/chat/completions`；60s 超时；外部 signal 合并。
- **错误归一 union，全程不 throw 裸 Error**：`config / timeout / http{status} / parse`。
- **重试分类（定死）**：`timeout` 与 `http 5xx` 可重试；`parse` / `config` / `http 4xx` 不可
  （`isRetryable()`）。内部对可重试错误退避 1s 重试 1 次。

## 6. 收敛循环（convergeChapter，4.5）

```
缺章 → writeChapter 起草（失败即停 draft-failed）
每轮（≤3）：runGates → applyGateResult 回填落盘
  → ★自检：worst==="clean" 与 findings 为空必须同为真（不一致即 gate-inconsistent 停，
    那是回填/聚合的键对不上，属程序 bug，不许当成「没问题」放过去）
  → 无「拦截级」发现（严重/中等/轻微）即停：
     · 一条发现都没有 → stopped="clean"
     · 只剩提示级 → stopped="clean-advisory"（提示只报告，不驱动改写轮）
  → buildPrompt(revise，只带拦截级发现) → callLLM → 失败记录并停（llm-error，不吞不装成功）
  → 原子覆盖 ch-NN.md
```

CLI `generate` 的退出码：`clean/clean-advisory/max-rounds` → 0；`llm-error/draft-failed/gate-inconsistent` → 1。
★「是否算过闸」的唯一判据是 `isPassingWorst(worst)`（失败关闭：只认 clean 与提示），
批量入口 `novel book` 据此决定是否接着写下一章——不要各自再写一套。

## 7. recordFeedback 安全边界

行级 LCS diff（机械聚合，不走 LLM）→ 候选写入 `.soloent/rules/_candidates/<date>-ch-NN.md`；
同一批改稿原文与改后稿追加写 `.soloent/feedback.jsonl`（落点理由见 §1）。
**不直接写生效规则、不动 book.json**；人工审阅后手动提升到 `author` 清单才生效——
防自我强化错误，且可复盘「哪条规则从哪来」。

## 7.1 规则「文件在但没声明」审计（`auditRules`）

`loadRules` 显式声明、**不扫目录、不递归**。子目录（如 `rules/active-plugin-rules/`）
里的文件必须在 `rules.author` / `rules.plugin` 里写全路径才会加载。

隐性故障：文件躺在盘上、声明里没有 → 一个都不生效，而 `buildPrompt` 照常成功、闸门照常全绿，
人只会觉得「改了 prompt 怎么没效果」。`auditRules` 把这个静默点变成可见：

- `undeclared`：文件在但没声明 = 等于没加载（`_candidates/` 按设计排除，那是待审候选）
- `missing`：声明了但盘上没有 = `loadRules` 会抛 `RuleFileMissing` 的那些

只读不抛错 —— 它的存在意义就是把静默变可见，自己不许成为新的静默点。

## 7.2 章末钩子锚词校验（`hooks.ts`）—— 边界比功能重要

**它只报线索，不当结论。** 实测对真书 34 章人工对账后确认：**细纲标的是「意图」，正文写的是「变体」**。

- 细纲 ch11「这台仪器前天刚校准」→ 正文「前天刚由省局技术处做过深度校准」：钩子留得更好，词面却对不上
- 细纲 ch17 对白是原话 → 正文把后半段整段重写

所以在「对白有没有被改写」这个粒度上，**词面匹配本质上不可靠**，调参无法收敛。据此定的纪律：

| 纪律 | 理由 |
|---|---|
| 红灯只当**人工复核入口**，不当结论 | 看到红灯先自己读末段 |
| **不接进 CI 硬失败** | 会把「作者有意改写」误杀成「质量缺陷」 |
| 锚词提炼只取引号内内容，剔除人名/叙述性文字 | 实测踩过：把人名当锚词 → 必然误报，红灯沦为噪音 |
| 匹配用**片段**而非整串全等 | 全等会因「都/都得」一字之差误报（实测 ch15） |
| 明确的语义判定只能靠人工读或 LLM | 那是另一个模块，不要伪装成词面校验 |

## 8. 决策记录（不可改）

| 决策 | 理由 |
|---|---|
| Python 检查器不重写，子进程调用 | 已投入，重写无收益 |
| state 是派生缓存，正文不入 JSON | 索引与内容分离；丢了能重建 |
| feedback 落 `.soloent/` 而非 `state/` | state 是「可清空重建」目录，feedback 是唯一不可重建的人工数据 |
| LLM 手写薄 HTTP，不用官方 SDK | 换厂商只改 env |
| rules 显式声明，不扫目录 | 可复盘「第 N 章用了哪版规则」 |
| 契约适配在 Python 侧 | 契约单点，加检查器不改核心 |
| recordFeedback 写候选不写生效规则 | 防自我强化错误 |
| web 只调 server，不 import core | 防 CLI/Web 双轨漂移 |
| 保存正文后强制重建 state | 章节标题、字数和门禁摘要都来自正文，不能依赖旧缓存 |
| 章纲缺失只提示不拦截 | 章纲能提高可控性，但硬拦会让临时创作和已有旧书无法继续 |
| `moduleResolution: NodeNext`（原 Bundler） | Bundler 不强制 `.js` 后缀，漏写靠人工 grep；NodeNext 由编译器强制，防双轨 |
| `summarizeGateResult` 同章多条 finding 取**最大**严重度并累加 count | 原实现是 `Map.set` 覆盖，`worst` 会退化成最后一条 |
| **`PUT /chapter`（人工改稿）刻意不设闸门**（B-61） | 作者是权威。风格层/逐层蓝图那两道门拦的是**机器生成**，不是拦人。把它也拦上是把作者本人挡在门外 |
| 逐层闸门只对**有 `plan.json` 的书**生效 | 存量书（高武、仙侠）没走过逐层流程，一律连坐会让它们再也写不了 |
| 判据结论落 `state/judge.json`，**不并进 `gateStatus`**（B-63） | `applyGateResult` 是**全量覆写**，并进去会被下一次机械 gate 静默冲掉；且两者不查同一项，压成一个 worst 会丢信息 |
| 收敛循环终态用 `human-needed`，**废弃 `max-rounds`**（B-12） | 「轮数用完但问题也不大」与「机器改不动了」是两种处境，共用一个名字会让读的人误判 |
| 定点修订的改动量超限 → **整批放弃**而不是逐条应用 | 超限说明这已不是「定点」而是「重写」，该走整章重写那条路；逐条应用会伪装成定点 |
| 证据引句必须逐字命中，命不中降 `unsure`（B-11） | 没有这条，模型可以随口说「第 5 段与设定冲突」而根本不存在那段——比没有判据更坏 |
| gates 退出码：`0` 跑完 / `1` 崩溃 / `2` 环境或配置错（B-14） | 非 0 只有一个含义：**本次没产出可用结论**。绝不允许读成「查了没问题」 |
| `contentHash` 只允许一份实现（`hash.ts`）（B-13） | plan 签字 / gateStatus / 判据结论三处若各写一份，必然漂移 |

## 9. 外壳接口

CLI 的新增入口是：

- `novel preflight --book <dir> --chapter <n>`：检查正典与本章章纲，输出 JSON 提醒。
- `novel summarize --book <dir> --chapter <n>`：调用 LLM 更新 `state/summaries.json`；失败返回非 0。
- `novel rules audit --book <dir>`：列出规则文件未声明或声明后缺失的项，只读不修改。
- `novel plan init|status|position|draft|confirm`：逐层递进建书，每层经作者确认才解锁下一层。
- `novel judge --book <dir> --chapter <n> [--advisory] [--write]`：语义判据（J1/J2/J3），
  证据引句命不中即降 `unsure`；另有 `--list`/`--scaffold`/`--status`。
- `novel book --book <dir>`：逐章跑完一本，任一章没过闸即停并报断点。
- `tools/find-orphan-exports.mjs`：列出 core 导出但生产代码零引用的符号
  （防「守卫在但零调用者」——本项目三次同源事故都是人肉发现的）。

Server 通过 `:4319` 提供对应能力：`PUT /chapter` 保存正文，`POST /preflight`、
`/summarize`、`/feedback`、`/rules/audit` 分别对应准备检查、摘要、改稿反馈和规则审计；
`POST /generate` 返回收敛结果、最终门禁发现、状态和准备提醒。Web 只通过这些 HTTP 接口工作，
正文编辑有未保存保护，保存后可显式记录改稿反馈。

## 10. 雷区（都真踩过）

| 雷 | 挡法 |
|---|---|
| 火绒等外部进程批量删文件 | 信任区；`git restore` 恢复前**先确认无未提交修改** |
| tsc 报错仍 emit 污染 src/ | `noEmitOnError: true`；git add 前看 status |
| paths→包外源码与 rootDir 冲突（TS6059） | cli 不走 paths；dist 单轨 + 根 typecheck 先 build |
| **改 core 源码不 rebuild，CLI 跑的是旧 dist**（双轨） | 实测确认存在：`console.log` 探针不出现。挡法：NodeNext 强制后缀 + 改 core 后必 `build`（或开 `tsc -b --watch`） |
| gate 脚本相对深度失配 → 只报「子进程启动失败」 | `gates.ts` spawn 前 `existsSync` 前置校验，报错带绝对路径 + 解析基准 |
| Windows vite 只绑 IPv6 ::1 | `server.host = '127.0.0.1'` |
| 换行符口径（Py 统一翻译 vs Node 原样） | 比对前归一 `\r\n`→`\n` |
| 字数口径 | JS/Python 都吃 `\u3000`、都按码点，写死一处 |
| 嵌套 pnpm 被 fnm 坏垫片截胡 | PATH 顺序；坏垫片 `fnm/.../installation/pnpm.CMD` 待删 |
