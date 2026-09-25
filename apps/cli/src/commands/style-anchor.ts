import path from 'node:path';
import type { Command } from 'commander';
import { buildStyleAnchor } from '@novel/core';

/**
 * novel style-anchor：文风样稿提炼（B-48 / v0.2 附 A）。
 *
 * 治的是什么：`checks.rhythm` 的阈值按规矩**必须来自实测**，而
 * 「等拆完样板书再校准」常常永远等不到——于是新书一直带着 `enabled: false` 跑，
 * **节拍这一项从未生效**。
 *
 * ★产物是**锚点**不是闸门：`anchors/style.md` 给人看，
 * 建议阈值给人**粘贴**（不自动写进 book.json）——自动改配置会让
 * 「谁把阈值调成这个数」变得无从追问。
 *
 * ★**按现状校准只会固化现状**。想让文风真的变，用 `--from <样板书目录>`。
 */
export function registerStyleAnchor(program: Command): void {
  program
    .command('style-anchor')
    .description('从实测样本提炼文风节拍并给出可粘贴的 checks.rhythm 阈值（--from 按样板书校准）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--from <dir>', '样板书目录（相对书根或绝对）；目录里放 .txt 原文')
    .option('--write', '写 anchors/style.md（默认只报告）', false)
    .action(async (opts: { book: string; from?: string; write: boolean }) => {
      const r = await buildStyleAnchor(opts.book, {
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        write: opts.write,
      });
      process.stdout.write(JSON.stringify({
        source: r.source, metrics: r.metrics, suggested: r.suggested, blocked: r.blocked, file: r.file,
      }) + '\n');

      process.stderr.write(`样本来源：${r.source}\n`);
      if (r.metrics.length > 0) {
        process.stderr.write('\n实测指标（分位）\n');
        for (const m of r.metrics) {
          process.stderr.write(`  ${m.name}｜min ${m.min}｜P25 ${m.p25}｜中位 ${m.median}｜P75 ${m.p75}｜max ${m.max}\n`);
        }
      }
      if (r.suggested !== null) {
        process.stderr.write('\n建议阈值（粘进 book.json 的 checks.rhythm）\n');
        process.stderr.write(JSON.stringify(r.suggested, null, 2).split('\n').map((l) => `  ${l}`).join('\n') + '\n');
      } else {
        process.stderr.write('\n⚠️ 没能从检查器输出里解析出阈值块——请人工看原始输出（stdout 里有 raw）。\n');
      }
      if (r.blocked !== null) {
        process.stderr.write(
          `\n⚠️ 按此值，本样本中 ${r.blocked.hit}/${r.blocked.total} 篇会被拦。\n`
            + '  注意这不是「四分之一」：四个指标各自罚最差四分位，只要有任何一项越线就算被拦，并集自然大得多。\n',
        );
      }
      if (opts.from === undefined) {
        process.stderr.write(
          '\n★**按现状取分位只会固化现状**。想让文风真的变：\n'
            + '  novel style-anchor --book <同一本书> --from <样板书目录> --write\n'
            + '  （样板书目录里放 .txt 原文；同时有 .md 时只用 .txt——.md 是拆解报告，混进来会带偏统计。）\n',
        );
      }
      process.stderr.write(
        r.file !== null
          ? `\n已写 ${r.file}（**改它不生效**——要改标准请改 book.json 的 checks.rhythm）。\n`
          : '\n（未写文件。加 --write 落 anchors/style.md。）\n',
      );
    });
}
