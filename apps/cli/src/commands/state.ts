import type { Command } from 'commander';
import { readState, writeState } from '@novel/core';
import type { StoryState } from '@novel/core';

export function registerState(program: Command): void {
  program
    .command('state')
    .description('读取或写入状态（对接 readState / writeState）')
    .option('--set <json>', '写入状态的 JSON 字符串；不传则读取')
    .action(async (opts: { set?: string }) => {
      if (opts.set !== undefined) {
        const parsed = JSON.parse(opts.set) as StoryState;
        const ret = await writeState(parsed);
        process.stdout.write(JSON.stringify(ret ?? null) + '\n');
      } else {
        const state = await readState();
        process.stdout.write(JSON.stringify(state) + '\n');
      }
    });
}
