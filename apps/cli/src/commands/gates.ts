import type { Command } from 'commander';
import { runGates, readState, writeState, applyGateResult, snapshotChapterMtimes } from '@novel/core';

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
      if (opts.write !== true) {
        // 默认只读预览：不碰 state（与 core 无副作用、Web 可安全预览同一条原则）
        process.stdout.write(JSON.stringify(await runGates({ bookRoot: opts.book })) + '\n');
        return;
      }
      // --write：编排层副作用集中于此。
      // ★三步顺序不能换（F17）：先 readState → 再对每章取 mtime 快照 → 最后才跑 gate。
      // 旧版是「跑完再 stat 回填」，于是跑期间有人改章文件时，回填进来的是**新** mtime，
      // 等于把「跑期间的改动」算成已检（假绿窗口）。改成只认跑前快照后，跑期间的改动
      // 会因「当前 mtime ≠ checkedMtimeMs」在下次 readState 清扫时被置 null（回到待检）。
      const state = await readState({ bookRoot: opts.book });
      const mtimeSnapshot = await snapshotChapterMtimes(state.bookRoot, state.chapters);
      const result = await runGates({ bookRoot: opts.book });
      const checkedAt = await applyGateResult(state, result, { mtimeSnapshot });
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
