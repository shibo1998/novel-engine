import type { Command } from 'commander';
import { runGates, readState, writeState, applyGateResult } from '@novel/core';

export function registerGates(program: Command): void {
  program
    .command('gates')
    .description('对书项目跑检查器（默认只读预览；--write 回填 gateStatus 并落盘）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--write', '跑检查 → applyGateResult 回填 → writeState')
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
      // applyGateResult 内部做的正是「跑后 stat 回填 mtime」——
      // 注意它与 runGates 之间的窗口期：若此刻有人改章文件，回填进来的已是新 mtime，
      // 等于把「跑期间的改动」算成已检（假绿）。彻底封死需要跑前抓快照（见下方 TODO）。
      // TODO(假绿窗口)：runGates 前 stat 一遍 chapters/ 做快照，回填时优先用快照值而非当前 mtime。
      const checkedAt = await applyGateResult(state, result);
      await writeState(state);
      process.stdout.write(
        JSON.stringify({
          checkedAt,
          chapters: state.chapters.length,
          // 回填后的状态分布：能一眼看出「有几章真的绿了」，而不是只看到一堆 null
          written: state.chapters.filter((c) => c.gateStatus !== null).length,
        }) + '\n',
      );
    });
}
