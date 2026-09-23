import type { Command } from 'commander';
import { writeChapter } from '@novel/core';

export function registerWrite(program: Command): void {
  program
    .command('write')
    .description('起草一章（对接 writeChapter：draft 流水线，LLM 失败不落盘不改 state）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .action(async (opts: { book: string; chapter: number }) => {
      const result = await writeChapter({ bookRoot: opts.book, chapterNo: opts.chapter });
      if (!result.ok) {
        const llm = result.llm;
        const status = llm !== undefined && !llm.ok && 'status' in llm ? `${llm.status} ` : '';
        const detail = llm !== undefined && !llm.ok ? llm.detail : '未知错误';
        const kind = llm !== undefined && !llm.ok ? llm.kind : 'unknown';
        throw new Error(`LLM 调用失败 [${kind}] ${status}${detail}（未落盘、未改 state）`);
      }
      process.stdout.write(JSON.stringify(result) + '\n');
    });
}
