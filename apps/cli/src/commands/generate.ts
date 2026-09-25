import type { Command } from 'commander';
import { assertPlanReady, assertStyleReady, convergeChapter } from '@novel/core';

export function registerGenerate(program: Command): void {
  program
    .command('generate')
    .description('收敛循环：缺章先起草 → 定点修订 ≤2 轮 → 整章重写 ≤1 轮 → 仍不过闸则停下等人（B-12）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .option('--local-rounds <n>', '定点修订轮次上限（缺省 2）', (v: string) => Number.parseInt(v, 10))
    .option('--rewrite-rounds <n>', '整章重写轮次上限（缺省 1）', (v: string) => Number.parseInt(v, 10))
    .option('--no-judge', '本轮不跑语义判据（默认跑；未声明判据的书自动跳过并在结果里标 not-declared）')
    .action(async (opts: {
      book: string;
      chapter: number;
      localRounds?: number;
      rewriteRounds?: number;
      judge: boolean;
    }) => {
      // 风格/红线层未就绪 → 拒绝生成。放在最前面：一旦开始收敛就会烧 LLM 额度，
      // 这道门必须在**花钱之前**，而不是等三轮改写跑完再报「其实没规则可依」。
      await assertStyleReady(opts.book);
      // 逐层蓝图未就绪 → 拒绝生成（B-10）。与风格闸门同一位置、同一理由：
      // 逐层流程的全部意义就是「上层没定就不许往下写」；闸门若不接在这里，
      // plan.json 就只是一份没人看的记录。
      // 没有 .soloent/plan.json 的书恒为就绪 —— 旧书不被连坐。
      await assertPlanReady(opts.book, opts.chapter);
      const result = await convergeChapter({
        bookRoot: opts.book,
        chapterNo: opts.chapter,
        judge: opts.judge,
        ...(opts.localRounds !== undefined ? { maxLocalRounds: opts.localRounds } : {}),
        ...(opts.rewriteRounds !== undefined ? { maxRewriteRounds: opts.rewriteRounds } : {}),
      });
      process.stdout.write(JSON.stringify(result) + '\n');
      // 退出码（B-14 语义：exit 只表示「这次运行怎么结束的」，内容结论一律看 JSON）：
      //   0 = 跑完（clean / clean-advisory）
      //   1 = 运行故障（LLM 失败 / 起草失败 / 门禁状态自相矛盾）
      //   3 = 需要人工介入（human-needed：机器两阶段都用完仍有拦截级问题）
      if (result.stopped === 'llm-error' || result.stopped === 'draft-failed') {
        const err = result.draftError ?? result.rounds.find((r) => r.llmError !== undefined)?.llmError;
        const kind = err !== undefined && !err.ok ? err.kind : 'unknown';
        const detail = err !== undefined && !err.ok ? err.detail : '';
        process.stderr.write(`收敛中断 [${kind}] ${detail}\n`);
        process.exitCode = 1;
      }
      if (result.stopped === 'gate-inconsistent') {
        // 门禁状态与 findings 对不上是程序 bug，不是「没问题」——非 0 让它无法被忽略
        process.stderr.write(
          '⛔ 门禁状态自相矛盾：gateStatus 与 findings 的键对不上（回填/聚合有 bug），本轮已停下，未继续改写。\n',
        );
        process.exitCode = 1;
      }
      if (result.stopped === 'human-needed') {
        // B-12：机器改不动了。把未解决的问题连同引句一起交给人，而不是报一个
        // 与「问题不大」同形的 max-rounds。
        const h = result.handoff;
        process.stderr.write(
          `⛔ 机器改不动了，停下等人：${h?.reason ?? '仍有拦截级问题'}\n`
            + (h?.findings ?? []).map((f) => `  · ${f.check}\n    引句：${f.detail}\n`).join('')
            + '  改完直接重跑本命令；或先看判据结论：'
            + 'novel judge --book <同一本书> --chapter <章号> --status\n',
        );
        process.exitCode = 3;
      }
    });
}
