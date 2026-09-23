import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { recordFeedback } from '@novel/core';

export function registerFeedback(program: Command): void {
  program
    .command('feedback')
    .description('反馈记录（对接 recordFeedback：落 feedback.jsonl + diff 聚合规则候选，不动生效规则）')
    .command('add')
    .description('把人工改后稿与原章 diff：落 .soloent/feedback.jsonl，并生成规则候选到 rules/_candidates/')
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
      // 同时报出两个落点：jsonl 是唯一不可重建的（永久），候选是派生的（可重生成）
      process.stdout.write(
        JSON.stringify({
          feedbackLog: '.soloent/feedback.jsonl',
          candidates: result.candidates.length,
        }) + '\n',
      );
    });
}
