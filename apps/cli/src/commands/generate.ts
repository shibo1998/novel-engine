import type { Command } from 'commander';
import { buildPrompt, callLLM, readState, runGates } from '@novel/core';
import type { GateFinding } from '@novel/core';

export function registerGenerate(program: Command): void {
  program
    .command('generate')
    .description('组装 prompt 并调用 LLM（对接 buildPrompt + callLLM）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .option('--mode <mode>', 'draft | revise', 'draft')
    .action(async (opts: { book: string; chapter: number; mode: string }) => {
      if (opts.mode !== 'draft' && opts.mode !== 'revise') {
        throw new Error(`--mode 只接受 draft | revise，收到：${opts.mode}`);
      }
      let findings: GateFinding[] | undefined;
      if (opts.mode === 'revise') {
        const state = await readState({ bookRoot: opts.book });
        const entry = state.chapters.find((c) => c.chapterNo === opts.chapter);
        if (entry === undefined) {
          throw new Error(`第 ${opts.chapter} 章不在索引中，无法 revise`);
        }
        const gateResult = await runGates({ bookRoot: opts.book });
        findings = gateResult.findings.filter((f) => f.chapter === entry.file);
      }
      const bundle = await buildPrompt({
        bookRoot: opts.book,
        chapterNo: opts.chapter,
        mode: opts.mode,
        ...(findings !== undefined ? { findings } : {}),
      });
      const result = await callLLM(bundle);
      if (!result.ok) {
        // CLI 契约：失败走 stderr + 非 0；kind 编入 message 供人判别
        const status = 'status' in result ? `${result.status} ` : '';
        throw new Error(`LLM 调用失败 [${result.kind}] ${status}${result.detail}`);
      }
      process.stdout.write(JSON.stringify(result) + '\n');
    });
}
