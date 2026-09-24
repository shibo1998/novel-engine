export interface StoryState {
  /** 落盘格式版本；读取时不符即视为过期，丢弃并重建 */
  schemaVersion: 1;
  /** 索引生成时刻，ISO 8601 */
  generatedAt: string;
  /** 书根绝对路径，用于校验 state 与书是否配对 */
  bookRoot: string;
  /** 按 chapterNo 升序 */
  chapters: ChapterIndexEntry[];
}

/** 章节目录下的单章索引项。可从 md 重建，非真相源。 */
export interface ChapterIndexEntry {
  /** 章号，取自 fileRegex 的捕获组 1，索引按此数值升序 */
  chapterNo: number;
  /** 章节文件名，如 "ch-05.md"。注意：与 GateFinding.chapter 是同一个值，直接对齐，无需转换 */
  file: string;
  /** 首行 H1 剥去章号前缀后的标题；无 H1 时为空串 */
  title: string;
  /** 正文字符数，口径：整个文件去掉全部空白字符后的码点数 */
  wordCount: number;
  /** 最近一次门禁摘要；文件从未被检查过为 null */
  gateStatus: GateStatus | null;
}

/** 单章门禁摘要：由 runGates 结果聚合，不由 core 自动回填 */
export interface GateStatus {
  /** 该章命中的最高严重度；一条都没有为 "clean" */
  worst: GateSeverity | "clean";
  /** 该章命中的 finding 条数 */
  count: number;
  /** 审计用时间戳：这次聚合发生在何时 */
  checkedAt: string;
  /** 检查时刻该章节文件的 mtime（ms）。readState 读时与当前 mtime 比对，不等即视为过期并置 null */
  checkedMtimeMs: number;
}

export interface BuildPromptOptions {
  bookRoot: string;
  chapterNo: number;
  mode: 'draft' | 'revise';
  findings?: GateFinding[];        // revise 必带
}

/** 规则引用，按来源分组——用于生成后对账（「第 N 章当时用了哪版规则」） */
export interface RuleRefs {
  author: string[];   // 相对 .soloent/ 的路径；手写规则，先于 plugin 拼接
  plugin: string[];   // 插件来源规则，默认 []，须显式写全路径才启用
}

export interface PromptBundle {
  system: string;      // 身份 + canon + author rules + plugin rules
  user: string;        // 本章任务 + 上下文 + 待修问题
  ruleRefs: RuleRefs;  // 实际加载的规则文件（声明与实际不等即 bug）
}

export type LLMError =
  | { ok: false; kind: 'config'; detail: string }              // env 缺失（不可重试）
  | { ok: false; kind: 'timeout'; detail: string }             // 超时 / 网络错误（可重试）
  | { ok: false; kind: 'http'; status: number; detail: string } // 5xx 可重试，4xx 不可
  | { ok: false; kind: 'parse'; detail: string };              // 响应解析失败（不可重试）

/**
 * gate 子进程的失败分类。刻意与 LLMError 的 kind 共用词汇（'timeout' 等）：
 * 本项目有两条外部调用线——LLM HTTP 与 gate 子进程——失败词汇表统一，
 * 日志、告警、grep 才能跨两条线对齐，而不是每条线发明自己的一套说法。
 */
export type GateFailureKind =
  | 'timeout'          // 子进程超时被 SIGKILL
  | 'spawn'            // 脚本不存在 / 进程根本没起来
  | 'exit'             // 非 0 退出
  | 'parse'            // stdout 不是合法 JSON
  | 'shape'            // JSON 结构不符契约
  | 'root';            // bookRoot 不是目录

export type LLMResult = { ok: true; text: string } | LLMError;

/**
 * 改稿反馈条目——落 .soloent/feedback.jsonl，一条一行。
 * 这是全项目**唯一不可重建**的人工数据：state/story.json 能从 chapters/ 重建，它不能。
 * 所以落 .soloent/（与 book.json、canon.md 同级，同属「作者给这本书的输入」），
 * 绝不放 state/（那目录的语义就是「随时可清空重来」）。
 */
export interface FeedbackEntry {
  /** 记录时刻，ISO 8601 */
  at: string;
  /** 章号 */
  chapterNo: number;
  /** 章节文件名，与 ChapterIndexEntry.file 同口径 */
  file: string;
  /** 聚合类别：由各条 finding 的 check 前缀归并而来（如「裁判腔」）；无 finding 时为「(无)」 */
  category: string;
  /** 本次门禁在该章命中的 finding 条数 */
  findingCount: number;
  /** 人工改前的正文（原章原文，整段，不截断） */
  original: string;
  /** 人工改后的正文（整段，不截断） */
  revised: string;
}

export type GateSeverity = "严重" | "中等" | "轻微" | "提示";

export interface GateFinding {
  severity: GateSeverity;
  chapter: string;   // 相对书根，如 "ch-05.md"
  line: number;      // 0 表示整章级发现（无行号），展示时不得渲染成「第 0 行」
  check: string;     // 检查项名 + 说明，如 "[裁判腔] 「他知道」裁判腔——改为用行为暴露想法"
  detail: string;    // 命中原文；整章级发现时为空串
}

export interface GateResult {
  gate: string;                                   // 当前恒为 "consistency_check"
  book_root: string;                              // 检查器执行时收到的书根绝对路径
  chapter_count: number;
  counts: Partial<Record<GateSeverity, number>>;  // 「提示」仅在 gate.draft_free 开启时出现
  findings: GateFinding[];
}

