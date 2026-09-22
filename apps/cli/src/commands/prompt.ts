import type { Command } from 'commander';
import { buildPrompt, readState, runGates } from '@novel/core';
import type { GateFinding } from '@novel/core';

export function registerPrompt(program: Command): void {
  program
    .command('prompt')
    .description('组装 prompt（对接 buildPrompt；revise 模式内部跑 gates 取 findings）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .option('--mode <mode>', 'draft | revise', 'draft')
    .option('--dump', '输出完整 PromptBundle（默认输出摘要）')
    .action(async (opts: { book: string; chapter: number; mode: string; dump?: boolean }) => {
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
      const out = opts.dump === true
        ? bundle
        : {
            systemChars: [...bundle.system].length,
            userChars: [...bundle.user].length,
            ruleRefs: bundle.ruleRefs,
          };
      process.stdout.write(JSON.stringify(out) + '\n');
    });
}
