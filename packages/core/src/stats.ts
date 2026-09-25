import path from 'node:path';
import { diffLines, loadFeedback } from './feedback.js';
import { readState } from './state.js';
import { readJudgeStatus } from './judges.js';

/**
 * 全书度量（B-29 / v0.2 M14.4）。
 *
 * ★北极星 = **人工改稿行数 / 千字**。为什么是它：
 * 「修订次数」「findings 数」「Judge 通过率」都只说明机器忙不忙；
 * 只有「人要动多少字」才说明**机器写出来的东西到底能不能用**。
 * 这个数降下去，才叫真的变好了。
 *
 * ★**不做成本统计**（B-27 的 `costUsd` 部分，作者 2026-09-25 裁定）：
 * USER.md 写明「能在模型后台看到消耗，不需要工具再统计一遍」；
 * 且单价表要猜，猜出来的阈值不可信。这里只报**客观计数**（请求数在
 * `novel book` 的报告里，那里有 `llmCalls`）。
 *
 * 口径全部写死在这里，**只允许一处**——本项目为「同一件事两个口径」吃过多次亏：
 *   · 字数：`ChapterIndexEntry.wordCount`（去空白码点数，全项目唯一口径）
 *   · 改稿行数：每条 feedback 记录里 diff 的 `max(原行数, 改后行数)` 之和
 *   · Judge 通过率：**有判据结论的章**里 `worst === 'clean'` 的占比
 *     （分母是「有结论的章」，不是「全部章」——没跑过的章不该拉低通过率，
 *      也不该被算成通过。两者都会让这个数失去意义）
 */

export interface ChapterStats {
  chapterNo: number;
  file: string;
  wordCount: number;
  /** 定点修订次数（B-12/B-13 累计） */
  reviseCount: number;
  rewriteCount: number;
  /** 机械 gates 的结论；null = 待检 / 已过期 */
  gateWorst: string | null;
  /** 语义判据的结论；null = 没跑过 / 已过期 */
  judgeWorst: string | null;
  /** 判据给出的人工清单条数（unsure） */
  judgeManual: number | null;
  needsReview: boolean;
  /** 这一章被人工改过几次（feedback 记录数） */
  feedbackCount: number;
  /** 这一章人工改动的行数合计 */
  humanEditedLines: number;
}

export interface BookStats {
  bookRoot: string;
  chapters: number;
  words: number;
  /** 机器返工：定点修订 + 整章重写 的章级累计 */
  rework: { reviseCount: number; rewriteCount: number; chaptersTouched: number };
  gates: { checked: number; clean: number; blocking: number };
  judge: { checked: number; clean: number; failing: number; manual: number; passRate: number | null };
  /** ★北极星 */
  human: { feedbackEntries: number; editedLines: number; editedLinesPerKilo: number };
  perChapter: ChapterStats[];
}

/** 千字比：words 为 0 时返回 0（不是 NaN，也不是 Infinity） */
function perKilo(numerator: number, words: number): number {
  return words === 0 ? 0 : Number(((numerator / words) * 1000).toFixed(2));
}

/** 一段改稿涉及多少行：逐 hunk 取 max(原行数, 改后行数) 之和 */
export function editedLineCount(original: string, revised: string): number {
  return diffLines(original, revised)
    .reduce((sum, h) => sum + Math.max(h.oldLines.length, h.newLines.length), 0);
}

export async function collectStats(bookRoot: string): Promise<BookStats> {
  const root = path.resolve(bookRoot);
  const [state, judgeStore, feedback] = await Promise.all([
    readState({ bookRoot: root }),
    readJudgeStatus(root),
    loadFeedback(root),
  ]);

  // 按章聚合人工改稿
  const byChapter = new Map<number, { count: number; lines: number }>();
  let editedLines = 0;
  for (const f of feedback) {
    const lines = editedLineCount(f.original, f.revised);
    editedLines += lines;
    const cur = byChapter.get(f.chapterNo) ?? { count: 0, lines: 0 };
    byChapter.set(f.chapterNo, { count: cur.count + 1, lines: cur.lines + lines });
  }

  const perChapter: ChapterStats[] = state.chapters.map((c) => {
    const j = judgeStore.chapters[c.file];
    const fb = byChapter.get(c.chapterNo) ?? { count: 0, lines: 0 };
    return {
      chapterNo: c.chapterNo,
      file: c.file,
      wordCount: c.wordCount,
      reviseCount: c.reviseCount,
      rewriteCount: c.rewriteCount,
      gateWorst: c.gateStatus?.worst ?? null,
      judgeWorst: j?.worst ?? null,
      judgeManual: j?.manual ?? null,
      needsReview: c.needsReview,
      feedbackCount: fb.count,
      humanEditedLines: fb.lines,
    };
  });

  const words = perChapter.reduce((s, c) => s + c.wordCount, 0);
  const gatesChecked = perChapter.filter((c) => c.gateWorst !== null);
  const judgeChecked = perChapter.filter((c) => c.judgeWorst !== null);
  const judgeClean = judgeChecked.filter((c) => c.judgeWorst === 'clean');

  return {
    bookRoot: root,
    chapters: perChapter.length,
    words,
    rework: {
      reviseCount: perChapter.reduce((s, c) => s + c.reviseCount, 0),
      rewriteCount: perChapter.reduce((s, c) => s + c.rewriteCount, 0),
      chaptersTouched: perChapter.filter((c) => c.reviseCount + c.rewriteCount > 0).length,
    },
    gates: {
      checked: gatesChecked.length,
      clean: gatesChecked.filter((c) => c.gateWorst === 'clean').length,
      blocking: gatesChecked.filter((c) => c.gateWorst !== 'clean' && c.gateWorst !== '提示').length,
    },
    judge: {
      checked: judgeChecked.length,
      clean: judgeClean.length,
      failing: judgeChecked.filter((c) => c.judgeWorst !== 'clean' && c.judgeWorst !== '提示').length,
      manual: perChapter.reduce((s, c) => s + (c.judgeManual ?? 0), 0),
      // 分母是「有结论的章」；一章都没有时是 null 而不是 0——
      // 「还没跑过」与「跑过且全没过」必须形状不同
      passRate: judgeChecked.length === 0 ? null : Number((judgeClean.length / judgeChecked.length).toFixed(3)),
    },
    human: {
      feedbackEntries: feedback.length,
      editedLines,
      editedLinesPerKilo: perKilo(editedLines, words),
    },
    perChapter,
  };
}
