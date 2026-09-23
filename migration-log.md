# 迁移台账
- 来源仓库：shibo1998/novel-writing
- 固定版本：f876dd2ef46a165bafbe6e7237e790f8f1337e91
- 迁移日期：2026-09-22

| 日期 | 任务 | 动作 | 备注 |
|---|---|---|---|
| 2026-09-22 | 01 | 迁移 docs/ 与 content/ 下文档资产 | 原样复制，未改内容 |
| 2026-09-22 | 02 | 建立 pnpm workspace 三件套（pnpm-workspace.yaml / 根 package.json / tsconfig.base.json） | 锁 packageManager=pnpm@9.15.9；tsconfig.base 当时为 moduleResolution: Bundler |
| 2026-09-22 | 03 | 脚本从 content/ 迁至 tools/ 并去重；同步脚本内新路径引用；gitignore 增加 __pycache__ | 产出 tools/{export_fanqie_txt,fix_punctuation,make_cover}.{py,ps1} + week_window.py |
| 2026-09-23 | 04 | packages/core 契约层 | 产出 packages/core/src/{types,index,llm,gates,prompt,state,feedback}.ts；tsc 零错误、ESM 产物可加载。遗留：GateResult 未经真实检查器 stdout 验证（同日由 gates 链路任务还清）；Bundler 解析靠人工保 .js 后缀（09-23 已改 NodeNext 由编译器强制） |
| 2026-09-23 | 05 | apps/cli 骨架 | 产出 apps/cli/src/index.ts + 子命令；桩抛错路径 stdout 干净 / stderr 有信息 / exit 非 0。遗留：paths 指向 core/src 的类型双轨（同日结案：移除 paths，回退 dist 单轨 + 根 typecheck 先 build） |
| 2026-09-23 | 06 | gates 链路接线（consistency_check.py + kit.py 迁入、stdout 唯一 JSON 出口、runGates + CLI gates --write） | 检查器零写文件：移除 write_report/append_trend 调用 |
| 2026-09-23 | 07 | 状态层（readState 三分支 / writeState 原子写 / summarizeGateResult / GateStatus 内容指纹 checkedMtimeMs） | state/story.json 定性为派生缓存；readState 返回前 sweepStaleGateStatus |
| 2026-09-23 | 08 | 步骤 B buildPrompt（IDENTITY + canon + 分组规则 + prevTail / revise 分支带 findings） | 单一致性检查即产出 3 种规则带行号 |
| 2026-09-23 | 09 | PART 4.1+4.2 rules 分组加载（author/plugin 并存插入，RuleFileMissing 显式抛） | 插件规则默认不启用；旧 load 的 9 份未镜像 |
| 2026-09-23 | 10 | 4.3 callLLM（LLMResult union / isRetryable / 内部退避重试 1 次） | 真调验收因无凭据 blocked |
| 2026-09-23 | 11 | 4.4+4.5 收敛循环（writeChapter + convergeChapter + applyGateResult 下沉 state.ts） | clean 即停、空 findings 即停两条硬约束 |
| 2026-09-23 | 12 | 4.6 recordFeedback（行级 LCS diff → _candidates/ 候选，不写生效规则） | 09-23 补：追加落 .soloent/feedback.jsonl（唯一不可重建的人工数据） |
| 2026-09-23 | 13 | 4.7 apps/server（node:http 零依赖五端点）+ 4.8 apps/web（Vite+React+ReactQuery） | vite 钉 host:127.0.0.1 绕 Windows IPv6 雷区 |
| 2026-09-23 | 14 | 4.9 长文上下文 summaries（readSummaries/assembleLongContext/updateChapterSummary）+ novel init + env.example | 卷/弧分层摘要仍为后续工作 |
| 2026-09-23 | 15 | 文档同步：README.md + docs/ne-架构与契约.md | docs/ 00–19 为 legacy 参考，不动 |
| 2026-09-23 | 16 | 修复批次：feedback 落 jsonl + summarizeGateResult count/worst + NodeNext 断双轨 + gate 路径校验 | 详见当日工作日志 |
