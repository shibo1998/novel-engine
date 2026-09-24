import type { Command } from 'commander';
import { convergeChapter } from '@novel/core';

export function registerGenerate(program: Command): void {
  program
    .command('generate')
    .description('收敛循环（对接 convergeChapter：缺章先起草，gate→revise 至 clean，上限 3 轮）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .option('--max-rounds <n>', '收敛上限轮次', (v: string) => Number.parseInt(v, 10))
    .action(async (opts: { book: string; chapter: number; maxRounds?: number }) => {
      const result = await convergeChapter({
        bookRoot: opts.book,
        chapterNo: opts.chapter,
        ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
      });
      process.stdout.write(JSON.stringify(result) + '\n');
      // 目标未达成且因执行错误而停（LLM 失败 / 起草失败 / 门禁状态自相矛盾）→ 非 0；
      // clean / clean-advisory（只剩提示级）/ max-rounds 为合法结果 → 0。
      // 注意 max-rounds 也是 0：它表示「跑了上限轮仍未清空拦截级发现」，调用方
      // （如 novel book）应据 isPassingWorst(finalWorst) 自行判停，而不是靠退出码。
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
    });
}
