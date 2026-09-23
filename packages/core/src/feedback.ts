import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readState } from './state.js';

export interface FeedbackInput {
  bookRoot: string;
  chapterNo: number;
  /** 人工改后的最终正文 */
  revisedText: string;
}

interface DiffHunk {
  /** 原章起始行（1 基） */
  startLine: number;
  oldLines: string[];
  newLines: string[];
}

/** 行级 LCS diff（机械聚合，不走 LLM——「像素差」原样呈现，提炼规则是人工审阅时的事） */
function diffLines(oldText: string, newText: string): DiffHunk[] {
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
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((c) => c.chapterNo === i.chapterNo);
  if (entry === undefined) {
    throw new Error(`recordFeedback：第 ${i.chapterNo} 章不在索引中`);
  }
  const original = await readFile(path.join(root, 'chapters', entry.file), 'utf-8');
  const hunks = diffLines(original, i.revisedText);
  const date = new Date().toISOString().slice(0, 10);

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
