import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPrompt } from './prompt.js';
import { callLLM, type CallLLMOptions } from './llm.js';
import { applyGateResult, readState, snapshotChapterMtimes, writeState } from './state.js';
import { runGates } from './gates.js';
import type { LLMResult } from './types.js';

/** 章节文件名：两位数零填充，与默认 file_regex ^ch-(\d+)\.md$ 对齐（自定义命名规则的书为后续工作） */
function chapterFileName(chapterNo: number): string {
  return `ch-${String(chapterNo).padStart(2, '0')}.md`;
}

/** 原子写正文：tmp → rename；Windows 覆盖已存在文件撞 EPERM 时 fs.rm 后 rename（雷区既定挡法） */
async function atomicWriteText(absPath: string, text: string): Promise<void> {
  const tmp = `${absPath}.tmp`;
  await writeFile(tmp, text, 'utf-8');
  try {
    await rename(tmp, absPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      await rm(absPath, { force: true });
      await rename(tmp, absPath);
      return;
    }
    throw e;
  }
}

export interface WriteChapterOptions {
  bookRoot: string;
  chapterNo: number;
  llm?: CallLLMOptions;
}

export interface WriteChapterResult {
  file: string;
  ok: boolean;
  /** ok=false 时为失败 union；此时不落盘、不改 state */
  llm?: LLMResult;
}

/** 4.4 draft 流水线：buildPrompt(draft) → callLLM → 原子写 ch-NN.md → writeState（重建索引，新章 gateStatus 为 null） */
export async function writeChapter(o: WriteChapterOptions): Promise<WriteChapterResult> {
  const root = path.resolve(o.bookRoot);
  const bundle = await buildPrompt({ bookRoot: root, chapterNo: o.chapterNo, mode: 'draft' });
  const r = await callLLM(bundle, o.llm);
  const file = chapterFileName(o.chapterNo);
  if (!r.ok) return { file, ok: false, llm: r };
  await atomicWriteText(path.join(root, 'chapters', file), r.text);
  const state = await readState({ bookRoot: root, force: true });
  await writeState(state);
  return { file, ok: true };
}

export async function saveChapterText(o: {
  bookRoot: string;
  chapterNo: number;
  text: string;
}): Promise<{ file: string; text: string }> {
  const root = path.resolve(o.bookRoot);
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((chapter) => chapter.chapterNo === o.chapterNo);
  if (entry === undefined) throw new Error(`saveChapterText：第 ${o.chapterNo} 章不存在`);
  await atomicWriteText(path.join(root, 'chapters', entry.file), o.text);
  const refreshedState = await readState({ bookRoot: root, force: true });
  await writeState(refreshedState);
  return { file: entry.file, text: o.text };
}

export interface ConvergeOptions {
  bookRoot: string;
  chapterNo: number;
  /** 默认 3，上限防死循环烧 token */
  maxRounds?: number;
  llm?: CallLLMOptions;
}

export interface ConvergeRound {
  round: number;
  findings: number;
  worst: string;
  action: 'stop-clean' | 'stop-no-findings' | 'revise' | 'stop-llm-error';
  llmError?: LLMResult;
}

export interface ConvergeResult {
  file: string;
  /** 章不存在时是否先走了 writeChapter 起草 */
  drafted: boolean;
  rounds: ConvergeRound[];
  finalWorst: string;
  stopped: 'clean' | 'no-findings' | 'max-rounds' | 'llm-error' | 'draft-failed';
  draftError?: LLMResult;
}

/**
 * 4.5 收敛循环。每轮：runGates → 回填落盘 → ★clean 即停 / ★空 findings 即停（两条硬约束，
 * 绝不靠「进了 revise 再 throw」兜底）→ buildPrompt(revise) → callLLM → 覆盖正文。
 * LLM 失败：记录错误、break，不吞错误、不静默成功。
 */
export async function convergeChapter(o: ConvergeOptions): Promise<ConvergeResult> {
  const root = path.resolve(o.bookRoot);
  const maxRounds = o.maxRounds ?? 3;
  const file = chapterFileName(o.chapterNo);

  let state = await readState({ bookRoot: root });
  let drafted = false;
  if (!state.chapters.some((c) => c.chapterNo === o.chapterNo)) {
    const w = await writeChapter({
      bookRoot: root,
      chapterNo: o.chapterNo,
      ...(o.llm !== undefined ? { llm: o.llm } : {}),
    });
    if (!w.ok) {
      return {
        file,
        drafted: false,
        rounds: [],
        finalWorst: 'unknown',
        stopped: 'draft-failed',
        ...(w.llm !== undefined ? { draftError: w.llm } : {}),
      };
    }
    drafted = true;
  }

  const rounds: ConvergeRound[] = [];
  let stopped: ConvergeResult['stopped'] = 'max-rounds';
  let finalWorst = 'unknown';

  for (let i = 1; i <= maxRounds; i++) {
    // ★三步顺序不能换（F17）：先读 state → 再取**跑前** mtime 快照 → 最后才跑 gate 并回填。
    // 旧版是「跑完再 stat 回填」：本轮（或上一轮刚改写）变更的 mtime 会被当成「已检」，
    // 形成假绿窗口。只认快照值后，跑期间被改的章会在下次 readState 清扫时回到待检。
    state = await readState({ bookRoot: root });
    const mtimeSnapshot = await snapshotChapterMtimes(root, state.chapters);
    const gateResult = await runGates({ bookRoot: root });
    const chapterFindings = gateResult.findings.filter((f) => f.chapter === file);
    await applyGateResult(state, gateResult, { mtimeSnapshot });
    await writeState(state);
    const worst = state.chapters.find((c) => c.chapterNo === o.chapterNo)?.gateStatus?.worst ?? 'clean';
    finalWorst = worst;

    if (worst === 'clean') {
      rounds.push({ round: i, findings: chapterFindings.length, worst, action: 'stop-clean' });
      stopped = 'clean';
      break;
    }
    if (chapterFindings.length === 0) {
      rounds.push({ round: i, findings: 0, worst, action: 'stop-no-findings' });
      stopped = 'no-findings';
      break;
    }

    const bundle = await buildPrompt({ bookRoot: root, chapterNo: o.chapterNo, mode: 'revise', findings: chapterFindings });
    const r = await callLLM(bundle, o.llm);
    if (!r.ok) {
      rounds.push({ round: i, findings: chapterFindings.length, worst, action: 'stop-llm-error', llmError: r });
      stopped = 'llm-error';
      break;
    }
    await atomicWriteText(path.join(root, 'chapters', file), r.text);
    rounds.push({ round: i, findings: chapterFindings.length, worst, action: 'revise' });
  }

  return { file, drafted, rounds, finalWorst, stopped };
}
