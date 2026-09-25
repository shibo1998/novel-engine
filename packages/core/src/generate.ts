import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPrompt } from './prompt.js';
import { callLLM, type CallLLMOptions } from './llm.js';
import { applyGateResult, BLOCKING_SEVERITIES, readState, snapshotChapterMtimes, writeState } from './state.js';
import { runGates } from './gates.js';
import { judgeChapter, JudgesNotDeclared, writeJudgeStatus } from './judges.js';
import { reviseByQuote } from './revise.js';
import type { GateFinding, LLMResult } from './types.js';

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
  /** 定点修订轮次上限（默认 2）。用满仍不过闸 → 升级为整章重写 */
  maxLocalRounds?: number;
  /** 整章重写轮次上限（默认 1）。用满仍不过闸 → **停下等人** */
  maxRewriteRounds?: number;
  /**
   * 每轮是否同时跑语义判据（B-11）。默认 true。
   * 未在 book.json 声明判据的书会自动跳过并在结果里标 `judge: 'not-declared'`——
   * 是「明确没跑」，不是「跑了没问题」。
   */
  judge?: boolean;
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
  /** local = 按 quote 定点修订；rewrite = 整章重写 */
  phase: 'local' | 'rewrite';
  /** 本轮拦截级发现条数（机械 gates + 语义判据） */
  findings: number;
  worst: string;
  action:
    | 'stop-clean' | 'stop-advisory' | 'stop-inconsistent'
    | 'local-revise' | 'rewrite'
    | 'stop-human-needed' | 'stop-llm-error' | 'stop-aborted';
  llmError?: LLMResult;
  /** 定点修订：实际替换 / 被跳过的补丁数，以及整批放弃的原因 */
  patches?: { applied: number; skipped: number; rejected: string | null };
}

