import type { Command } from 'commander';
import { updateChapterSummary } from '@novel/core';

export function registerSummarize(program: Command): void {
  program
    .command('summarize')
    .description('生成或刷新指定章节的长篇上下文摘要')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .action(async (opts: { book: string; chapter: number }) => {
      const result = await updateChapterSummary(opts.book, opts.chapter);
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!result.ok) process.exitCode = 1;
    });
}
