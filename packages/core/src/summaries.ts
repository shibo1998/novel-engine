import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callLLM } from './llm.js';
import { readState } from './state.js';
import type { LLMResult } from './types.js';

/** 单章摘要。sourceMtimeMs 与 gateStatus 同一指纹哲学：正文变了摘要即过期 */
export interface ChapterSummary {
  chapterNo: number;
  summary: string;
  updatedAt: string;
  sourceMtimeMs: number;
}

/** state/summaries.json（卷/弧分层为后续工作；当前章级摘要 + 组装） */
export interface SummaryStore {
  schemaVersion: 1;
  bookRoot: string;
  /** key = 章节文件名（ch-NN.md） */
  chapters: Record<string, ChapterSummary>;
}

/** 长文上下文段总字符上限（码点）——防 rules+上下文把 token 吃光 */
export const CONTEXT_CHAR_CAP = 4000;

export async function readSummaries(bookRoot: string): Promise<SummaryStore> {
  const root = path.resolve(bookRoot);
  const raw = await readFile(path.join(root, 'state', 'summaries.json'), 'utf-8').catch(() => null);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw.replace(/^﻿/, '')) as SummaryStore;
      if (parsed.schemaVersion === 1) return parsed;
    } catch {
      // 损坏视为没有摘要（派生缓存，可重建）
    }
  }
  return { schemaVersion: 1, bookRoot: root, chapters: {} };
}

async function writeSummaries(store: SummaryStore): Promise<void> {
  const root = path.resolve(store.bookRoot);
  const target = path.join(root, 'state', 'summaries.json');
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  try {
    await rename(tmp, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      await rm(target, { force: true });
      await rename(tmp, target);
      return;
    }
    throw e;
  }
}

/** 中文二字 bigram 集合（机械关键词，不走 LLM） */
function bigrams(text: string): Set<string> {
  const chars = [...text.replace(/\s/g, '')];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

export interface LongContext {
  /** 最近 2 章摘要（有摘要的才计入） */
  recentSummaries: ChapterSummary[];
  /** 更早章节中按关键词重合取 top2（排除 recent 已含的章） */
  relatedSummaries: ChapterSummary[];
}

/** 4.9 组装：写第 N 章时 = 最近 2 章摘要 + 按关键词取 2 章相关摘要（prevTail 由 buildPrompt 单独带） */
export async function assembleLongContext(bookRoot: string, chapterNo: number, prevTail: string): Promise<LongContext> {
  const state = await readState({ bookRoot });
  const store = await readSummaries(bookRoot);
  const prev = state.chapters.filter((c) => c.chapterNo < chapterNo);
  const pick = (c: (typeof prev)[number]): ChapterSummary | undefined => {
    const s = store.chapters[c.file];
    return s !== undefined && s.summary !== '' ? s : undefined;
  };
  const recent = prev.slice(-2).map(pick).filter((s): s is ChapterSummary => s !== undefined);
  const recentFiles = new Set(prev.slice(-2).map((c) => c.file));
  const kw = bigrams(prevTail);
  const related = prev
    .filter((c) => !recentFiles.has(c.file))
    .map((c) => ({ s: pick(c), c }))
    .filter((x): x is { s: ChapterSummary; c: (typeof prev)[number] } => x.s !== undefined)
    .map((x) => ({ s: x.s, score: overlap(kw, bigrams(x.s.summary)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.s);
  return { recentSummaries: recent, relatedSummaries: related };
}

/**
 * 生成/刷新一章摘要（LLM 路径挂点；凭据缺失时返回 config 错误 union，由调用方显式处理）。
 * 成功才写 summaries.json；失败不写任何东西。
 */
export async function updateChapterSummary(bookRoot: string, chapterNo: number): Promise<LLMResult> {
  const root = path.resolve(bookRoot);
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((c) => c.chapterNo === chapterNo);
  if (entry === undefined) throw new Error(`updateChapterSummary：第 ${chapterNo} 章不在索引中`);
  const filePath = path.join(root, 'chapters', entry.file);
  const text = await readFile(filePath, 'utf-8');
  const r = await callLLM({
    system: '你是中文小说摘要助手。把给定章节正文压缩成 150 字以内的摘要：只保留主线事件、人物状态变化、未回收的伏笔；不要评点、不要提纲式分点。',
    user: text,
    ruleRefs: { author: [], plugin: [] },
  });
  if (!r.ok) return r;
  const store = await readSummaries(root);
  const mtimeMs = (await stat(filePath)).mtimeMs;
  store.chapters[entry.file] = {
    chapterNo,
    summary: r.text.trim(),
    updatedAt: new Date().toISOString(),
    sourceMtimeMs: mtimeMs,
  };
  await writeSummaries(store);
  return r;
}
