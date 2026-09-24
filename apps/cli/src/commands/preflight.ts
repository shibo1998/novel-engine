import type { Command } from 'commander';
import { checkChapterReadiness } from '@novel/core';

export function registerPreflight(program: Command): void {
  program
    .command('preflight')
    .description('检查本章正典与细纲准备情况（只提示，不阻断写作）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .action(async (opts: { book: string; chapter: number }) => {
      const readiness = await checkChapterReadiness(opts.book, opts.chapter);
      process.stdout.write(JSON.stringify(readiness) + '\n');
    });
}