export interface ConvergeResult {
  file: string;
  /** 章不存在时是否先走了 writeChapter 起草 */
  drafted: boolean;
  rounds: ConvergeRound[];
  finalWorst: string;
  /**
   * clean＝一条发现都没有；clean-advisory＝只剩提示级（非拦截）发现，同样算过闸；
   * 其余值都是**没走完**，调用方必须当成失败处理（批量跑据此停下、不写下一章）。
   *
   * `human-needed` 是本版新增的终态（B-12）：定点修订与整章重写都用完仍有拦截级问题，
   * **停下来等人**，不再空转到 max-rounds。旧版把这种情况报成 max-rounds，
   * 与「轮数上限到了但问题也不大」同形——两种完全不同的处境给了同一个名字。
   */
  stopped:
    | 'clean' | 'clean-advisory' | 'human-needed' | 'max-rounds'
    | 'llm-error' | 'draft-failed' | 'gate-inconsistent' | 'aborted';
  draftError?: LLMResult;
  /** 停下等人时的交接清单：未解决的拦截级问题（含引句），直接给人看 */
  handoff?: { findings: GateFinding[]; reason: string };
  /** 语义判据本轮的运行状态。'not-declared' = 没跑（明确），不是「跑了没问题」 */
  judge: 'on' | 'off' | 'not-declared';
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
 * 4.5 收敛循环（B-12 重构）。
 *
 * 每轮：runGates（+ 语义判据）→ 回填落盘 → ★clean 即停 → 按阶段修订。
 *
 * 阶段推进（作者定的顺序：**先定点、不行再整章重写、还不行就停下等人**）：
 *   1. 定点修订 ≤ `maxLocalRounds`（默认 2）：只改引句定位到的那几句，其它一字不动；
 *   2. 整章重写 ≤ `maxRewriteRounds`（默认 1）；
 *   3. 仍有拦截级 → `stopped: 'human-needed'` + `handoff` 交接清单，**停下等人**。
 *
 * 为什么定点优先：整章重写不可控——模型会把没问题的段落一起改写，
 * 上一轮刚过闸的地方被改坏，「改一处、坏两处」，循环空转烧 token。
 *
 * LLM 失败：记录错误、break，不吞错误、不静默成功。
 */
export async function convergeChapter(o: ConvergeOptions): Promise<ConvergeResult> {
  const root = path.resolve(o.bookRoot);
  const maxLocal = o.maxLocalRounds ?? 2;
  const maxRewrite = o.maxRewriteRounds ?? 1;
  const wantJudge = o.judge ?? true;
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
        judge: 'off',
        llmCalls,
      };
    }
    drafted = true;
  }

  const rounds: ConvergeRound[] = [];
  let stopped: ConvergeResult['stopped'] = 'human-needed';
  let finalWorst = 'unknown';
  let handoff: ConvergeResult['handoff'];
  let judgeState: ConvergeResult['judge'] = wantJudge ? 'on' : 'off';
  let localUsed = 0;
  let rewriteUsed = 0;

  for (;;) {
    const roundNo = rounds.length + 1;
    // 每轮先看取消（F20-2）：取消是「外部决定」，必须在动 LLM 之前就生效
    if (o.signal?.aborted === true) {
      rounds.push({ round: roundNo, phase: 'local', findings: 0, worst: 'unknown', action: 'stop-aborted' });
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
    //
    // 注意：这条自检只对**机械 gates**成立（judge 的结论落在 state/judge.json，不进 gateStatus）。
    const isClean = worst === 'clean';
    if (isClean !== (chapterFindings.length === 0)) {
      rounds.push({ round: roundNo, phase: 'local', findings: chapterFindings.length, worst, action: 'stop-inconsistent' });
      stopped = 'gate-inconsistent';
      break;
    }

    // 语义判据（B-11）：结论单独落 state/judge.json，不进 gateStatus。
    // 两者**不查同一项**（M10.5），所以这里取**并集**当拦截集，而不是压成一个口径：
    // 各自落各自的盘，信息不丢，决策时合起来用。
    let judgeFindings: GateFinding[] = [];
    if (wantJudge) {
      try {
        const jr = await judgeChapter({ bookRoot: root, chapterNo: o.chapterNo, llm: llmOpts });
        llmCalls += 1;
        if (jr.ok) {
          judgeFindings = jr.findings;
          const mtimeMs = mtimeSnapshot.get(file) ?? 0;
          await writeJudgeStatus(root, jr, mtimeMs);
        } else if (jr.kind === 'aborted') {
          rounds.push({ round: roundNo, phase: 'local', findings: 0, worst, action: 'stop-aborted' });
          stopped = 'aborted';
          break;
        } else {
          // 判据失败不吞：记进轮次、降级为「本轮无判据」，但不中断收敛（机械 gates 仍然有效）
          rounds.push({
            round: roundNo, phase: 'local', findings: chapterFindings.length, worst,
            action: 'stop-llm-error', llmError: jr,
          });
          stopped = 'llm-error';
          break;
        }
      } catch (e) {
        if (e instanceof JudgesNotDeclared) {
          // 明确「没跑」，不是「跑了没问题」——两者必须形状不同
          judgeState = 'not-declared';
        } else {
          throw e;
        }
      }
    }

    // 过闸判据：只有**拦截级**（严重/中等/轻微）才需要继续改写。
    // 提示级只报告——与 gates/consistency_check.py 的 draft_free 降级声明一致
    // （那里写明「只报告，不计入拦截」）。旧版用 worst==='clean' 当唯一判据，
    // 于是只要剩一条提示，就会连烧三轮改写仍拿不到 clean，每章都停在 max-rounds：
    // 检查器说「只是提示」，上层却当拦截处理，两侧自相矛盾。
    const blocking = [...chapterFindings, ...judgeFindings].filter((f) => BLOCKING_SEVERITIES.has(f.severity));
    if (blocking.length === 0) {
      const advisoryOnly = chapterFindings.length + judgeFindings.length > 0;
      rounds.push({
        round: roundNo,
        phase: localUsed > 0 || rewriteUsed > 0 ? (rewriteUsed > 0 ? 'rewrite' : 'local') : 'local',
        findings: 0,
        worst,
        action: advisoryOnly ? 'stop-advisory' : 'stop-clean',
      });
      stopped = advisoryOnly ? 'clean-advisory' : 'clean';
      break;
    }

    // ── 阶段 1：定点修订 ──
    if (localUsed < maxLocal) {
      const fixable = blocking.filter((f) => f.detail.trim() !== '');
      if (fixable.length > 0) {
        llmCalls += 1;
        const r = await reviseByQuote({
          bookRoot: root,
          chapterNo: o.chapterNo,
          findings: blocking,
          ...(o.signal !== undefined ? { signal: o.signal } : {}),
          llm: llmOpts,
        });
        if (!r.ok) {
          const cancelled = r.kind === 'aborted';
          if (cancelled) {
            rounds.push({
              round: roundNo, phase: 'local', findings: blocking.length, worst,
              action: 'stop-aborted', llmError: r,
            });
            stopped = 'aborted';
            break;
          }
          if (r.kind === 'parse') {
            // 模型没按 JSON 回补丁 = 定点这条路走不通。**不整轮中断**——
            // 中断会把一次「格式没对上」升级成整章失败，而机械 gates 明明还能用。
            // 记为一条「0 补丁」的定点轮，直接落到整章重写（作者的顺序：定点不行就重写）。
            localUsed = maxLocal;
            rounds.push({
              round: roundNo, phase: 'local', findings: blocking.length, worst, action: 'local-revise',
              patches: { applied: 0, skipped: 0, rejected: `定点修订输出无法解析（${r.detail.slice(0, 120)}）` },
            });
          } else {
            // config / timeout / http / circuit-open：真故障，记下并停
            rounds.push({
              round: roundNo, phase: 'local', findings: blocking.length, worst,
              action: 'stop-llm-error', llmError: r,
            });
            stopped = 'llm-error';
            break;
          }
        } else {
          localUsed += 1;
          rounds.push({
            round: roundNo, phase: 'local', findings: blocking.length, worst, action: 'local-revise',
            patches: { applied: r.applied.length, skipped: r.skipped.length, rejected: r.rejected },
          });
          if (r.applied.length > 0) {
            await atomicWriteText(path.join(root, 'chapters', file), r.text);
            continue;
          }
          // 一条都没应用上（引句全没命中 / 空替换 / 超改动量）→ 定点这条路走不通，
          // **不空转**：直接把定点轮次记满，落到整章重写。
          localUsed = maxLocal;
        }
      } else {
        // 全是整章级发现（无引句），定点无从下手 → 直接进整章重写
        localUsed = maxLocal;
      }
    }

    // ── 阶段 2：整章重写 ──
    if (rewriteUsed < maxRewrite) {
      // 只把拦截级问题交给模型改：提示级是给人看的，不该拿来追着模型改（那正是
      // draft_free 要避免的「拿负向禁令惩罚自由起草」）。
      const bundle = await buildPrompt({ bookRoot: root, chapterNo: o.chapterNo, mode: 'revise', findings: blocking });
      llmCalls += 1;
      const r = await callLLM(bundle, llmOpts);
      if (!r.ok) {
        // 取消与「LLM 失败」分开记：前者是用户按的，后者是要排查的故障（F20-2）
        const cancelled = r.kind === 'aborted';
        rounds.push({
          round: roundNo, phase: 'rewrite', findings: blocking.length, worst,
          action: cancelled ? 'stop-aborted' : 'stop-llm-error',
          llmError: r,
        });
        stopped = cancelled ? 'aborted' : 'llm-error';
        break;
      }
      rewriteUsed += 1;
      await atomicWriteText(path.join(root, 'chapters', file), r.text);
      rounds.push({ round: roundNo, phase: 'rewrite', findings: blocking.length, worst, action: 'rewrite' });
      continue;
    }

    // ── 两阶段都用完仍有拦截级 → 停下等人（B-12）──
    stopped = 'human-needed';
    handoff = {
      findings: blocking,
      reason: `定点修订 ${maxLocal} 轮 + 整章重写 ${maxRewrite} 轮后，仍有 ${blocking.length} 条拦截级问题`,
    };
    rounds.push({
      round: roundNo,
      phase: 'rewrite',
      findings: blocking.length,
      worst,
      action: 'stop-human-needed',
    });
    break;
  }

  return {
    file,
    drafted,
    rounds,
    finalWorst,
    stopped,
    ...(handoff !== undefined ? { handoff } : {}),
    judge: judgeState,
    llmCalls,
  };
}
