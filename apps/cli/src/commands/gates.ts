import type { Command } from 'commander';
import { runGates, readState, writeState, summarizeGateResult } from '@novel/core';

export function registerGates(program: Command): void {
  program
    .command('gates')
    .description('对书项目跑检查器（默认只读预览；--write 回填 gateStatus 并落盘）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--write', '跑检查 → summarizeGateResult → 回填 gateStatus → writeState')
    .option('--file <path>', '（已废弃）检查器不支持单章级输入')
    .action(async (opts: { book: string; write?: boolean; file?: string }) => {
      if (opts.file !== undefined) {
        throw new Error('检查器不支持单章级输入：请改用 --book <书根目录>（--file 已废弃）');
      }
      const result = await runGates({ bookRoot: opts.book });
      if (opts.write !== true) {
        // 默认只读预览：不碰 state（与 core 无副作用、Web 可安全预览同一条原则）
        process.stdout.write(JSON.stringify(result) + '\n');
        return;
      }
      // --write：编排层副作用集中于此
      const state = await readState({ bookRoot: opts.book });
      const summary = summarizeGateResult(result);
      // 同一批时间戳：命中章与 clean 章共享（summarize 内部时间戳在此统一覆盖）
      const checkedAt = new Date().toISOString();
      for (const ch of state.chapters) {
        const hit = summary.get(ch.file);
        // runGates 是全量扫描：未命中 findings 的章 = 本次检查通过，必须置 clean，
        // 否则上一轮的中等/严重会永远残留在索引里。索引有但 gate 没扫到的章同理。
        ch.gateStatus = hit !== undefined ? { ...hit, checkedAt } : { worst: 'clean', count: 0, checkedAt };
      }
      await writeState(state);
      process.stdout.write(JSON.stringify(state) + '\n');
    });
}
