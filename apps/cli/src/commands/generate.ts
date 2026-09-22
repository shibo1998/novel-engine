import type { Command } from 'commander';
import { buildPrompt, callLLM } from '@novel/core';

export function registerGenerate(program: Command): void {
  program
    .command('generate')
    .description('组装 prompt 并调用 LLM（对接 buildPrompt + callLLM）')
    .requiredOption('--stage <s>', '阶段标识')
    .option('--target <t>', '目标对象')
    .option('--model <m>', '模型名')
    .action(async (opts: { stage: string; target?: string; model?: string }) => {
      const bundle = await buildPrompt({
        stage: opts.stage,
        context: {},
        ...(opts.target !== undefined ? { target: opts.target } : {}),
      });
      const result = await callLLM(bundle, {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      });
      process.stdout.write(JSON.stringify(result) + '\n');
    });
}
