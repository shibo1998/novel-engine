import path from 'node:path';
import type { Command } from 'commander';
import {
  findFactConflicts,
  listKnownCharacters,
  lookupCharacter,
  lookupTimeline,
  readFacts,
  readState,
} from '@novel/core';

/**
 * novel lookup：结构化反查（B-22 / v0.2 M6.3）。
 *
 * 治的是什么：写第 61 章时想问「慕容雪上次出场是哪一章、当时她什么状态」。
 * 没有反查就只能全文搜索人名、然后一篇篇读——**长篇创作里最费时间的动作**。
 *
 * ★为什么先做结构化反查、不直接上向量检索（v0.2 M6.3 的原话）：
 * 结构化事实已经能回答绝大多数问题，而且是**确定的**——同样的问题问两次得到
 * 同一个答案。向量检索给的是「相似」，在「第 20 章她左臂有没有伤」这类
 * **事实性**问题上，「相似」没有意义。效果不够再上向量，不是反过来。
 *
 * ★本命令**只读**：所有查询都不写文件。写是 `novel extract` 的事。
 */
export function registerLookup(program: Command): void {
  const lk = program.command('lookup').description('结构化反查：按角色/时间线查历史（只读）');

  lk.command('character')
    .description('某角色的出场史与状态变化（B-21 的 history）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--name <名>', '角色名')
    .action(async (opts: { book: string; name: string }) => {
      const r = await lookupCharacter(opts.book, opts.name);
      process.stdout.write(JSON.stringify(r) + '\n');

      if (r.history.length === 0) {
        const known = await listKnownCharacters(opts.book);
        process.stderr.write(
          `没有「${opts.name}」的记录。\n`
            + `  已记录的出场人物：${known.join('、') || '（空）'}\n`
            + `  抽取覆盖率：${r.coverage.extracted}/${r.coverage.total} 章\n`,
        );
        if (r.coverage.extracted < r.coverage.total) {
          process.stderr.write('  ⚠️ 覆盖率不满——「没记录」不等于「没出场」，可能只是没抽过。\n');
        }
        return;
      }
      process.stderr.write(
        `「${r.name}」出场 ${r.appearances.length} 次：第 ${r.appearances.join('、')} 章\n`
          + `  抽取覆盖率：${r.coverage.extracted}/${r.coverage.total} 章\n`,
      );
      if (r.coverage.extracted < r.coverage.total) {
        process.stderr.write('  ⚠️ 覆盖率不满——**没抽过的章不算缺席**，上面的出场列表不完整。\n');
      }
      for (const h of r.history) {
        process.stderr.write(
          `  第 ${h.chapterNo} 章：境界 ${h.state.realm || '(未写)'}｜位置 ${h.state.location || '(未写)'}`
            + `｜${h.state.alive ? '在世' : '已死亡'}`
            + (h.cause !== '' ? `｜因：${h.cause}` : '')
            + '\n',
        );
      }
    });

  lk.command('timeline')
    .description('时间线事件（可按章号区间与参与人过滤）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--from <n>', '起始章号', (v: string) => Number.parseInt(v, 10))
    .option('--to <n>', '结束章号（含）', (v: string) => Number.parseInt(v, 10))
    .option('--participant <名>', '只看含此参与人的事件')
    .action(async (opts: { book: string; from?: number; to?: number; participant?: string }) => {
      const r = await lookupTimeline(opts.book, {
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        ...(opts.participant !== undefined ? { participant: opts.participant } : {}),
      });
      process.stdout.write(JSON.stringify(r) + '\n');
      if (r.events.length === 0) {
        process.stderr.write('没有匹配的事件。抽取覆盖率：'
          + `${r.coverage.extracted}/${r.coverage.total} 章——没抽过的章不在这里。\n`);
        return;
      }
      for (const e of r.events) {
        process.stderr.write(
          `  第 ${e.chapterNo} 章｜${e.storyTime || '(未写时间)'}｜${e.event}`
            + `${e.irreversible ? '｜⚠️ 不可逆' : ''}`
            + `｜参与：${e.participants.join('、') || '(未写)'}\n`,
        );
      }
    });

  lk.command('conflicts')
    .description('从**结构化事实**里找自相矛盾（当前只报「已记死亡又出现」这类机械可判的）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const root = path.resolve(opts.book);
      const [store, state] = await Promise.all([readFacts(root), readState({ bookRoot: root })]);
      const hints = findFactConflicts(store, state.chapters);
      process.stdout.write(JSON.stringify({ hints, coverage: { extracted: Object.keys(store.chapters).length, total: state.chapters.length } }) + '\n');
      if (hints.length === 0) {
        process.stderr.write(
          '结构化事实里没有机械可判的矛盾。\n'
            + '  注意这只说明「抽出来的事实之间不打架」，**不说明正文没矛盾**——\n'
            + '  正文层面的语义矛盾是 Judge J3 的活（它能看正文，这里只看抽出来的事实）。\n',
        );
        return;
      }
      for (const h of hints) process.stderr.write(`  ⛔ ${h.detail}\n`);
    });
}
