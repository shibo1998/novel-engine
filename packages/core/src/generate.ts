import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPrompt } from './prompt.js';
import { callLLM, type CallLLMOptions } from './llm.js';
import { applyGateResult, BLOCKING_SEVERITIES, isPassingWorst, readState, snapshotChapterHashes, writeState } from './state.js';
import { runGates } from './gates.js';
import { judgeChapter, JudgesNotDeclared, writeJudgeStatus } from './judges.js';
import { readReviseConfig, reviseByQuote } from './revise.js';
import { withBookLock } from './lock.js';
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

/**
 * 4.4 draft 流水线：buildPrompt(draft) → callLLM → 原子写 ch-NN.md → writeState
 * （重建索引，新章 gateStatus 为 null、计数归零，并记 generatedBy 供质量归因）
 */
export async function writeChapter(o: WriteChapterOptions): Promise<WriteChapterResult> {
  // 书级锁（B-25）：写章节文件是**唯一**必须独占的动作。
  // 放在函数内部而不是让各入口接线——接线模式必然漏（B-10 就抓到 novel write 一道门没接）。
  // convergeChapter 内部会调本函数，同进程重入，不会自己挡自己。
  return withBookLock(o.bookRoot, `起草第 ${o.chapterNo} 章`, async () => writeChapterLocked(o));
}

