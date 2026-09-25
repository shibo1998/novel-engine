import type { Command } from 'commander';
import { buildWrapUpReport } from '@novel/core';

/**
 * novel wrapup：完本前的收尾报告（B-42 / v0.2 L2）。
 *
 * 治的是什么：一本写到 200 万字，作者自己也不知道「还有哪些伏笔没收」。
 * 到完本时才发现，就只能硬补一段或者假装没埋过——两种都伤读者。
 *
 * ★所有比率都带「分母可信吗」：伏笔回收率的分母来自**抽取**，
 * 抽取覆盖不满时那个比率不可信。所以报告里 coverage 是 blockers 的一部分，
 * 而不是脚注。
 *
 * ★只报事实，不评好坏。「这一卷节奏偏慢」没有可靠判据，硬报就是编。
 */
export function registerWrapup(program: Command): void {
  program
    .command('wrapup')
    .description('完本报告：伏笔回收率、角色成长线完整性、时间线收束（只报事实，不评好坏）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--top <n>', '角色列表只显示出场最多的前 N 个', (v: string) => Number.parseInt(v, 10), 15)
    .action(async (opts: { book: string; top: number }) => {
      const r = await buildWrapUpReport(opts.book);
      process.stdout.write(JSON.stringify(r) + '\n');

      process.stderr.write(`${r.chapters} 章 / ${r.words} 字\n`);
      process.stderr.write(`抽取覆盖：${r.coverage.extracted}/${r.coverage.total} 章\n\n`);

      const rate = r.foreshadow.paidRate === null ? '暂无数据' : `${(r.foreshadow.paidRate * 100).toFixed(1)}%`;
      process.stderr.write('伏笔\n');
      process.stderr.write(
        `   登记 ${r.foreshadow.total}｜已回收 ${r.foreshadow.paid}｜未回收 ${r.foreshadow.open}`
          + `｜逾期 ${r.foreshadow.overdue}｜放弃 ${r.foreshadow.abandoned}\n`
          + `   回收率 ${rate}（分母 = 登记 − 放弃）\n`,
      );
      if (r.foreshadow.paidRate === null) {
        process.stderr.write('   ⚠️ 一条伏笔都没登记 —— 这个数是**没有数据**，不是 0。先 novel foreshadow sync\n');
      }
      for (const i of r.foreshadow.openCore) {
        process.stderr.write(`   ⛔ ${i.id}（第 ${i.plantedChapter} 章埋${i.targetChapter !== undefined ? `，计划第 ${i.targetChapter} 章收` : ''}）：${i.content}\n`);
      }

      process.stderr.write('\n时间线\n');
      process.stderr.write(`   事件 ${r.timeline.events} 条（不可逆 ${r.timeline.irreversible} 条）`
        + `${r.timeline.lastStoryTime !== '' ? `｜最后记录的故事时间：${r.timeline.lastStoryTime}` : ''}\n`);

      process.stderr.write(`\n角色（出场最多的前 ${opts.top} 个）\n`);
      for (const c of r.characters.slice(0, opts.top)) {
        process.stderr.write(
          `   ${c.name}｜出场 ${c.appearances} 次（第 ${c.firstChapter}–${c.lastChapter} 章）`
            + `｜境界 ${c.realms.join(' → ') || '(未记)'}${c.alive ? '' : '｜已死亡'}\n`,
        );
        for (const issue of c.issues) process.stderr.write(`      ⚠️ ${issue}\n`);
      }

      if (r.blockers.length > 0) {
        process.stderr.write('\n⛔ 必须处理\n');
        for (const b of r.blockers) process.stderr.write(`   · ${b}\n`);
      }
      if (r.warnings.length > 0) {
        process.stderr.write('\n提示\n');
        for (const w of r.warnings) process.stderr.write(`   · ${w}\n`);
      }
      if (r.blockers.length === 0) {
        process.stderr.write('\n✓ 没有必须处理的事项。\n');
      }
      process.stderr.write('\n注意：本报告只回答「有哪些还没结的事」，**不评价好坏**——那是你的判断。\n');
    });
}
