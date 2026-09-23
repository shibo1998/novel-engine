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
| `recordFeedback` | `(i: FeedbackInput) => Promise<{candidates: string[]}>` | 写 `_candidates/` |

编排层扩展：`writeChapter` / `convergeChapter` / `applyGateResult` / `loadRules` /
`readSummaries` / `assembleLongContext` / `updateChapterSummary` / `isRetryable`。

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
  → worst==="clean" 停（★硬约束：不进 revise）
  → findings 为空 停（★硬约束：不进 revise）
  → buildPrompt(revise) → callLLM → 失败记录并停（llm-error，不吞不装成功）
  → 原子覆盖 ch-NN.md
```

CLI `generate` 的退出码：`clean/no-findings/max-rounds` → 0；`llm-error/draft-failed` → 1。

## 7. recordFeedback 安全边界

行级 LCS diff（机械聚合，不走 LLM）→ 候选写入 `.soloent/rules/_candidates/<date>-ch-NN.md`。
**不直接写生效规则、不动 book.json**；人工审阅后手动提升到 `author` 清单才生效——
防自我强化错误，且可复盘「哪条规则从哪来」。

## 8. 决策记录（不可改）

| 决策 | 理由 |
|---|---|
| Python 检查器不重写，子进程调用 | 已投入，重写无收益 |
| state 是派生缓存，正文不入 JSON | 索引与内容分离；丢了能重建 |
| LLM 手写薄 HTTP，不用官方 SDK | 换厂商只改 env |
| rules 显式声明，不扫目录 | 可复盘「第 N 章用了哪版规则」 |
| 契约适配在 Python 侧 | 契约单点，加检查器不改核心 |
| recordFeedback 写候选不写生效规则 | 防自我强化错误 |
| web 只调 server，不 import core | 防 CLI/Web 双轨漂移 |

## 9. 雷区（都真踩过）

| 雷 | 挡法 |
|---|---|
| 火绒等外部进程批量删文件 | 信任区；`git restore` 恢复前**先确认无未提交修改** |
| tsc 报错仍 emit 污染 src/ | `noEmitOnError: true`；git add 前看 status |
| paths→包外源码与 rootDir 冲突（TS6059） | cli 不走 paths；dist 单轨 + 根 typecheck 先 build |
| Windows vite 只绑 IPv6 ::1 | `server.host = '127.0.0.1'` |
| 换行符口径（Py 统一翻译 vs Node 原样） | 比对前归一 `\r\n`→`\n` |
| 字数口径 | JS/Python 都吃 `\u3000`、都按码点，写死一处 |
| 嵌套 pnpm 被 fnm 坏垫片截胡 | PATH 顺序；坏垫片 `fnm/.../installation/pnpm.CMD` 待删 |
