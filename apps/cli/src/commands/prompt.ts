import type { Command } from 'commander';
import { buildPrompt } from '@novel/core';

export function registerPrompt(program: Command): void {
  program
    .command('prompt')
    .description('组装 prompt（对接 buildPrompt）')
    .requiredOption('--stage <s>', '阶段标识')
    .option('--target <t>', '目标对象')
    .action(async (opts: { stage: string; target?: string }) => {
      const result = await buildPrompt({
        stage: opts.stage,
        context: {},
        ...(opts.target !== undefined ? { target: opts.target } : {}),
      });
      process.stdout.write(JSON.stringify(result) + '\n');
    });
}
