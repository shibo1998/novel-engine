export interface StoryState {
  bookId: string;
  updatedAt: string;
  cursor: { volume: number; chapter: number };
  chapters: ChapterIndexEntry[];
}

export interface ChapterIndexEntry {
  chapter: number;
  title: string;
  path: string;
  wordCount: number;
  gateStatus: 'unknown' | 'passed' | 'failed';
}

export interface BuildPromptInput {
  stage: string;
  context: Record<string, unknown>;
  target?: string;
}

export interface PromptBundle {
  system: string;
  user: string;
  meta: { stage: string; target?: string };
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
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

export interface FeedbackEntry {
  chapter: number;
  category: string;
  original: string;
  revised: string;
  note?: string;
}
