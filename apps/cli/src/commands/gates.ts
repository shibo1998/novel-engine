import type { Command } from 'commander';
import { runGates } from '@novel/core';

export function registerGates(program: Command): void {
  program
    .command('gates')
    .description('对书项目跑检查器（对接 runGates）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--file <path>', '（已废弃）检查器不支持单章级输入')
    .action(async (opts: { book: string; file?: string }) => {
      if (opts.file !== undefined) {
        throw new Error('检查器不支持单章级输入：请改用 --book <书根目录>（--file 已废弃）');
      }
      const result = await runGates({ bookRoot: opts.book });
      process.stdout.write(JSON.stringify(result) + '\n');
    });
}
