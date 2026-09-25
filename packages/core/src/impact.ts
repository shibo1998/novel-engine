import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readState, writeState } from './state.js';
import { readFacts } from './extract.js';
import { readForeshadowLedger } from './foreshadow.js';
import { reviseByInstruction } from './revise.js';
import type { CallLLMOptions } from './llm.js';

/**
 * 设定变更的影响分析与顺序重写（B-41 / v0.2 L3）。
 *
 * 治的是什么：第 30 章把「炼气三层」改成「筑基初期」，前面 29 章里凡是写到境界的
 * 地方就全错了。作者要么全文搜索逐条改，要么干脆不改——两种都在伤一致性。
 *
 * ★三步，**中间那步必须是人**：
 *   ① **分析**：机器找出「哪些章提到了这些词」，并给命中片段；
 *   ② **圈定**：**人**从中选真正要改的章——机器分不清「顺口提了一句」与
 *      「这一章的冲突建立在这个设定上」，圈定不能自动化；
 *   ③ **顺序重写**：按**章号升序**逐章定点改。
 *
 * ★为什么必须升序：后面的章要看到前面改完的结果。
 * 先改第 12 章再改第 7 章，第 12 章的 prompt 里读到的还是**旧**的第 7 章——
 * 那正是「改一处、错两处」的来源。所以这里不接受乱序输入，也不并发。
 *
 * ★为什么不用向量检索找受影响章：这里要的是**确定**的答案
 * （「这个词出现在哪几章」），不是「相似」。而且改错章比漏改章代价大得多——
 * 人会看着命中片段圈定，机器不替他决定。
 */

export interface ImpactHit {
  chapterNo: number;
  file: string;
  /** 每个关键词的命中次数 */
  hits: Record<string, number>;
  total: number;
  /** 命中片段（前若干条，供人工判断「这一章真的受影响吗」） */
  excerpts: { term: string; line: number; text: string }[];
}

export interface ImpactReport {
  terms: string[];
  /** 受影响的章（按命中总数降序——命中多的更可能真的受影响） */
  chapters: ImpactHit[];
  /**
   * 事实库里提到这些词的角色。
   * ★比词面更准：角色名出现在 facts 里说明**抽取确认过**他在这章有状态变化。
   */
  relatedCharacters: { name: string; chapters: number[] }[];
  /** 台账里内容含这些词的伏笔 */
  relatedForeshadows: { id: string; content: string; status: string; plantedChapter: number }[];
  /** 抽取覆盖率。**「没命中」的可信度取决于它** */
  coverage: { extracted: number; total: number };
}

const MAX_EXCERPTS_PER_CHAPTER = 5;

/** 原子写正文（与 generate.ts 同款：tmp → rename；Windows 覆盖撞 EPERM 时先删再 rename） */
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

export async function analyzeImpact(bookRoot: string, terms: string[]): Promise<ImpactReport> {
  const root = path.resolve(bookRoot);
  const clean = terms.map((t) => t.trim()).filter((t) => t !== '');
  const [state, facts, ledgerRead] = await Promise.all([
    readState({ bookRoot: root }),
    readFacts(root),
    readForeshadowLedger(root),
  ]);
  const order = new Map(state.chapters.map((c) => [c.file, c.chapterNo]));

  const chapters: ImpactHit[] = [];
  for (const ch of state.chapters) {
    const text = (await readFile(path.join(root, 'chapters', ch.file), 'utf-8').catch(() => '')).replace(/^\uFEFF/, '');
    if (text === '') continue;
    const hits: Record<string, number> = {};
    const excerpts: ImpactHit['excerpts'] = [];
    let total = 0;
    const lines = text.split('\n');
    for (const term of clean) {
      let n = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        // 逐次出现都计数（同一行出现两次算两次）——影响面看的是「提了几次」
        let idx = line.indexOf(term);
        while (idx !== -1) {
          n += 1;
          if (excerpts.length < MAX_EXCERPTS_PER_CHAPTER) {
            excerpts.push({ term, line: i + 1, text: line.trim().slice(0, 80) });
          }
          idx = line.indexOf(term, idx + term.length);
        }
      }
      if (n > 0) hits[term] = n;
      total += n;
    }
    if (total > 0) chapters.push({ chapterNo: ch.chapterNo, file: ch.file, hits, total, excerpts });
  }
  chapters.sort((a, b) => b.total - a.total || a.chapterNo - b.chapterNo);

  // 事实库里的相关角色（比词面更准：抽取确认过他在这章有状态变化）
  const relatedCharacters: ImpactReport['relatedCharacters'] = [];
  for (const [file, f] of Object.entries(facts.chapters)) {
    const no = order.get(file) ?? 0;
    if (no === 0) continue;
    for (const c of f.characters) {
      if (!clean.some((t) => c.name.includes(t) || t.includes(c.name))) continue;
      const hit = relatedCharacters.find((x) => x.name === c.name);
      if (hit === undefined) relatedCharacters.push({ name: c.name, chapters: [no] });
      else if (!hit.chapters.includes(no)) hit.chapters.push(no);
    }
  }
  for (const c of relatedCharacters) c.chapters.sort((a, b) => a - b);

  const relatedForeshadows = ledgerRead.ledger.items
    .filter((i) => clean.some((t) => i.content.includes(t)))
    .map((i) => ({ id: i.id, content: i.content, status: i.status as string, plantedChapter: i.plantedChapter }));

  return {
    terms: clean,
    chapters,
    relatedCharacters,
    relatedForeshadows,
    coverage: { extracted: Object.keys(facts.chapters).length, total: state.chapters.length },
  };
}

