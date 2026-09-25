# BACKLOG · 要做但暂未做的功能

> 规矩：凡是决定「推迟 / 拆分 / 降级」的功能，同一轮内登记到这里。完成后移到文末「已完成」，不删除。
> 字段：编号｜内容｜来源｜为什么暂缓｜前置依赖

## 进行中

（空）

## 由 B-11 拆出的后续项

| # | 内容 | 暂缓原因 | 依赖 |
|---|---|---|---|
| B-64 | Judge 假红率标定：对《高武》已写章跑一遍，人工抽查原 16 条词面红灯（P0-1 验收：假红率 < 20%） | 需真调模型、需人工抽查；标定完才知道能否把 `fail` 从「中等」升格为常规拦截 | — |
| B-70 | `plan draft`（各层 LLM 起草）的确定性测试 | **回放已落地（B-26），现在可以做**；原 B-59 | — |

## 由 B-12～B-15 拆出的后续项

| # | 内容 | 暂缓原因 | 依赖 |
|---|---|---|---|
| B-66 | 「守卫零调用者」静态检查：列出 core 导出但在 apps/ 无引用的函数，纳入 test（docs/24 P2-3） | 本轮没做；但它是本项目的**病根检查器**——style_doc_issues / hook_check / checkPlanGate 三次同源，都靠人肉发现 | — |
| B-67 | `gates/watch_and_check.py` 未接入 `kit.run_main` | 它是 watcher 不是 gate，退出码语义暂未统一；但同属「外部进程」这条线，早晚要对齐 | — |
| B-68 | 定点修订的改动量上限（条数 ≤12、替换字符 ≤50%）是硬编码常量，未做成 book.json 可配 | 先按默认值跑，拿到真书数据再决定要不要暴露；现在就暴露等于猜阈值 | B-64 |
| B-69 | human-needed 的**交接清单**只进 stderr 与报告 JSON，未落盘成文件 | 批量跑中断后，「上次卡在哪几条」得翻日志；落一份 `state/handoff/ch-NN.md` 更合用 | — |

## 由 B-10 拆出的后续项

| # | 内容 | 暂缓原因 | 依赖 |
|---|---|---|---|
| B-58 | 定位层同步 `book.json` 的 `book` 段（v0.2 M8.0 表格写明产物 = `book.json` 的 book 段 **+** `book/premise.md`） | 当前只写 `premise.md`；`book` 段（题材/平台/读者）仍要手改 book.json，与「定位问答一次问全」有落差 | — |
| B-59 | → 已并入 B-70（回放落地后可做） | — | — |
| B-60 | `novel init` 一并建 `plan.json`（或加 `--plan` 开关） | 现在新书要额外跑 `novel plan init` 才进逐层流程，两步容易漏；但存量书重跑 init 会被拒，需先想清迁移 | — |
| B-61 | 文档写明「`PUT /chapter`（人工改稿）**刻意**不设闸门」 | 不写下来，日后会被当成漏接的漏洞来「修」，反而挡掉作者的正常改稿 | — |
| B-62 | `preflight` 在风格闸门**抛错**时（如 book.json 结构非法）不输出任何 JSON | 既有行为：`Promise.all` 里 runStyleGate 抛错 → 整个 action 抛出，脚本/面板拿不到 planGate；已咬到本次冒烟验证 | — |

## 由 B-01/B-02 拆出的后续项

| # | 内容 | 暂缓原因 |
|---|---|---|
| B-03 | 状态卡建议的「一键采纳」命令 | now.md 含闸门校验的状态块与 `[流程]` 留痕，自动覆盖有破坏风险；需先做结构化合并（只替换叙述小节） |
| B-04 | revise 模式也注入状态卡 | 修订 prompt 属「现有提示词」，按规矩需作者确认后再加 |
| B-05 | B-02 只用细纲**人名/地名**做关键词（现为细纲全文 bigram，含「本章」「钩子」等噪声词） | 需要实体表（人物卡/canon 结构化），依赖 B-20 或人物卡规范 |
| B-06 | `write`/`generate` 提交后自动跑 `summarize --state-card` | 每章多一次 LLM 调用，先观察建议质量 |

