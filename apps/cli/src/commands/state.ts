import type { Command } from 'commander';
import { readState, writeState } from '@novel/core';
import type { StoryState } from '@novel/core';

export function registerState(program: Command): void {
  program
    .command('state')
    .description('读取或重建章节索引（对接 readState / writeState）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--rebuild', '强制重建索引并落盘')
    .option('--set <json>', '（保留）直接写入给定状态 JSON')
    .action(async (opts: { book: string; rebuild?: boolean; set?: string }) => {
      if (opts.set !== undefined) {
        const parsed = JSON.parse(opts.set) as StoryState;
        const ret = await writeState(parsed);
        process.stdout.write(JSON.stringify(ret ?? null) + '\n');
        return;
      }
      if (opts.rebuild === true) {
        const rebuilt = await readState({ bookRoot: opts.book, force: true });
        await writeState(rebuilt);
        process.stdout.write(JSON.stringify(rebuilt) + '\n');
        return;
      }
      const state = await readState({ bookRoot: opts.book });
      process.stdout.write(JSON.stringify(state) + '\n');
    });
}