async function writeChapterLocked(o: WriteChapterOptions): Promise<WriteChapterResult> {
  const root = path.resolve(o.bookRoot);
  const bundle = await buildPrompt({ bookRoot: root, chapterNo: o.chapterNo, mode: 'draft' });
  const r = await callLLM(bundle, { purpose: 'draft', ...o.llm });
  const file = chapterFileName(o.chapterNo);
  if (!r.ok) return { file, ok: false, llm: r };
  await atomicWriteText(path.join(root, 'chapters', file), r.text);
  const state = await readState({ bookRoot: root, force: true });
  // 质量归因（B-13）：这一章是谁写的、按哪版 prompt 写的。
  // promptHash 是 system+user 的指纹——同一版规则下重写会得到同一 hash，
  // 换规则/换上下文才会变，因此能回答「这批章是用哪版规则跑的」。
  const entry = state.chapters.find((c) => c.chapterNo === o.chapterNo);
  if (entry !== undefined) {
    entry.generatedBy = {
      model: process.env['LLM_MODEL'] ?? '(未知)',
      promptHash: bundle.hash ?? '',
      at: new Date().toISOString(),
    };
  }
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
  /**
   * 停下等人时的交接清单：未解决的拦截级问题（含引句）。
   * `file` 是落盘路径（`state/handoff/ch-NN.md`）——批量跑中断后要能直接翻到
   * 「上次卡在哪几条」，而不是从几十行 stderr 里捞。
   */
  handoff?: { findings: GateFinding[]; reason: string; file: string };
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

/** 交接清单落盘路径（相对书根） */
function handoffRel(chapterNo: number): string {
  return `state/handoff/ch-${String(chapterNo).padStart(2, '0')}.md`;
}

/**
 * 把交接清单落盘（B-69）。给人看的，所以用 markdown 而不是 JSON。
 * 返回相对路径。
 */
async function writeHandoff(
  root: string,
  chapterNo: number,
  findings: GateFinding[],
  reason: string,
): Promise<string> {
  const rel = handoffRel(chapterNo);
  // state/handoff/ 可能还不存在：atomicWriteText 只写 `.tmp → rename`，不建目录
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  const lines = [
    `# 第 ${chapterNo} 章 · 交接清单`,
    '',
    `> ${reason}`,
    '',
    '机器已试过「定点修订」与「整章重写」两条路。下列问题仍未解决，需要人工处理。',
    '**改完直接重跑即可**（收敛循环会重新过闸）：',
    '',
    '```',
    `novel generate --book <书目录> --chapter ${chapterNo}`,
    '```',
    '',
  ];
  findings.forEach((f, i) => {
    lines.push(`## ${i + 1}. [${f.severity}] ${f.check}`, '');
    if (f.detail !== '') lines.push('原文引句：', '', '> ' + f.detail.split('\n').join('\n> '), '');
  });
  await atomicWriteText(path.join(root, rel), lines.join('\n') + '\n');
  return rel;
}

/** 过闸了就把该章的交接清单删掉——**过期的清单不如没有**（同 gateStatus 的过期清扫） */
async function clearHandoff(root: string, chapterNo: number): Promise<void> {
  await rm(path.join(root, handoffRel(chapterNo)), { force: true }).catch(() => undefined);
}

/**
 * 自检：`stopped` 与 `finalWorst` 是**同一件事的两种说法**，必须对得上。
 *
 * 两者词汇不同：`stopped` 是收敛循环的终态，`finalWorst` 是机械 gates 回填的严重度。
 * 单向蕴含必须成立——**若声称「过闸了」，机械 gates 就不能还有拦截级**。
 *
 * 为什么只做单向：反向不成立，也不该成立。`stopped: 'human-needed'` 配
 * `finalWorst: 'clean'` 是**正常**的——拦截级问题可能全部来自语义判据
 * （judge 的结论不进 gateStatus，两者不查同一项）。
 *
 * 为什么值得做（B-66 顺带发现）：B-12 之后 `isPassingWorst` 在 apps/ 里没有调用者了，
 * 「过闸判据只允许一个来源」这条规矩就只剩一句注释。**一个存在但没人用的谓词，
 * 正是 F18（那条永远走不到的 stop 分支）的成因**——接成自检之后它重新变成活的。
 */
function assertStoppedConsistent(
  stopped: ConvergeResult['stopped'],
  finalWorst: string,
): ConvergeResult['stopped'] {
  const claimsPass = stopped === 'clean' || stopped === 'clean-advisory';
  if (claimsPass && !isPassingWorst(finalWorst)) {
    throw new Error(
      `收敛结果自相矛盾：stopped=${stopped}（声称过闸），但机械 gates 的 worst=${finalWorst}（拦截级）。\n`
        + '  两者是同一件事的两种说法，对不上说明回填或聚合有 bug——不能猜一个语义放过去。',
    );
  }
  return stopped;
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
  // 整个收敛过程独占本书（B-25）：一轮里要 readState → 改章节 → writeState 两遍，
  // 与另一个进程交错就会「两边都报成功、后写的覆盖先写的」。
  return withBookLock(o.bookRoot, `收敛第 ${o.chapterNo} 章`, async () => convergeChapterLocked(o));
}

async function convergeChapterLocked(o: ConvergeOptions): Promise<ConvergeResult> {
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
  // 改动量上限来自 book.json（B-68）；没配就走 revise.ts 的默认值
  const reviseCfg = await readReviseConfig(root);

  /**
   * 修订计数（B-13）。落在 ChapterIndexEntry 上，供 stats 回答
   * 「这一章被机器改了几次」——不记的话，「人工改稿行数/千字」这个北极星指标
   * 就分不清「作者改得多」是因为模型一次没写好，还是因为循环空转了。
   */
  const bumpCounter = async (which: 'revise' | 'rewrite'): Promise<void> => {
    const e = state.chapters.find((c) => c.chapterNo === o.chapterNo);
    if (e === undefined) return;
    if (which === 'revise') e.reviseCount += 1;
    else e.rewriteCount += 1;
    await writeState(state);
  };

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
    const hashSnapshot = await snapshotChapterHashes(root, state.chapters);
    const gateResult = await runGates({ bookRoot: root, ...(o.signal !== undefined ? { signal: o.signal } : {}) });
    const chapterFindings = gateResult.findings.filter((f) => f.chapter === file);
    await applyGateResult(state, gateResult, { hashSnapshot });
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
          const hash = hashSnapshot.get(file) ?? '';
          await writeJudgeStatus(root, jr, hash);
          // needsReview（B-13）：判据出了 unsure（人工清单非空）→ 这章要人看。
          // 由判据结论派生，不单独维护——两处各记一遍必然漂移。
          const je = state.chapters.find((c) => c.chapterNo === o.chapterNo);
          if (je !== undefined) {
            je.needsReview = jr.manual.length > 0;
            await writeState(state);
          }
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
      // 过闸 → 清掉历史交接清单（B-69）。留着会让下次读的人以为「还卡着」
      await clearHandoff(root, o.chapterNo);
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
          ...reviseCfg,
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
            await bumpCounter('revise');
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
      const r = await callLLM(bundle, { purpose: 'revise', ...llmOpts });
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
      await bumpCounter('rewrite');
      rounds.push({ round: roundNo, phase: 'rewrite', findings: blocking.length, worst, action: 'rewrite' });
      continue;
    }

    // ── 两阶段都用完仍有拦截级 → 停下等人（B-12）──
    stopped = 'human-needed';
    {
      const reason = `定点修订 ${maxLocal} 轮 + 整章重写 ${maxRewrite} 轮后，仍有 ${blocking.length} 条拦截级问题`;
      const file = await writeHandoff(root, o.chapterNo, blocking, reason);
      handoff = { findings: blocking, reason, file };
    }
    // needsReview（B-13）：机器改不动了 = 这章必须有人看。这是结论字段，
    // 不许经 novel state --set 写进来（见 stripConclusions）。
    {
      const e = state.chapters.find((c) => c.chapterNo === o.chapterNo);
      if (e !== undefined && !e.needsReview) {
        e.needsReview = true;
        await writeState(state);
      }
    }
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
    stopped: assertStoppedConsistent(stopped, finalWorst),
    ...(handoff !== undefined ? { handoff } : {}),
    judge: judgeState,
    llmCalls,
  };
}