## 待做 · 高优先

**（空）** —— B-10 ～ B-15 全部落地（见文末「已完成」）。下一批候选见上表 B-66 与「待做 · 中优先」。

## 待做 · 中优先

| # | 内容 | 来源 | 暂缓原因 | 依赖 |
|---|---|---|---|---|
| B-24 | 两步提交 + 快照型 checkpoint + resume + rollback | v0.2 M4.4–4.6 | — | B-13 |
| B-25 | 文件锁（pid + 时间戳，陈旧锁可接管） | v0.2 M4.7 | — | — |
| B-26 | `replayLLM` 录像回放，离线确定性测试 | v0.2 M7.6、X6 | — | — |
| B-27 | 成本统计与预算上限（单章/全书），超限停下 | v0.2 M7.7、X1 | — | — |
| B-28 | `rules adopt`：采纳 `_candidates/` 规则候选 | docs/24 P3-1 | — | — |
| B-30 | 爽点/钩子枚举表（§6 C1/C2）校准：跑完一卷后用 stats 数据修订；联网调研补充 | v0.2 §6 | 本次联网搜索 429 失败 | B-29 |
| B-31 | 评测集：10 章「蓝图 + 人工好稿」+ 故意植入设定冲突的章节集，度量 J3 检出率 | v0.2 X7、附 A | — | B-11 |

## 待做 · 低优先

| # | 内容 | 来源 |
|---|---|---|
| B-40 | Planner 滚动展开卷纲/细纲的自动生成（Premise/Compass/expandVolume/reviseCompass） | v0.2 M8 |
| B-41 | 设定变更影响分析 + 人工圈定 + 顺序定点重写 | v0.2 L3 |
| B-42 | 完本流程：wrapUp、伏笔回收率/成长线完整性报告 | v0.2 L2 |
| B-43 | Arbiter（四类封闭裁定，默认交人，自洽采样） | v0.2 M13 |
| B-44 | Server 长任务 202 + SSE、`POST /edit`、Last-Event-ID 补发 | v0.2 M17 |
| B-45 | Web：时间轴/阅读器/人工介入清单/Findings 跳转、虚拟滚动、SSE 降级 | v0.2 §8 |
| B-53 | Python 检查器逐个迁移到 TS | docs/24 P1-3 |
| B-54 | 收拢三套系统：停用 webnovel-writer 插件钩子、合并 STORY_RULES 重复条目 | docs/24 P1-1 |
| B-57 | 研究参考项目：Word Compiler（三环上下文）、SAGA、StoryWriter、DeepWriter-Bench | 调研 docx |

## 明确不做（留档防重复讨论）

| 内容 | 理由 |
|---|---|
| LangGraph / Celery / PostgreSQL+Neo4j+Qdrant / 多租户 JWT / K8s | 单用户文件为真相路线，规模不匹配 |
| 改设定后自动同步全部记忆并全局重写 | 与 L3 人工圈定冲突 |
| LoRA 风格微调 | 成本高，先用 few-shot |
| v0.1 M14 压缩管线 | buildPrompt 每次从零组装，不存在旧消息 |
| 爽点强度自动打分、以爽点类型硬拦截 | 无可靠判据 |
| **成本统计仪表（B-27 的「按单价累计 costUsd」部分）** | **作者偏好（USER.md）：能在模型后台看到消耗，不需要工具再统计一遍。** 且单价表要猜，猜出来的阈值不可信。**保留**的只有客观的**调用数闸**：`novel book --max-llm-calls`（已有）——那是防烧钱的保险，不是记账 |

## 已完成

