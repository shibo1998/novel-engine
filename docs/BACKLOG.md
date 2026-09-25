# BACKLOG · 要做但暂未做的功能

> 规矩：凡是决定「推迟 / 拆分 / 降级」的功能，同一轮内登记到这里。完成后移到文末「已完成」，不删除。
> 字段：编号｜内容｜来源｜为什么暂缓｜前置依赖

## 进行中

| # | 内容 | 来源 | 当前进度 |
|---|---|---|---|
| B-10 | 逐层递进建书（定位问答 → 设定 → 总纲 → 卷纲 → 细纲）+ 每层确认闸门 | v0.2 M8.0 | `packages/core/src/plan.ts` 已写（352 行：hash 确认/stale 判定/`checkPlanGate`/`draftLayer`），但**无 CLI 接线、无测试**，`checkPlanGate` 也未接进 write 流程；工作区未提交 |

## 由 B-01/B-02 拆出的后续项

| # | 内容 | 暂缓原因 |
|---|---|---|
| B-03 | 状态卡建议的「一键采纳」命令 | now.md 含闸门校验的状态块与 `[流程]` 留痕，自动覆盖有破坏风险；需先做结构化合并（只替换叙述小节） |
| B-04 | revise 模式也注入状态卡 | 修订 prompt 属「现有提示词」，按规矩需作者确认后再加 |
| B-05 | B-02 只用细纲**人名/地名**做关键词（现为细纲全文 bigram，含「本章」「钩子」等噪声词） | 需要实体表（人物卡/canon 结构化），依赖 B-20 或人物卡规范 |
| B-06 | `write`/`generate` 提交后自动跑 `summarize --state-card` | 每章多一次 LLM 调用，先观察建议质量 |

## 待做 · 高优先

| # | 内容 | 来源 | 暂缓原因 | 依赖 |
|---|---|---|---|---|
| B-11 | 语义判据层 Judge：J1 蓝图契约 / J2 章末钩子 / J3 连续性，证据引句防幻觉 | v0.2 M11、docs/24 P0-1 | 工作量 2–3 天 | — |
| B-12 | 收敛循环改为「定点修订 ≤2 → 整章重写 ≤1 → 停下等人」，修订按 quote 局部重写 | v0.2 M12.2 | 依赖 Judge | B-11 |
| B-13 | schema v2：gateStatus 指纹 mtime→contentHash、needsReview、修订计数、generatedBy | v0.2 §2、M1.3 | 需迁移脚本 | — |
| B-14 | Gates 退出码语义统一（exit 只表示脚本是否崩溃，结论看 JSON） | v0.2 §0 #3 | 需同步改 Python 检查器 | — |
| B-15 | CLI 子进程冒烟测试；Python gates 的 pytest 固件 | docs/24 P2 | — | — |

## 待做 · 中优先

| # | 内容 | 来源 | 暂缓原因 | 依赖 |
|---|---|---|---|---|
| B-20 | Extractor：每章抽取人物状态变化/伏笔/时间线，事实带 sourceChapter，按章撤回重抽 | v0.2 M5 | 先用 B-01 过渡 | B-13 |
| B-21 | 角色状态按章版本化（history），改设定后重写旧章用「截至该章」状态 | v0.2 §2 D3 | — | B-20 |
| B-22 | 结构化反查（按出场角色查伏笔、时间线、历史出场），效果不足再上向量检索 | v0.2 M6.3 | — | B-20 |
| B-23 | 伏笔台账：id 由引擎分配、等级 minor/major/core、逾期提醒 | v0.2 §2、附 A | — | B-20 |
| B-24 | 两步提交 + 快照型 checkpoint + resume + rollback | v0.2 M4.4–4.6 | — | B-13 |
| B-25 | 文件锁（pid + 时间戳，陈旧锁可接管） | v0.2 M4.7 | — | — |
| B-26 | `replayLLM` 录像回放，离线确定性测试 | v0.2 M7.6、X6 | — | — |
| B-27 | 成本统计与预算上限（单章/全书），超限停下 | v0.2 M7.7、X1 | — | — |
| B-28 | `rules adopt`：采纳 `_candidates/` 规则候选 | docs/24 P3-1 | — | — |
| B-29 | `stats`：修订次数、人工改稿行数/千字（北极星）、Judge 通过率、成本 | docs/24 P3-2 | — | B-11 |
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
| B-46 | 查重 Gate（章内/跨章 n-gram） | v0.2 附 A |
| B-47 | 平台敏感词 Gate | v0.2 M15.4 |
| B-48 | 文风样稿提炼 → `anchors/style.md` | v0.2 附 A |
| B-49 | 人物口吻字段（口头禅、说话风格）并纳入 J3 | v0.2 附 A |
| B-50 | 摘要/抽取/初筛可配小模型 | v0.2 附 A |
| B-51 | 书目录自动 git commit（每次提交对应一次） | v0.2 X5 |
| B-52 | 章节编号迁移：`outline/ch-NN` → 四位编号，兼容旧名 | v0.2 §3.1 |
| B-53 | Python 检查器逐个迁移到 TS | docs/24 P1-3 |
| B-54 | 收拢三套系统：停用 webnovel-writer 插件钩子、合并 STORY_RULES 重复条目 | docs/24 P1-1 |
| B-55 | 清理 `content/` 无关素材（删除前列清单给作者确认） | docs/24 P1-2 |
| B-56 | legacy 手册归档到 `docs/legacy/` | docs/24 P4-1 |
| B-57 | 研究参考项目：Word Compiler（三环上下文）、SAGA、StoryWriter、DeepWriter-Bench | 调研 docx |

## 明确不做（留档防重复讨论）

| 内容 | 理由 |
|---|---|
| LangGraph / Celery / PostgreSQL+Neo4j+Qdrant / 多租户 JWT / K8s | 单用户文件为真相路线，规模不匹配 |
| 改设定后自动同步全部记忆并全局重写 | 与 L3 人工圈定冲突 |
| LoRA 风格微调 | 成本高，先用 few-shot |
| v0.1 M14 压缩管线 | buildPrompt 每次从零组装，不存在旧消息 |
| 爽点强度自动打分、以爽点类型硬拦截 | 无可靠判据 |

## 已完成

| # | 内容 | 完成于 |
|---|---|---|
| B-01 | 当前状态卡：`buildPrompt` draft 模式追加 `now.md`（读 `book.json` 的 `paths.now`，缺省 `.soloent/memory/now.md`；上限 3000 码点；文件缺失或仍是「（待填）」占位则不注入）；`summarize --state-card` 产出建议到 `state/now.proposed.md`，**绝不覆盖 `now.md`**，作者手工合并 | 2026-09-25 · 6ba2813 |
| B-02 | 相关摘要检索关键词 = 上一章末尾 ∪ 本章细纲全文 bigram（`assembleLongContext` 第 4 参 `outlineText`） | 2026-09-25 · 6ba2813 |

> 随 B-01/B-02 一并修掉的基建缺陷：`packages/core` 的 `test` 脚本是**硬编码文件清单**，
> 新增的 `test/memory-context.test.ts` 没被登记 → 实际只跑 55 项，B-01/B-02 的 4 项测试
> 从未执行过。已改为 `"test/**/*.test.ts"`，现 59 项全绿。（此类「测试在但不跑」的坑
> 与 B-15「测试基建」同类，登记为教训。）
