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
  /**
   * 外部取消（F20-2）。透传给 runGates（SIGKILL 检查器子进程）与 callLLM（abort HTTP），
   * 并在每轮开始时检查一次。没有它，前端点「取消」只能断开连接，
   * server 侧的无状态 spawn 照样跑完——那正是这条问卷里最容易被误判的一条。
   */
  signal?: AbortSignal;
}

export interface ConvergeRound {
  round: number;
  findings: number;
  worst: string;
  action: 'stop-clean' | 'stop-inconsistent' | 'revise' | 'stop-llm-error' | 'stop-aborted';
  llmError?: LLMResult;
}

export interface ConvergeResult {
  file: string;
  /** 章不存在时是否先走了 writeChapter 起草 */
  drafted: boolean;
  rounds: ConvergeRound[];
  finalWorst: string;
  stopped: 'clean' | 'max-rounds' | 'llm-error' | 'draft-failed' | 'gate-inconsistent' | 'aborted';
  draftError?: LLMResult;
  /**
   * 本次实际发出的 LLM 请求次数上限（F15）。
   * 暴露它是为了让「重试层数 × 轮数」这个乘积**可被审计**：
   * 上界 = 轮数 × (1 + NOVEL_LLM_RETRY_ATTEMPTS)；持续失败时熔断器会提前掐断，
   * 所以实际值只会更小，不会更大。没这个数，任何「为什么会烧这么多 token」的
   * 追问都只能靠推演。
   */
  llmCalls: number;
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
  // 取消信号并进 llm 选项：外部 signal 优先（显式取消 > 调用方自带的 signal）
  const llmOpts: CallLLMOptions = { ...o.llm, ...(o.signal !== undefined ? { signal: o.signal } : {}) };

  let state = await readState({ bookRoot: root });
  let drafted = false;
  // 实际发出的 LLM 请求计数（F15）：让「轮数 × 重试层数」这个乘积可被审计
  let llmCalls = 0;
  if (!state.chapters.some((c) => c.chapterNo === o.chapterNo)) {
    llmCalls += 1;
    const w = await writeChapter({
      bookRoot: root,
      chapterNo: o.chapterNo,
      llm: llmOpts,
    });
    if (!w.ok) {
      return {
        file,
        drafted: false,
        rounds: [],
        finalWorst: 'unknown',
        stopped: 'draft-failed',
        ...(w.llm !== undefined ? { draftError: w.llm } : {}),
        llmCalls,
      };
    }
    drafted = true;
  }

  const rounds: ConvergeRound[] = [];
  let stopped: ConvergeResult['stopped'] = 'max-rounds';
  let finalWorst = 'unknown';

  for (let i = 1; i <= maxRounds; i++) {
    // 每轮先看取消（F20-2）：取消是「外部决定」，必须在动 LLM 之前就生效
    if (o.signal?.aborted === true) {
      rounds.push({ round: i, findings: 0, worst: 'unknown', action: 'stop-aborted' });
      stopped = 'aborted';
      break;
    }
    // ★三步顺序不能换（F17）：先读 state → 再取**跑前** mtime 快照 → 最后才跑 gate 并回填。
    // 旧版是「跑完再 stat 回填」：本轮（或上一轮刚改写）变更的 mtime 会被当成「已检」，
    // 形成假绿窗口。只认快照值后，跑期间被改的章会在下次 readState 清扫时回到待检。
    state = await readState({ bookRoot: root, skipStaleSweep: true });
    const mtimeSnapshot = await snapshotChapterMtimes(root, state.chapters);
    const gateResult = await runGates({ bookRoot: root, ...(o.signal !== undefined ? { signal: o.signal } : {}) });
    const chapterFindings = gateResult.findings.filter((f) => f.chapter === file);
    await applyGateResult(state, gateResult, { mtimeSnapshot });
    await writeState(state);
    const worst = state.chapters.find((c) => c.chapterNo === o.chapterNo)?.gateStatus?.worst ?? 'clean';
    finalWorst = worst;

    // ★自检而非两条 stop 分支（F18）。
    // 旧版这里是「worst==='clean' 就停」+「findings 为 0 就停」两条并列分支，
    // 而第二条**不可达**：worst 取自 applyGateResult 回填的 gateStatus，回填逻辑是
    // 「不在 finding 摘要里 → clean」，所以 worst==='clean' 与 findings 为空是同一件事，
    // 第二条永远走不到。一个走不到的分支比没有更糟——读代码的人会以为
    // 「没发现 = 安全」是被显式保证的语义。
    // 现在改成先断言两者自洽，不自洽就是回填/聚合的键对不上，属程序 bug，必须显式停下，
    // 而不是猜一个语义把它当「没问题」放过去。
    const isClean = worst === 'clean';
    if (isClean !== (chapterFindings.length === 0)) {
      rounds.push({ round: i, findings: chapterFindings.length, worst, action: 'stop-inconsistent' });
      stopped = 'gate-inconsistent';
      break;
    }
    if (isClean) {
      rounds.push({ round: i, findings: 0, worst, action: 'stop-clean' });
      stopped = 'clean';
      break;
    }

    const bundle = await buildPrompt({ bookRoot: root, chapterNo: o.chapterNo, mode: 'revise', findings: chapterFindings });
    llmCalls += 1;
    const r = await callLLM(bundle, llmOpts);
    if (!r.ok) {
      // 取消与「LLM 失败」分开记：前者是用户按的，后者是要排查的故障（F20-2）
      const cancelled = r.kind === 'aborted';
      rounds.push({
        round: i,
        findings: chapterFindings.length,
        worst,
        action: cancelled ? 'stop-aborted' : 'stop-llm-error',
        llmError: r,
      });
      stopped = cancelled ? 'aborted' : 'llm-error';
      break;
    }
    await atomicWriteText(path.join(root, 'chapters', file), r.text);
    rounds.push({ round: i, findings: chapterFindings.length, worst, action: 'revise' });
  }

  return { file, drafted, rounds, finalWorst, stopped, llmCalls };
}