| # | 内容 | 完成于 |
|---|---|---|
| B-01 | 当前状态卡：`buildPrompt` draft 模式追加 `now.md`（读 `book.json` 的 `paths.now`，缺省 `.soloent/memory/now.md`；上限 3000 码点；文件缺失或仍是「（待填）」占位则不注入）；`summarize --state-card` 产出建议到 `state/now.proposed.md`，**绝不覆盖 `now.md`**，作者手工合并 | 2026-09-25 · 6ba2813 |
| B-02 | 相关摘要检索关键词 = 上一章末尾 ∪ 本章细纲全文 bigram（`assembleLongContext` 第 4 参 `outlineText`） | 2026-09-25 · 6ba2813 |
| B-10 | 逐层递进建书（定位 → 设定 → 总纲 → 卷纲 → 细纲）+ 每层确认闸门；`novel plan init/status/position/draft/confirm`；`assertPlanReady` 接进 generate/book/CLI write/server `/write`·`/generate`·`/preflight`。顺带修掉 CLI `novel write` **一道门都没有**的旁路。未开启逐层流程的书恒为就绪（旧书不连坐） | 2026-09-25 · a73bd75 |
| B-11 | 语义判据层 Judge（J1 蓝图契约 / J2 章末钩子 / J3 连续性）：证据引句命不中即降 `unsure`（防幻觉，原判留 `rawVerdict`）；判据定义在 `.soloent/judges/`、`book.json` 的 `judges.enabled` 显式声明（未声明 → 显式报错，不退化成「0 条 = 全绿」）；`novel judge --chapter N [--advisory] [--write]` + `--list/--scaffold/--status`；结论落 `state/judge.json`（绑内容指纹，过期即作废）。详见 `docs/26` | 2026-09-25 · 4605a54 |
| B-12 | 收敛循环改为「定点修订 ≤2 → 整章重写 ≤1 → **停下等人**（`human-needed` + 交接清单）」；定点修订按 quote 局部重写，三条守卫（引句定位不到跳过 / 空替换跳过 / 改动量超限整批放弃）；**顺带落掉 B-63**：Judge 与 gates **不合表、只合「决策输入」**（各自落盘，循环取并集） | 2026-09-25 · cd46d85 |
| B-13 | schema v2：`gateStatus` 指纹 mtime→**contentHash**（新增全项目唯一一份 `hash.ts`）、`needsReview`、`reviseCount`/`rewriteCount`、`generatedBy`；`migrateV1ToV2` **丢弃 v1 的绿**（不拿 mtime 给新格式背书）；`stripGateStatus` → `stripConclusions`（needsReview 也是结论） | 2026-09-25 · 754d132 |
| B-14 | Gates 退出码契约统一：`0` 跑完（结论只看 stdout JSON）/ `1` 崩溃 / `2` 环境或配置错；非 0 时 stdout 也给**结构化原因**；新增「非 0 却吐完整 GateResult → 报契约违规」的失败关闭守卫；CLI 顶层 catch 按 v0.2 M16 从 1 改 2 | 2026-09-25 · 61a2e0f |
| B-15 | CLI 子进程冒烟测试（8 项，`apps/cli/test/`）+ gates 检查器回归固件（9 项，`gates/tests/`，**用标准库 unittest 而非 pytest**）；固件经 `gates-python.test.ts` 接进 `pnpm -r test`，缺 Python 时跳过而非假绿 | 2026-09-25 · 289f410 |
| B-63 | （随 B-12 落地）Judge 结论与 `gateStatus` 的合并语义：**不合表，只合「决策输入」**——两者不查同一项（M10.5），各自落各自的盘，循环时取并集当拦截集。信息不丢、口径不混 | 2026-09-25 · cd46d85 |
| B-26 | `replayLLM` 录像 / 回放：`NOVEL_LLM_RECORD_DIR` / `NOVEL_LLM_REPLAY_DIR`，按 `contentHash(model+system+user)` 取；**未命中失败关闭不回退真调**、**录像脱敏**、**回放不需要密钥** | 2026-09-25 · 6696c6c |
| B-65 | `judgeChapter` 全链路确定性测试（prompt→调用→解析→引句核对→落盘），靠 B-26 的回放 | 2026-09-25 · 6696c6c |
| B-28 | `rules adopt`：把改稿候选采纳进生效规则（移到 `rules/` → 声明进 `book.json` → `feedback.jsonl` 记账）；★**拒绝采纳未改写的机械 diff**（否则每章往 prompt 塞一份 diff）；拒绝覆盖已有规则文件；`novel rules candidates` 列候选 | 2026-09-25 · 见下 |
| B-66 | 「守卫零调用者」静态检查 `tools/find-orphan-exports.mjs` + 3 项测试（含夹具自检与突变验证）；顺带把 `isPassingWorst` 接成 `assertStoppedConsistent` 自检 | 2026-09-25 · b556854 |
| B-62 | `preflight` 闸门抛错时仍吐 JSON，且与「没就绪」**不同形**（`error` vs `blocking`）；server 的 `/preflight` 补 `styleGate` | 2026-09-25 · be5c7fa |
| B-67 | `gates/watch_and_check.py` 接入 `kit.run_main`——`gates/` 三个入口同一套退出码语义 | 2026-09-25 · be5c7fa |
| B-58 | 定位答案同步进 `book.json` 的 `book` 段（映射表外的 id 不写；先落 premise.md 再同步，真相源不陪葬） | 2026-09-25 · 335577d |
| B-60 | `novel init` 默认一并建 `plan.json`（`--no-plan` 走旧路径）——否则「多跑一次 plan init」那步一定会漏 | 2026-09-25 · 335577d |
| B-68 | 定点修订改动量上限可配（`book.json` 的 `revise` 段）；非法值回退默认不抛错 | 2026-09-25 · d9607ba |
| B-69 | `human-needed` 的交接清单落盘 `state/handoff/ch-NN.md`；过闸即删（过期的清单不如没有） | 2026-09-25 · d9607ba |
| B-61 | 文档写明「`PUT /chapter` 刻意不设闸门」——README 关键边界 + 架构契约决策记录（不写下来日后必被当漏洞「修」） | 2026-09-25 · 0ea2b10 |
| B-56 | legacy 手册归档到 `docs/legacy/`（`docs/legacy-README.md` → `docs/legacy/README.md`，同 SKILL） | 2026-09-25 · 见下 |
| B-55 | `content/` 清理**清单**已出（`docs/28-content清理清单.md`）：建议删 `oc-kaleidos`+`oc-kosmos`（642K）+`weekly-meme-report`（44K）；`wuhang-*` 列出但**不建议删**（与 `plan`/`write` 功能重叠属 B-54）。★**未删任何文件，等作者确认** | 2026-09-25 · 见下 |
| B-51 | `novel commit` + 可选自动提交：提交信息含章号（X5）；**不 push**（对外动作工具不做）；★不是 git 仓库 / 树干净 / 提交失败三种都返回 `committed:false` **且带原因**，绝不静默成功。`book.json` 的 `git.autoCommit` 默认 **false**（git 历史是作者的东西），开了才在收敛终态提交一次 | 2026-09-25 · 见下 |
| B-52 | 章号编号：新增 `naming.ts`（**宽度只在这里算**）；**读**兼容四位/两位/无填充（存量书是两位的，只认四位会让它们一个文件都读不到）；**写**仍用两位避免混合命名；`novel migrate-numbering` **默认 dry-run** | 2026-09-25 · 见下 |
| B-49 | 人物口吻字段（`voice.catchphrases` / `speechStyle`）：抽取时一并抽出（**抽不到就留空，不许编**），并由 J3 的参考材料注入——这是「口吻漂移」唯一可判据的来源（词面禁用词表做不到） | 2026-09-25 · 见下 |
| B-50 | 按用途选模型 `modelFor(purpose)`：`NOVEL_MODEL_{DRAFT,REVISE,JUDGE,SUMMARY,EXTRACT,PLAN}`，缺省回退 `LLM_MODEL`。★**起草与修订刻意不共用**——定稿质量取决于它们，不该被「省 token」顺手降级。回放指纹用**生效的**模型算 | 2026-09-25 · 见下 |
| B-23 | 伏笔台账 `state/foreshadows.json`：★**id 由引擎分配**（`f-001`，nextSeq 单调、回收不复用）；等级/计划回收章/放弃由**人**定（不可推导），同步只新增不覆盖；`paidOff` 销账，对不上的记进 `unmatchedPaidOff`（不许静默丢弃）；**逾期读时派生**；core 逾期 → 交人 | 2026-09-25 · 见下 |
| B-22 | 结构化反查 `novel lookup character\|timeline\|conflicts`（只读）：角色出场史+状态变化、时间线（按章区间/参与人过滤）、事实层矛盾（只报**机械可判**的，如「已记死亡又出现」）。★报**抽取覆盖率**——「没记录」≠「没出场」 | 2026-09-25 · 见下 |
| B-21 | 角色 history：`characterHistory()` 按章升序返回状态变化史（每章快照即 history）。★「改设定后定点重写旧章」仍未做 → 见 B-41 | 2026-09-25 · 见下 |
| B-20 | `novel extract`：每章抽人物状态/伏笔/时间线，事实带 `sourceChapter` 与**内容指纹**；★**引句命不中正文即整条丢弃**（比 Judge 更严——这些事实会喂给后续 prompt）；按章覆盖（撤回重抽 = 删该章记录）；`--character <名> --chapter <n>` 查「截至第 N 章」的状态 | 2026-09-25 · 见下 |
| B-46 | `duplicate_check` 查重闸门：跨章整句重复（≥12 字，报在**后出现**那章）中等；章内短语重复（10 字 ≥3 次）轻微。阈值可配，默认取「明显不像巧合」的下界 | 2026-09-25 · 见下 |
| B-47 | `sensitive_check` 敏感词闸门：★**词表没配 = 本项未生效**（payload 带 `not_effective` + 原因），绝不当成「扫过且干净」；**不内置词表**（会过期，比没有更危险）。`novel gates --gate` 新增，且**书级闸门拒绝 `--write`** | 2026-09-25 · 见下 |
| B-70 | `plan draft` 全链路确定性测试（靠 B-26 回放）：草稿逐字一致、零网络请求、**只写 `state/drafts/` 不碰正式文件**、上游未确认时**在调模型之前**拒绝 | 2026-09-25 · e5cb251 |
| B-29 | `novel stats`：★北极星 = **人工改稿行数/千字**；机器返工次数、gates 与 Judge 通过率、needsReview 计数。**不含成本统计**（作者偏好）。没数据时是 `null`/「没有数据」而**不是 0** | 2026-09-25 · 见下 |
| B-25 | 书级写锁：`{pid, host, label, at, token}`；**陈旧锁可接管**（pid 不在 / 锁龄超 30 分钟）；**同进程可重入**（convergeChapter→writeChapter 不自挡）；release 只认自己的 token。★锁放在 `writeChapter`/`convergeChapter` **内部**而非各入口接线（B-10 的教训）。`novel lock status\|release` | 2026-09-25 · 见下 |

> 随 B-01/B-02 一并修掉的基建缺陷：`packages/core` 的 `test` 脚本是**硬编码文件清单**，
> 新增的 `test/memory-context.test.ts` 没被登记 → 实际只跑 55 项，B-01/B-02 的 4 项测试
> 从未执行过。已改为 `"test/**/*.test.ts"`。（此类「测试在但不跑」的坑与 B-15「测试基建」
> 同类，登记为教训。）当前全量：core 179 + cli 16 = **195 项全绿，0 跳过**
> （gates 检查器固件已增至 **19 项**，覆盖 4 个检查器）
> （另含 gates 检查器的 9 项 Python 固件，经 `gates-python.test.ts` 一并跑）。
