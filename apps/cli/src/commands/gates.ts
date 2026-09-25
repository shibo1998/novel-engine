import type { Command } from 'commander';
import { runGates, readState, writeState, applyGateResult, snapshotChapterHashes } from '@novel/core';

export function registerGates(program: Command): void {
  program
    .command('gates')
    .description('对书项目跑检查器（默认只读预览；--write 回填 gateStatus 并落盘）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--gate <name>', '跑哪个检查器（缺省 consistency_check）；可选 sensitive_check / duplicate_check / style_doc_check', 'consistency_check')
    .option('--write', '跑检查 → applyGateResult 回填 → writeState（**仅 consistency_check 可回填**）')
    .option('--file <path>', '（已废弃）检查器不支持单章级输入')
    .action(async (opts: { book: string; gate: string; write?: boolean; file?: string }) => {
      if (opts.file !== undefined) {
        throw new Error('检查器不支持单章级输入：请改用 --book <书根目录>（--file 已废弃）');
      }
      // ★书级闸门不许回填：它们的 `chapter_count` 恒为 0（如 style_doc_check），
      // 一旦接到 applyGateResult 的章数对账上必然抛错——那是**刻意的失败关闭**，
      // 不是「这里缺个特判」。所以在这一层就拦住，并说清为什么。
      if (opts.write === true && opts.gate !== 'consistency_check') {
        throw new Error(
          `--write 只支持 consistency_check（当前 --gate ${opts.gate}）。\n`
            + '  书级闸门（style_doc_check / sensitive_check / duplicate_check）的 chapter_count 恒为 0，\n'
            + '  接不到逐章回填上——它们的结论只在报告里，不进 gateStatus。\n'
            + `  只读预览：novel gates --book <书根> --gate ${opts.gate}`,
        );
      }
      if (opts.write !== true) {
        // 默认只读预览：不碰 state（与 core 无副作用、Web 可安全预览同一条原则）
        process.stdout.write(JSON.stringify(await runGates({ bookRoot: opts.book, gate: opts.gate })) + '\n');
        return;
      }
      // --write：编排层副作用集中于此。
      // ★三步顺序不能换（F17）：先 readState → 再对每章取**内容指纹**快照 → 最后才跑 gate。
      // 旧版是「跑完再读盘回填」，于是跑期间有人改章文件时，回填进来的是**新**内容指纹，
      // 等于把「跑期间的改动」算成已检（假绿窗口）。改成只认跑前快照后，跑期间的改动
      // 会因「当前指纹 ≠ checkedHash」在下次 readState 清扫时被置 null（回到待检）。
      // （v1 用的是 mtime，B-13 换成内容指纹——mtime 两个方向都会骗人。）
      // skipStaleSweep（F16）：本轮会把每一章的 gateStatus 整体覆写，清扫结果注定被丢弃，
      // 关掉它省掉一整轮全量读盘。
      const state = await readState({ bookRoot: opts.book, skipStaleSweep: true });
      const hashSnapshot = await snapshotChapterHashes(state.bookRoot, state.chapters);
      const result = await runGates({ bookRoot: opts.book });
      const checkedAt = await applyGateResult(state, result, { hashSnapshot });
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
