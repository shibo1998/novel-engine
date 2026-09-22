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
export interface BuildPromptInput {
    stage: string;
    context: Record<string, unknown>;
    target?: string;
}
export interface PromptBundle {
    system: string;
    user: string;
    meta: {
        stage: string;
        target?: string;
    };
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
    usage: {
        promptTokens: number;
        completionTokens: number;
    };
}
export type GateSeverity = "严重" | "中等" | "轻微" | "提示";
export interface GateFinding {
    severity: GateSeverity;
    chapter: string;
    line: number;
    check: string;
    detail: string;
}
export interface GateResult {
    gate: string;
    book_root: string;
    chapter_count: number;
    counts: Partial<Record<GateSeverity, number>>;
    findings: GateFinding[];
}
export interface FeedbackEntry {
    chapter: number;
    category: string;
    original: string;
    revised: string;
    note?: string;
}
