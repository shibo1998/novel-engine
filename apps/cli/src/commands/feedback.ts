import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { recordFeedback } from '@novel/core';

export function registerFeedback(program: Command): void {
  program
    .command('feedback')
    .description('反馈记录（对接 recordFeedback：diff 聚合规则候选，不动生效规则）')
    .command('add')
    .description('用人工改后稿与原章 diff，生成规则候选到 rules/_candidates/')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .requiredOption('--file <path>', '人工改后稿的文件路径')
    .action(async (opts: { book: string; chapter: number; file: string }) => {
      const revisedText = await readFile(opts.file, 'utf-8');
      const result = await recordFeedback({
        bookRoot: opts.book,
        chapterNo: opts.chapter,
        revisedText,
      });
      process.stdout.write(JSON.stringify({ candidates: result.candidates.length }) + '\n');
    });
}
