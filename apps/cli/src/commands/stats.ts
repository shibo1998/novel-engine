import path from 'node:path';
import type { Command } from 'commander';
import { collectStats } from '@novel/core';

/**
 * novel stats：全书度量（B-29 / v0.2 M14.4）。
 *
 * ★北极星 = **人工改稿行数 / 千字**。
 * 「修订次数」「findings 数」「Judge 通过率」都只说明机器忙不忙；
 * 只有「人要动多少字」才说明**机器写出来的东西到底能不能用**。
 *
 * **不含成本统计**（作者 2026-09-25 裁定）：能在模型后台看到消耗，
 * 不需要工具再统计一遍；且单价表要猜。客观计数里只有「机器返工次数」。
 */
export function registerStats(program: Command): void {
  program
    .command('stats')
    .description('全书度量：人工改稿行数/千字（北极星）、机器返工次数、gates 与 Judge 通过率')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--per-chapter', '同时打印逐章明细', false)
    .action(async (opts: { book: string; perChapter: boolean }) => {
      const s = await collectStats(opts.book);
      process.stdout.write(JSON.stringify(s) + '\n');

      const title = path.basename(path.resolve(opts.book));
      process.stderr.write(`《${title}》 ${s.chapters} 章 / ${s.words} 字\n\n`);
      process.stderr.write('★ 北极星（越低越好）\n');
      process.stderr.write(
        `   人工改稿 ${s.human.editedLines} 行 / 千字 = ${s.human.editedLinesPerKilo}`
          + `（${s.human.feedbackEntries} 条改稿记录）\n`,
      );
      if (s.human.feedbackEntries === 0) {
        process.stderr.write(
          '   ⚠️ 还没有任何改稿记录 —— 这个数**不是 0，是没有数据**。\n'
            + '      人工改完稿后跑：novel feedback add --book <同一本书> --chapter <n> --file <改后稿>\n',
        );
      }
      process.stderr.write('\n机器返工\n');
      process.stderr.write(
        `   定点修订 ${s.rework.reviseCount} 次｜整章重写 ${s.rework.rewriteCount} 次`
          + `（涉及 ${s.rework.chaptersTouched} 章）\n`,
      );
      process.stderr.write('\n结论\n');
      process.stderr.write(
        `   机械 gates：${s.gates.checked} 章有结论（clean ${s.gates.clean}｜拦截级 ${s.gates.blocking}）\n`,
      );
      process.stderr.write(
        `   语义判据：${s.judge.checked} 章有结论`
          + `（通过率 ${s.judge.passRate === null ? '暂无数据' : String(s.judge.passRate)}`
          + `｜拦截 ${s.judge.failing}｜人工清单 ${s.judge.manual}）\n`,
      );
      const pending = s.perChapter.filter((c) => c.needsReview).length;
      if (pending > 0) process.stderr.write(`   ⚠️ ${pending} 章待人看（needsReview）\n`);

      if (opts.perChapter) {
        process.stderr.write('\n逐章\n');
        for (const c of s.perChapter) {
          process.stderr.write(
            `   第 ${String(c.chapterNo).padStart(3)} 章 ${c.wordCount} 字`
              + `｜gates ${c.gateWorst ?? '待检'}｜判据 ${c.judgeWorst ?? '未跑'}`
              + `｜返工 ${c.reviseCount}+${c.rewriteCount}｜人工 ${c.humanEditedLines} 行`
              + (c.needsReview ? '｜👁 待人看' : '')
              + '\n',
          );
        }
      }
    });
}
