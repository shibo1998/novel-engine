import path from 'node:path';
import type { Command } from 'commander';
import { runEvalSet } from '@novel/core';

/**
 * novel eval：跑评测集，度量 Judge 的**检出率与假红率**（B-31 / v0.2 X7）。
 *
 * 治的是什么：Judge 建好之后，「它判得准不准」一直是个**没有数字的问题**。
 * B-64 要求「对真书跑一遍、人工抽查、假红率 < 20%」——那需要一个**可重复的仪器**，
 * 而不是每次手工拼章节、手工比对。
 *
 * ★评测集在 `<书根>/evals/<用例名>/`：`chapter.md` + `outline.md`(可选) + `expect.json`。
 * 评测在**临时目录**里造书跑，**不碰真书的 chapters/、state/、gateStatus**。
 *
 * ★三条口径：`unsure` 既不算检出也不算通过（单独一列）；
 * 检出率分母是 fail 用例、假红率分母是 pass 用例；用例数为 0 时是 `null` 不是 0。
 */
export function registerEval(program: Command): void {
  program
    .command('eval')
    .description('跑评测集度量 Judge 的检出率/假红率（在临时目录里跑，不碰真书）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--dir <d>', '评测集目录（相对书根或绝对），缺省 evals/')
    .option('--judge <id>', '只跑某个判据，可重复', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .action(async (opts: { book: string; dir?: string; judge: string[] }) => {
      const r = await runEvalSet(opts.book, {
        ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
        ...(opts.judge.length > 0 ? { judges: opts.judge } : {}),
      });
      process.stdout.write(JSON.stringify(r) + '\n');

      const pct = (v: number | null): string => (v === null ? '暂无数据' : `${(v * 100).toFixed(1)}%`);
      process.stderr.write(`评测集：${path.resolve(opts.book, r.setDir)}\n`);
      process.stderr.write(`用例 ${r.counts.total}（应检出 ${r.counts.fail}｜应放过 ${r.counts.pass}）\n\n`);
      process.stderr.write(`检出率　${pct(r.detectionRate)}（命中 ${r.counts.hit}/${r.counts.fail}）\n`);
      process.stderr.write(`假红率　${pct(r.falseAlarmRate)}（误报 ${r.counts.falseAlarm}/${r.counts.pass}）\n`);
      process.stderr.write(`unsure 　${pct(r.unsureRate)}（${r.counts.unsure}/${r.counts.total}）\n`);
      if (r.counts.fail === 0) process.stderr.write('  ⚠️ 没有「应检出」的用例——检出率是**没有数据**，不是 100%\n');
      if (r.counts.pass === 0) process.stderr.write('  ⚠️ 没有「应放过」的用例——假红率是**没有数据**，不是 0%\n');
      if (r.counts.unsure > 0) {
        process.stderr.write('  ⚠️ unsure **既不算检出也不算放过**（B-11 的语义）——它拉低不了假红率，也撑不起检出率\n');
      }

      process.stderr.write('\n逐例\n');
      for (const c of r.cases) {
        const mark = c.outcome === 'hit' ? '✓ 检出'
          : c.outcome === 'miss' ? '⛔ 漏检'
            : c.outcome === 'false-alarm' ? '⛔ 误报'
              : c.outcome === 'unsure' ? '… unsure'
                : c.outcome === 'no-judges' ? '⚠️ 判据没跑' : '✓ 放过';
        process.stderr.write(`  ${mark}　${c.name}（应${c.expect.verdict === 'fail' ? '检出' : '放过'}，实得 ${c.actual}）\n`);
        if (c.expect.note !== '') process.stderr.write(`      期望依据：${c.expect.note}\n`);
        for (const d of c.detail) {
          if (d.verdict === 'pass') continue;
          process.stderr.write(`      ${d.verdict}｜${d.id}｜${d.reason}\n`);
        }
      }
      process.stderr.write(
        '\n★这些数字只对**评测集本身**负责：用例是否覆盖了真实假红，取决于你放进去的样本。\n'
          + '  要给 B-64 一个可信结论，评测集里得有「真书里那些已知假红」的样本。\n',
      );
    });
}