export interface RewriteInOrderOptions {
  bookRoot: string;
  /** 人工圈定的章号。**会被强制升序排序**——乱序会「改一处、错两处」 */
  chapters: number[];
  /** 变更说明 */
  instruction: string;
  llm?: CallLLMOptions;
  signal?: AbortSignal;
}

export interface RewriteInOrderResult {
  /** 实际执行的顺序（升序，去重后） */
  order: number[];
  results: {
    chapterNo: number;
    applied: number;
    skipped: number;
    rejected: string | null;
    /** 模型没给出任何补丁（可能真的不受影响，也可能没看出来） */
    noPatches: boolean;
  }[];
  /** 中途停下时是哪一章（含失败原因） */
  stoppedAt?: { chapterNo: number; reason: string };
}

/**
 * 按**章号升序**逐章定点重写。
 *
 * ★两条纪律：
 *   1. **强制升序 + 串行**：不接受乱序，也不并发。理由见文件头。
 *   2. **改完一章立刻刷新 state**：下一章的 prompt 要读到**改过之后**的内容
 *      （`now.md` 状态卡、摘要、readiness 都依赖 state）。不刷新的话，
 *      第 8 章会拿着第 7 章的旧文本去改——顺序的意义就没了。
 *
 * 中途失败**停下**并报「改到哪一章」，不继续——后面几章基于一个半成品改只会更乱。
 */
export async function rewriteInOrder(o: RewriteInOrderOptions): Promise<RewriteInOrderResult> {
  const root = path.resolve(o.bookRoot);
  const order = [...new Set(o.chapters)].sort((a, b) => a - b);
  const out: RewriteInOrderResult = { order, results: [] };

  for (const n of order) {
    const r = await reviseByInstruction({
      bookRoot: root,
      chapterNo: n,
      instruction: o.instruction,
      ...(o.llm !== undefined ? { llm: o.llm } : {}),
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
    });
    if (!r.ok) {
      out.stoppedAt = { chapterNo: n, reason: `[${r.kind}] ${r.detail}` };
      return out;
    }
    const entry = { chapterNo: n, applied: r.applied.length, skipped: r.skipped.length, rejected: r.rejected, noPatches: r.applied.length === 0 && r.skipped.length === 0 };

    if (r.applied.length > 0) {
      // ★先落盘、再刷新 state——顺序反了的话，下一章读到的 state 指向的还是旧正文。
      // `reviseByInstruction` 与 `reviseByQuote` 一样**只返回文本不落盘**（写盘集中在编排层）。
      const st = await readState({ bookRoot: root });
      const e = st.chapters.find((c) => c.chapterNo === n);
      if (e === undefined) {
        out.stoppedAt = { chapterNo: n, reason: '第 ${n} 章不在索引中（索引与 chapters/ 不一致）' };
        return out;
      }
      await atomicWriteText(path.join(root, 'chapters', e.file), r.text);
      const refreshed = await readState({ bookRoot: root, force: true });
      await writeState(refreshed);
    }
    out.results.push(entry);
  }
  return out;
}
