import type { Command } from 'commander';
import { runGates } from '@novel/core';

export function registerGates(program: Command): void {
  program
    .command('gates')
    .description('对目标文件跑检查器（对接 runGates）')
    .requiredOption('--file <path>', '目标 markdown 文件路径')
    .action(async (opts: { file: string }) => {
      const results = await runGates(opts.file);
      process.stdout.write(JSON.stringify(results) + '\n');
    });
}
