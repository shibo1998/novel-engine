import type { Command } from 'commander';
import { recordFeedback } from '@novel/core';

export function registerFeedback(program: Command): void {
  program
    .command('feedback')
    .description('反馈记录（对接 recordFeedback）')
    .command('add')
    .description('新增一条反馈')
    .requiredOption('--chapter <n>', '章节号', (v: string) => Number.parseInt(v, 10))
    .requiredOption('--category <c>', '反馈类别')
    .requiredOption('--original <s>', '原文')
    .requiredOption('--revised <s>', '修订后文本')
    .action(async (opts: { chapter: number; category: string; original: string; revised: string }) => {
      const ret = await recordFeedback({
        chapter: opts.chapter,
        category: opts.category,
        original: opts.original,
        revised: opts.revised,
      });
      process.stdout.write(JSON.stringify(ret ?? null) + '\n');
    });
}
