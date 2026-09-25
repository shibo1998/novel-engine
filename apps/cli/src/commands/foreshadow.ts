import type { Command } from 'commander';
import {
  ForeshadowError,
  readForeshadowLedger,
  summarizeForeshadows,
  syncForeshadows,
  updateForeshadow,
} from '@novel/core';
import type { ForeshadowLevel, ForeshadowStatus } from '@novel/core';

/**
 * novel foreshadow：伏笔台账（B-23）。
 *
 * ★id 由**引擎**分配（`f-001`），模型不得自造——让模型自己编号，两章之间必然撞号，
 * 撞号之后「引用哪个」就说不清了。
 *
 * ★台账是 B-20 事实库的**投影 + 人工修正**：内容从抽取来，
 * 但 `level` / `targetChapter` / 放弃 由人定——「这个伏笔多重要」不可推导。
 * 同步只**新增**，人改过的字段不被覆盖。
 *
 * ★逾期是**读时派生**的（按当前进度重算），不是存出来的：
 * 存进文件的话，「写到第 61 章」这个事件没地方触发重算，台账会停在旧结论上。
 */
export function registerForeshadow(program: Command): void {
  const fs = program.command('foreshadow').description('伏笔台账：id 由引擎分配、等级、逾期提醒');

  fs.command('sync')
    .description('从事实库（novel extract 的产出）汇聚台账；只新增，不覆盖人工改过的字段')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const r = await syncForeshadows(opts.book);
      const report = summarizeForeshadows(r.ledger);
      process.stdout.write(JSON.stringify({
        added: r.added,
        paid: r.paid.map((p) => ({ id: p.id, content: p.content, paidChapter: p.paidChapter })),
        unmatchedPaidOff: r.unmatchedPaidOff,
        report,
      }) + '\n');
      process.stderr.write(
        `新增 ${r.added.length} 条｜销账 ${r.paid.length} 条｜台账共 ${report.total} 条\n`,
      );
      if (r.added.length > 0) {
        for (const a of r.added) process.stderr.write(`  ${a.id} [${a.level}] 第 ${a.plantedChapter} 章：${a.content}\n`);
      }
      if (r.unmatchedPaidOff.length > 0) {
        // ★不许静默丢弃：对不上的销账会让那条伏笔永远挂着当逾期
        process.stderr.write(
          `⚠️ ${r.unmatchedPaidOff.length} 条回收声明没能在台账里对上（措辞差太远）：\n`
            + r.unmatchedPaidOff.map((u) => `  第 ${u.chapterNo} 章：${u.content}\n`).join('')
            + '  处置：novel foreshadow set --id <id> --reopen 后手工核对，或改台账里的 content 措辞\n',
        );
      }
    });

  fs.command('list')
    .description('列台账；逾期按**当前进度**现算')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--status <s>', '只看某状态：open / paid / overdue / abandoned')
    .option('--level <l>', '只看某等级：minor / major / core')
    .action(async (opts: { book: string; status?: string; level?: string }) => {
      const { ledger, latestChapter } = await readForeshadowLedger(opts.book);
      const items = ledger.items.filter((i) =>
        (opts.status === undefined || i.status === opts.status)
        && (opts.level === undefined || i.level === opts.level));
      const report = summarizeForeshadows(ledger);
      process.stdout.write(JSON.stringify({ latestChapter, report, items }) + '\n');

      if (ledger.items.length === 0) {
        process.stderr.write('台账是空的。先从事实库汇聚：novel foreshadow sync --book <同一本书>\n');
        return;
      }
      process.stderr.write(`写到第 ${latestChapter} 章｜共 ${report.total} 条`
        + `（open ${report.open}｜paid ${report.paid}｜overdue ${report.overdue}｜abandoned ${report.abandoned}）\n`);
      for (const i of items) {
        process.stderr.write(
          `  ${i.id} [${i.level}] ${i.status}`
            + `｜埋 ${i.plantedChapter}${i.targetChapter !== undefined ? `→计划 ${i.targetChapter}` : ''}`
            + `${i.paidChapter !== undefined ? `｜收 ${i.paidChapter}` : ''}`
            + `：${i.content}\n`,
        );
      }
      if (report.needsHuman.length > 0) {
        process.stderr.write(
          `\n⛔ ${report.needsHuman.length} 条 **core 级伏笔已逾期**——主线断了，必须处理：\n`
            + report.needsHuman.map((i) => `  ${i.id}（计划第 ${i.targetChapter} 章回收）：${i.content}\n`).join(''),
        );
      }
    });

  fs.command('set')
    .description('人工修正：改等级 / 设计划回收章 / 放弃 / 重开（这些字段不可推导，只能人来定）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--id <id>', '伏笔 id，如 f-001')
    .option('--level <l>', 'minor / major / core（改过即钉住，同步不再覆盖）')
    .option('--target <n>', '计划回收章号（设了才会判逾期）', (v: string) => Number.parseInt(v, 10))
    .option('--abandon', '放弃这条伏笔（同步不会让它复活）')
    .option('--reopen', '重新打开（清掉回收章）')
    .action(async (opts: {
      book: string; id: string; level?: string; target?: number; abandon?: boolean; reopen?: boolean;
    }) => {
      if (opts.level !== undefined && !['minor', 'major', 'core'].includes(opts.level)) {
        throw new ForeshadowError(`--level 只能是 minor / major / core，收到「${opts.level}」`);
      }
      const it = await updateForeshadow(opts.book, opts.id, {
        ...(opts.level !== undefined ? { level: opts.level as ForeshadowLevel } : {}),
        ...(opts.target !== undefined ? { targetChapter: opts.target } : {}),
        ...(opts.abandon === true ? { abandon: true } : {}),
        ...(opts.reopen === true ? { reopen: true } : {}),
      });
      process.stdout.write(JSON.stringify(it) + '\n');
      process.stderr.write(`已更新 ${it.id}：level ${it.level}｜status ${it.status as ForeshadowStatus}`
        + `${it.targetChapter !== undefined ? `｜计划第 ${it.targetChapter} 章` : ''}\n`);
    });
}
