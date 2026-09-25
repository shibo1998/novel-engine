import path from 'node:path';
import type { Command } from 'commander';
import {
  characterStateUpTo,
  extractChapter,
  readFacts,
  readState,
  rollbackChapterFacts,
} from '@novel/core';

/**
 * novel extract：每章抽事实（B-20 / v0.2 M5）。
 *
 * 为什么需要它：`now.md` 状态卡（B-01）是作者手写的**短期过渡方案**，
 * 它只能表达「此刻」——想回答「第 20 章时林青的伤好了没」只能翻正文。
 * Extractor 把每章的事实抽出来存成结构化记录，这类问题就变成一次查询。
 *
 * ★每条事实都带原文引句，**引句命不中正文就整条丢弃**（不是降级保留）。
 * 这些事实会喂给后续章节的 prompt——一条编造的事实会像真的一样被引用、
 * 被传播，而且再也查不出源头。**长期记忆里宁可少一条，不可多一条假的。**
 */
export function registerExtract(program: Command): void {
  program
    .command('extract')
    .description('抽一章的事实（人物状态/伏笔/时间线）；引句命不中正文的条目整条丢弃')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--chapter <n>', '抽哪一章', (v: string) => Number.parseInt(v, 10))
    .option('--from <n>', '批量：起始章号', (v: string) => Number.parseInt(v, 10))
    .option('--to <n>', '批量：结束章号（含）', (v: string) => Number.parseInt(v, 10))
    .option('--rollback <n>', '撤回某一章的事实（不重抽；改设定后常要先撤回再批量重抽）', (v: string) => Number.parseInt(v, 10))
    .option('--status', '只读：看已抽了哪些章、丢弃了多少条', false)
    .option('--character <name>', '查某人「截至 --chapter 为止」的状态')
    .action(async (opts: {
      book: string;
      chapter?: number;
      from?: number;
      to?: number;
      rollback?: number;
      status: boolean;
      character?: string;
    }) => {
      const root = path.resolve(opts.book);

      if (opts.rollback !== undefined) {
        const prev = await rollbackChapterFacts(root, opts.rollback);
        process.stdout.write(JSON.stringify({ rolledBack: prev !== null, chapterNo: opts.rollback }) + '\n');
        process.stderr.write(
          prev === null
            ? `第 ${opts.rollback} 章本来就没有事实记录。\n`
            : `已撤回第 ${opts.rollback} 章的事实（${prev.characters.length} 角色 / `
              + `${prev.foreshadows.length} 伏笔 / ${prev.timeline.length} 时间线）。\n`
              + '  重抽：novel extract --book <同一本书> --chapter ' + String(opts.rollback) + '\n',
        );
        return;
      }

      if (opts.status || opts.character !== undefined) {
        const [store, state] = await Promise.all([readFacts(root), readState({ bookRoot: root })]);
        if (opts.character !== undefined) {
          const upto = opts.chapter ?? Math.max(0, ...state.chapters.map((c) => c.chapterNo));
          const all = characterStateUpTo(store, upto, state.chapters);
          const hit = all.get(opts.character) ?? null;
          process.stdout.write(JSON.stringify({ character: opts.character, upTo: upto, state: hit ?? null }) + '\n');
          if (hit === null) {
            process.stderr.write(
              `截至第 ${upto} 章没有「${opts.character}」的状态记录。\n`
                + `  已记录的出场人物：${[...all.keys()].join('、') || '（空）'}\n`
                + '  注意：只有**抽过**的章才会出现在这里——没抽过的章不参与。\n',
            );
          } else {
            process.stderr.write(
              `「${opts.character}」截至第 ${hit.atChapter} 章（最近一次出现在第 ${hit.atChapter} 章）：\n`
                + `  境界 ${hit.state.realm || '(未写)'}｜位置 ${hit.state.location || '(未写)'}｜`
                + `${hit.state.alive ? '在世' : '已死亡'}\n`
                + `  变化原因：${hit.cause || '(未写)'}\n`,
            );
          }
          return;
        }
        const entries = Object.entries(store.chapters);
        process.stdout.write(JSON.stringify({
          bookRoot: root,
          extractedChapters: entries.length,
          totalChapters: state.chapters.length,
          dropped: entries.reduce((s, [, f]) => s + f.dropped, 0),
          chapters: entries.map(([file, f]) => ({
            file, extractedAt: f.extractedAt, characters: f.characters.length,
            foreshadows: f.foreshadows.length, timeline: f.timeline.length, dropped: f.dropped,
          })),
        }) + '\n');
        if (entries.length === 0) {
          process.stderr.write('还没有抽取任何章。\n  novel extract --book <书目录> --from 1 --to <末章>\n');
          return;
        }
        for (const [file, f] of entries) {
          process.stderr.write(
            `  ${file}｜角色 ${f.characters.length}｜伏笔 ${f.foreshadows.length}｜`
              + `时间线 ${f.timeline.length}`
              + (f.dropped > 0 ? `｜⚠️ 丢弃 ${f.dropped} 条（引句未命中）` : '')
              + '\n',
          );
        }
        process.stderr.write(`共 ${entries.length}/${state.chapters.length} 章已抽。\n`);
        return;
      }

      const from = opts.from ?? opts.chapter;
      if (from === undefined || !Number.isInteger(from) || from <= 0) {
        throw new Error('缺少 --chapter <n>（或 --from/--to 批量）；或用 --status / --rollback <n>');
      }
      const to = opts.to ?? from;
      if (to < from) throw new Error(`--to 必须 ≥ --from（收到 ${from}→${to}）`);

      const done: unknown[] = [];
      for (let n = from; n <= to; n++) {
        const r = await extractChapter({ bookRoot: root, chapterNo: n });
        if (!r.ok) {
          const status = 'status' in r ? `${r.status} ` : '';
          throw new Error(`第 ${n} 章抽取失败 [${r.kind}] ${status}${r.detail}（已抽的章不受影响）`);
        }
        done.push({ chapterNo: n, ...r.facts });
        const f = r.facts;
        process.stderr.write(
          `第 ${n} 章：角色 ${f.characters.length}｜伏笔 ${f.foreshadows.length}｜时间线 ${f.timeline.length}`
            + (f.dropped > 0 ? `｜⚠️ 丢弃 ${f.dropped} 条` : '')
            + '\n',
        );
      }
      process.stdout.write(JSON.stringify({ bookRoot: root, extracted: done }) + '\n');
      process.stderr.write(
        `\n共抽 ${done.length} 章。引句命不中的条目已整条丢弃——`
          + '丢弃数偏高说明模型在编，别把「抽出来了」当成「抽对了」。\n',
      );
    });
}
