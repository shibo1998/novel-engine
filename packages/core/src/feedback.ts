import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readState } from './state.js';
import type { FeedbackEntry, GateFinding } from './types.js';

export interface FeedbackInput {
  bookRoot: string;
  chapterNo: number;
  /** 浏览器等先保存正文的场景可显式提供改前稿；不传时从磁盘读取当前稿。 */
  originalText?: string;
  /** 人工改后的最终正文 */
  revisedText: string;
  /** 本次门禁在该章的 findings（可选）。有则在记录里带上类别与条数，用于 revise 分支反查 */
  findings?: GateFinding[];
}

const FEEDBACK_FILE = 'feedback.jsonl';

/** BOM 剥离。与 state.ts / prompt.ts 同款，三处必须一致 */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/**
 * 由 finding.check 提炼聚合类别。
 * check 形如 "[裁判腔] 「他知道」裁判腔——改为用行为暴露想法"，
 * 取方括号内那段作类别；无反括号前缀则整段截断兜底。
 */
function categoryOf(findings: GateFinding[]): string {
  if (findings.length === 0) return '(无)';
  const first = findings[0]!;
  const m = /^\[([^\]]+)\]/.exec(first.check);
  if (m?.[1] !== undefined) return m[1];
  return first.check.slice(0, 12);
}

/**
 * 落盘：<bookRoot>/.soloent/feedback.jsonl
 * 格式：JSON Lines，一条 FeedbackEntry 一行，末尾带换行。
 * 追加式：旧行永不改写，读取时全量扫。
 * 不放 state/：那是可丢弃重建的缓存目录，feedback 是唯一不可重建的人工数据。
 */
async function appendFeedback(root: string, entry: FeedbackEntry): Promise<void> {
  const dir = path.join(root, '.soloent');
  await mkdir(dir, { recursive: true });
  // JSON.stringify 把 entry 内部换行转义成 \n，保证「一条记录 = 物理一行」——jsonl 成立的前提
  await appendFile(path.join(dir, FEEDBACK_FILE), JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * 反查历史改稿，喂给 buildPrompt 的 revise 分支。
 * 这是补「改稿归零」的机制根：findings 只说这章哪里错，
 * 历史反馈说「这类句子你以前是怎么改的」。
 *
 * 不用 tmp+rename 原子写是给「整体替换快照」用的；这里用它会丢历史。
 * 追加式的最坏情况只是最后一行写残，读取时丢弃即可。
 *
 * @param category 只取该类历史（如只看「裁判腔」怎么改的）
 * @param limit    只取最近 N 条（默认全部）。注意是「最近」，取尾部
 */
export async function loadFeedback(
  bookRoot: string,
  opts?: { category?: string; limit?: number },
): Promise<FeedbackEntry[]> {
  const root = path.resolve(bookRoot);
  const raw = await readFile(path.join(root, '.soloent', FEEDBACK_FILE), 'utf-8').catch(() => null);
  if (raw === null) return [];

  const out: FeedbackEntry[] = [];
  for (const rawLine of stripBom(raw).split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    try {
      const e = JSON.parse(line) as FeedbackEntry & { kind?: string };
      // 同一个 jsonl 里还混着别的记录（如 rules adopt 的采纳记录，见 rules.ts）。
      // 按**形状**过滤而不是按 kind 字段：老记录没有 kind，按 kind 过滤会把历史全丢掉。
      // 改稿记录的定义特征就是 original + revised 两个整段正文。
      if (typeof e.original !== 'string' || typeof e.revised !== 'string') continue;
      if (opts?.category !== undefined && e.category !== opts.category) continue;
      out.push(e);
    } catch {
      // 残行（上次写到一半崩了）：丢弃。追加式的前提是残行只可能是最后一行
    }
  }
  return opts?.limit !== undefined ? out.slice(-opts.limit) : out;
}

export interface DiffHunk {
  /** 原章起始行（1 基） */
  startLine: number;
  oldLines: string[];
  newLines: string[];
}

/** 行级 LCS diff（机械聚合，不走 LLM——「像素差」原样呈现，提炼规则是人工审阅时的事） */
export function diffLines(oldText: string, newText: string): DiffHunk[] {
  const a = oldText.replace(/^﻿/, '').split(/\r?\n/);
  const b = newText.replace(/^﻿/, '').split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  const flush = (): void => {
    if (cur !== null) {
      hunks.push(cur);
      cur = null;
    }
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      cur ??= { startLine: i + 1, oldLines: [], newLines: [] };
      cur.oldLines.push(a[i]!);
      i++;
    } else {
      cur ??= { startLine: i + 1, oldLines: [], newLines: [] };
      cur.newLines.push(b[j]!);
      j++;
    }
  }
  while (i < n) {
    cur ??= { startLine: i + 1, oldLines: [], newLines: [] };
    cur.oldLines.push(a[i]!);
    i++;
  }
  while (j < m) {
    cur ??= { startLine: i + 1, oldLines: [], newLines: [] };
    cur.newLines.push(b[j]!);
    j++;
  }
  flush();
  return hunks;
}

/**
 * 4.6 recordFeedback——整个系统唯一会「越用越像你」的层。
 * 安全边界：候选写入 .soloent/rules/_candidates/<date>-ch-NN.md，**不直接写进生效规则、不动 book.json**；
 * 人工审阅后手动提升到 author 组清单才生效（防自我强化错误，且可复盘「哪条规则从哪来」）。
 */
export async function recordFeedback(i: FeedbackInput): Promise<{ candidates: string[] }> {
  const root = path.resolve(i.bookRoot);
  if (i.revisedText === '') {
    throw new Error('recordFeedback：revisedText 不能为空');
  }
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((c) => c.chapterNo === i.chapterNo);
  if (entry === undefined) {
    throw new Error(`recordFeedback：第 ${i.chapterNo} 章不在索引中`);
  }
  const original = i.originalText ?? await readFile(path.join(root, 'chapters', entry.file), 'utf-8');
  const hunks = diffLines(original, i.revisedText);
  const date = new Date().toISOString().slice(0, 10);

  // 先落不可重建的 feedback.jsonl——它是删了就没有的数据，
  // 派生出来的候选 md 哪怕写失败也不影响这次记录已经存下来了。
  await appendFeedback(root, {
    at: new Date().toISOString(),
    chapterNo: i.chapterNo,
    file: entry.file,
    category: categoryOf(i.findings ?? []),
    findingCount: (i.findings ?? []).length,
    original: stripBom(original),
    revised: stripBom(i.revisedText),
  });

  const lines = [
    `# 规则候选 · ${date} · 第 ${i.chapterNo} 章（${entry.file}）`,
    '',
    '> 本文件由 recordFeedback 机械生成：人工改稿与原稿的行级 diff 聚合。',
    '> **候选不生效**；人工审阅后把条目提炼进 author 组规则文件，并在 book.json 的 rules.author 声明。',
    '',
  ];
  const candidates: string[] = [];
  hunks.forEach((h, idx) => {
    const desc = [
      `## 候选 ${idx + 1}（原章第 ${h.startLine} 行起）`,
      '',
      '**原文**',
      '',
      ...h.oldLines.map((l) => `> ${l}`),
      '',
      '**改后**',
      '',
      ...h.newLines.map((l) => `> ${l}`),
    ].join('\n');
    candidates.push(desc);
    lines.push(desc, '');
  });

  const dir = path.join(root, '.soloent', 'rules', '_candidates');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date}-ch-${String(i.chapterNo).padStart(2, '0')}.md`);
  await writeFile(file, lines.join('\n'), 'utf-8');
  return { candidates };
}
