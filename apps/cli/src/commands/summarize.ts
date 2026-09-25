import type { Command } from 'commander';
import { proposeStateCard, updateChapterSummary } from '@novel/core';

export function registerSummarize(program: Command): void {
  program
    .command('summarize')
    .description('生成或刷新指定章节的长篇上下文摘要；--state-card 另出当前状态卡更新建议（只写 state/now.proposed.md，不动 now.md）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .option('--state-card', '同时生成当前状态卡更新建议', false)
    .action(async (opts: { book: string; chapter: number; stateCard: boolean }) => {
      const result = await updateChapterSummary(opts.book, opts.chapter);
      if (!opts.stateCard || !result.ok) {
        process.stdout.write(JSON.stringify(result) + '\n');
        if (!result.ok) process.exitCode = 1;
        return;
      }
      const card = await proposeStateCard(opts.book, opts.chapter);
      process.stdout.write(JSON.stringify({ summary: result, stateCard: card }) + '\n');
      if (!card.ok) process.exitCode = 1;
      else process.stderr.write(`状态卡建议已写入 ${card.proposedFile}；请与 now.md 比对后手工合并\n`);
    });
}
