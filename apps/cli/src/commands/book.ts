import path from 'node:path';
import type { Command } from 'commander';
import { assertStyleReady, checkChapterReadiness, checkPlanGate, convergeChapter, readState, updateChapterSummary } from '@novel/core';

interface ChapterRun {
  chapterNo: number;
  drafted: boolean;
  stopped: string;
  finalWorst: string;
  llmCalls: number;
  summary: 'ok' | 'skipped' | `failed:${string}`;
  readinessWarnings: string[];
  /** human-needed 时的交接清单条数（未解决的拦截级问题） */
  handoffFindings?: number;
  handoffReason?: string;
}

/**
 * novel book：逐章跑完一本。
 *
 * 为什么需要它：此前只有 `generate --chapter N`（一次一章），「跑完一本」只能靠人
 * 在面板上一章一章点。从零验证整条链路（配置 → 正典/细纲 → 起草 → 过闸 → 修改 →
 * 摘要 → 状态回填）因此只能手工拼，也就没人真拼过。
 *
 * 三条纪律写死在实现里：
 *   ① 任一章没过闸即**停**，不接着写下一章（沿用「过闸才许写下一章」的项目约定）；
 *   ② 有**总额度闸**（--max-llm-calls），不会因为某处异常把额度一路烧光；
 *   ③ 断点可续跑（--from 缺省＝已有章数 + 1），重跑不会从头再来。
 * 输出契约与其余子命令一致：人类可读走 stderr，结构化结果走 stdout。
 */
