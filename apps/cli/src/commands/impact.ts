import path from 'node:path';
import type { Command } from 'commander';
import { analyzeImpact, rewriteInOrder } from '@novel/core';

/**
 * novel impact：设定变更的影响分析与顺序重写（B-41 / v0.2 L3）。
 *
 * ★三步，**中间那步必须是人**：
 *   ① 分析（`--term`）：机器找出哪些章提到了这些词，并给命中片段
 *   ② 圈定（`--chapters 3,7,12`）：**人**从中选真正要改的章——
 *      机器分不清「顺口提了一句」与「这一章的冲突建立在这个设定上」
 *   ③ 顺序重写（`--rewrite --instruction "..."`）：按**章号升序**逐章定点改
 *
 * ★不加 `--chapters` 时只做①，**不会动任何文件**。
 * 这是刻意的：影响分析是给人看的，圈定是人的决定。
 */
export function registerImpact(program: Command): void {
  program
    .command('impact')
    .description('设定变更影响分析（只读）；人工圈定 --chapters 后可 --rewrite 按章号升序定点重写')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--term <词>', '要查的关键词，可重复', (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option('--chapters <列表>', '人工圈定要重写的章号，如 3,7,12')
    .option('--rewrite', '真的执行重写（不给就是只分析）', false)
    .option('--instruction <说明>', '变更说明，如「林青的境界从炼气三层改为筑基初期」')
    .action(async (opts: {
      book: string;
      term: string[];
      chapters?: string;
      rewrite: boolean;
      instruction?: string;
    }) => {
      const root = path.resolve(opts.book);
      if (opts.term.length === 0) {
        throw new Error('缺少 --term（可重复）。例：--term 炼气三层 --term 炼气');
      }

      const report = await analyzeImpact(root, opts.term);
      process.stdout.write(JSON.stringify(report) + '\n');

      process.stderr.write(`关键词：${report.terms.join('、')}\n`);
      process.stderr.write(`抽取覆盖：${report.coverage.extracted}/${report.coverage.total} 章\n\n`);
      if (report.chapters.length === 0) {
        process.stderr.write('没有章节命中这些关键词。\n');
        if (report.coverage.extracted < report.coverage.total) {
          process.stderr.write(
            '  ⚠️ 但抽取覆盖率不满——「没命中」可能只是没抽过，而**正文是全文扫的**，'
              + '所以这里没命中是真的没有这几个字。\n',
          );
        }
      } else {
        process.stderr.write(`受影响的章（按命中数降序，共 ${report.chapters.length} 章）：\n`);
        for (const c of report.chapters) {
          const detail = Object.entries(c.hits).map(([t, n]) => `${t}×${n}`).join('、');
          process.stderr.write(`  第 ${String(c.chapterNo).padStart(3)} 章（${detail}）\n`);
          for (const e of c.excerpts.slice(0, 3)) {
            process.stderr.write(`      第 ${e.line} 行：${e.text}\n`);
          }
        }
      }
      if (report.relatedCharacters.length > 0) {
        process.stderr.write('\n事实库里相关的角色：\n');
        for (const c of report.relatedCharacters) {
          process.stderr.write(`  ${c.name}｜出场于第 ${c.chapters.join('、')} 章\n`);
        }
      }
      if (report.relatedForeshadows.length > 0) {
        process.stderr.write('\n台账里相关的伏笔：\n');
        for (const f of report.relatedForeshadows) {
          process.stderr.write(`  ${f.id} [${f.status}] 第 ${f.plantedChapter} 章：${f.content}\n`);
        }
      }

      if (!opts.rewrite) {
        process.stderr.write(
          '\n★以上只是**分析**，没有动任何文件。下一步是**你**从中圈定要改的章：\n'
            + '  novel impact --book <同一本书> --term ... --chapters 3,7,12 '
            + '--rewrite --instruction "把 X 改成 Y"\n'
            + '  为什么必须人来圈：机器分不清「顺口提了一句」与「这一章的冲突建立在这个设定上」。\n',
        );
        return;
      }

      if (opts.chapters === undefined) {
        throw new Error('--rewrite 必须配 --chapters（人工圈定）——机器不替你决定改哪几章');
      }
      if (opts.instruction === undefined || opts.instruction.trim() === '') {
        throw new Error('--rewrite 必须配 --instruction（说清改成什么）');
      }
      const chapters = opts.chapters.split(',').map((x) => Number.parseInt(x.trim(), 10));
      if (chapters.some((n) => !Number.isInteger(n) || n <= 0)) {
        throw new Error(`--chapters 形如 3,7,12，收到「${opts.chapters}」`);
      }

      process.stderr.write(`\n开始按**章号升序**重写（${[...new Set(chapters)].sort((a, b) => a - b).join(' → ')}）\n`);
      const r = await rewriteInOrder({ bookRoot: root, chapters, instruction: opts.instruction });
      process.stdout.write(JSON.stringify(r) + '\n');
      for (const x of r.results) {
        process.stderr.write(
          `  第 ${x.chapterNo} 章：改了 ${x.applied} 处`
            + (x.skipped > 0 ? `｜跳过 ${x.skipped} 处` : '')
            + (x.rejected !== null ? `｜⛔ 整批放弃：${x.rejected}` : '')
            + (x.noPatches ? '｜模型认为不受影响（**值得人工看一眼**）' : '')
            + '\n',
        );
      }
      if (r.stoppedAt !== undefined) {
        process.stderr.write(`\n⛔ 在第 ${r.stoppedAt.chapterNo} 章停下：${r.stoppedAt.reason}\n`
          + '  **后面的章没有继续改**——基于半成品往下改只会更乱。\n'
          + '  修好后从那一章重跑：--chapters <该章>,<其余>\n');
        process.exitCode = 1;
      } else {
        process.stderr.write(
          '\n✓ 全部改完。建议接着跑：\n'
            + '  novel gates --book <同一本书> --write   # 重跑机械闸门（正文变了，旧结论已作废）\n'
            + '  novel judge --book <同一本书> --chapter <章号>  # 语义判据\n',
        );
      }
    });
}