export function registerBook(program: Command): void {
  program
    .command('book')
    .description('逐章跑完一本：预检 → 收敛起草/改写 → 逐章摘要；任一章没过闸即停并报断点')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--from <n>', '起始章号（缺省＝已有最大章号 + 1）', (v: string) => Number.parseInt(v, 10))
    .option('--to <n>', '结束章号（含）；缺省时只跑 --from 那一章', (v: string) => Number.parseInt(v, 10))
    .option('--max-llm-calls <n>', '本轮 LLM 请求总额度闸，触顶即停', (v: string) => Number.parseInt(v, 10), 60)
    .option('--no-summarize', '不逐章生成摘要（省一半请求，但长篇上下文会退化）')
    .action(async (opts: {
      book: string;
      from?: number;
      to?: number;
      maxLlmCalls: number;
      summarize: boolean;
    }) => {
      const root = path.resolve(opts.book);
      // 风格/红线层未就绪 → 拒绝开跑。批量的代价最大（一次可能连写几十章），
      // 必须挡在**第一次 LLM 请求之前**，而不是写到第 N 章才发现全书没有文风依据
      // （这正是本项目出过的事故形态：19 章连发、从第 15 章起设定全线漂移）。
      await assertStyleReady(root);
      const state = await readState({ bookRoot: root }); // 顺带校验 bookRoot 是目录
      const existingMax = state.chapters.reduce((m, c) => Math.max(m, c.chapterNo), 0);
      const from = opts.from ?? existingMax + 1;
      const to = opts.to ?? from;
      if (!Number.isInteger(from) || from <= 0) throw new Error(`--from 必须是正整数，收到 ${opts.from}`);
      if (!Number.isInteger(to) || to < from) throw new Error(`--to 必须 ≥ --from（收到 ${from}→${to}）`);
      const budget = opts.maxLlmCalls;
      if (!Number.isInteger(budget) || budget <= 0) throw new Error('--max-llm-calls 必须是正整数');

      process.stderr.write(
        `novel book：第 ${from}–${to} 章（已有 ${state.chapters.length} 章）｜`
          + `额度闸 ${budget} 次 LLM 请求｜逐章摘要 ${opts.summarize ? '开' : '关'}\n`,
      );

      const runs: ChapterRun[] = [];
      let usedCalls = 0;
      let stoppedBy: 'completed' | 'chapter-not-passed' | 'budget-exhausted' | 'plan-not-ready' | 'human-needed' = 'completed';

      for (let n = from; n <= to; n++) {
        if (usedCalls >= budget) {
          stoppedBy = 'budget-exhausted';
          process.stderr.write(`⛔ 额度用完（${usedCalls}/${budget}），在第 ${n} 章前停下。\n`);
          break;
        }
        // 逐层蓝图闸门（B-10）：**逐章**查而不是开跑前查一次——每一章可能属于不同的卷，
        // 卷纲/细纲是按卷确认的。这里用 checkPlanGate 而非 assertPlanReady：批量跑要把
        // 「哪一章卡住、断点在哪」写进结构化报告，而不是抛异常把整份报告冲掉。
        // 没有 .soloent/plan.json 的书 enabled=false，恒为就绪（旧书不被连坐）。
        const planGate = await checkPlanGate(root, n);
        if (planGate.enabled && !planGate.ready) {
          stoppedBy = 'plan-not-ready';
          process.stderr.write(
            `⛔ 第 ${n} 章逐层蓝图未就绪，按「上层没定不许往下写」停下：\n`
              + planGate.blocking.map((b) => `  · ${b}\n`).join('')
              + '  看现状与下一层：novel plan status --book <同一本书>\n',
          );
          break;
        }
        const readiness = await checkChapterReadiness(root, n);

        const g = await convergeChapter({ bookRoot: root, chapterNo: n });
        usedCalls += g.llmCalls;

        let summary: ChapterRun['summary'] = 'skipped';
        // 只有真的写成了章才谈得上摘要（起草失败时无章可摘）
        if (opts.summarize && g.stopped !== 'draft-failed') {
          const s = await updateChapterSummary(root, n);
          usedCalls += 1;
          summary = s.ok ? 'ok' : `failed:${s.kind}`;
        }

        const run: ChapterRun = {
          chapterNo: n,
          drafted: g.drafted,
          stopped: g.stopped,
          finalWorst: g.finalWorst,
          llmCalls: g.llmCalls,
          summary,
          readinessWarnings: readiness.warnings,
          ...(g.handoff !== undefined
            ? { handoffFindings: g.handoff.findings.length, handoffReason: g.handoff.reason }
            : {}),
        };
        runs.push(run);
        process.stderr.write(
          `第 ${n} 章：${g.stopped}（worst=${g.finalWorst}，LLM×${g.llmCalls}，摘要 ${summary}`
            + `，判据 ${g.judge}）`
            + (readiness.warnings.length > 0 ? `｜写前提醒 ${readiness.warnings.length} 条` : '')
            + '\n',
        );

        // 过闸判据与收敛循环同一来源：**只有 clean / clean-advisory 算过闸**。
        // B-12 之后不再有含混的 max-rounds 态——「轮数用完但问题也不大」与
        // 「机器改不动了」是两种处境，前者不该存在（问题不大就不会继续改写），
        // 后者单列为 human-needed 并带上交接清单。
        const passed = g.stopped === 'clean' || g.stopped === 'clean-advisory';
        if (!passed) {
          if (g.stopped === 'human-needed') {
            stoppedBy = 'human-needed';
            process.stderr.write(
              `⛔ 第 ${n} 章机器改不动了（${g.handoff?.reason ?? '仍有拦截级问题'}），停下等人。\n`
                + (g.handoff?.findings ?? []).map((f) => `  · ${f.check}\n    引句：${f.detail}\n`).join('')
                + `  修好后重跑本命令（会从第 ${n} 章接着跑）。\n`,
            );
          } else {
            stoppedBy = 'chapter-not-passed';
            process.stderr.write(
              `⛔ 第 ${n} 章未过闸（${g.stopped}），按「过闸才许写下一章」停下；修好后续跑：`
                + `novel book --book <同一本书>（会从第 ${n} 章接着跑）\n`,
            );
          }
          break;
        }
      }

      const last = runs.at(-1);
      const report = {
        bookRoot: root,
        planned: { from, to },
        stoppedBy,
        completedChapters: runs.filter((r) => r.stopped === 'clean' || r.stopped === 'clean-advisory').length,
        breakpoint: stoppedBy === 'completed' ? null : (last?.chapterNo ?? from),
        llmCallsUsed: usedCalls,
        budget,
        runs,
      };
      process.stdout.write(JSON.stringify(report) + '\n');
      // 退出码（B-14）：0 = 跑完；1 = 没走完（未过闸 / 额度用完 / 蓝图未就绪）；
      // 3 = 需要人工介入（机器改不动了，交接清单在 report.runs[].handoff*）
      if (stoppedBy === 'human-needed') process.exitCode = 3;
      else if (stoppedBy !== 'completed') process.exitCode = 1;
    });
}
