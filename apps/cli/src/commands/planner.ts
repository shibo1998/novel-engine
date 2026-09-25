import path from 'node:path';
import type { Command } from 'commander';
import { expandNextVolume, layerConfirmed, nextVolume, reviseCompass } from '@novel/core';

/**
 * novel planner：滚动展开卷纲/细纲（B-40 / v0.2 M8.3、M8.6）。
 *
 * ★**一次只展下一卷**（M8.3）：远卷只留一行标题。
 * 不是省 token，是**防止把想象当规划**——写着写着故事会变，
 * 三卷之后再展开才是有依据的。
 *
 * ★**顺序不可反**（M8.6）：先 `compass`（基于已写档案校准总纲），再 `expand`。
 * 这条用**形状**强制：总纲没在本卷已写内容之后重新校准过，`expand` 直接拒绝。
 * 靠文档提醒「记得先改指南针」是不够的——忘了不会有任何红灯。
 */
export function registerPlanner(program: Command): void {
  const pl = program.command('planner').description('滚动展开：先校准总纲，再展下一卷（顺序不可反）');

  pl.command('next')
    .description('下一卷是哪一卷、能不能直接展开（只读）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const info = await nextVolume(opts.book);
      const [outlineOk, volumeOk] = await Promise.all([
        layerConfirmed(opts.book, 'outline'),
        info.knownVolumes.length === 0 ? Promise.resolve(true) : layerConfirmed(opts.book, 'volume', info.knownVolumes.at(-1)),
      ]);
      process.stdout.write(JSON.stringify({ ...info, outlineConfirmed: outlineOk, lastVolumeConfirmed: volumeOk }) + '\n');
      process.stderr.write(
        `下一卷：第 ${info.volume} 卷`
          + `（已展开 ${info.knownVolumes.length} 卷${info.knownVolumes.length > 0 ? `：${info.knownVolumes.join('、')}` : ''}）\n`
          + `已写到第 ${info.latestWrittenChapter} 章\n`
          + (info.needsCompassRevision ? '⛔ 必须先校准总纲：' : '✓ 可以直接展开：') + info.why + '\n',
      );
      if (!outlineOk) {
        process.stderr.write('  ⚠️ 总纲尚未确认（novel plan confirm --layer outline）——展开前先确认它，否则卷纲建在未定稿上。\n');
      }
      if (!volumeOk) {
        process.stderr.write('  ⚠️ 上一卷卷纲尚未确认——先确认它，再展下一卷。\n');
      }
    });

  pl.command('compass')
    .description('基于**已写档案**重新校准总纲（M8.6 第一步）；只写 state/drafts/compass.md')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const r = await reviseCompass(opts.book);
      if (!r.ok) {
        const status = 'status' in r ? `${r.status} ` : '';
        throw new Error(`校准总纲失败 [${r.kind}] ${status}${r.detail}（未写任何文件）`);
      }
      process.stdout.write(JSON.stringify(r) + '\n');
      process.stderr.write(
        `草稿已写入 ${r.draftFile}（**不是正式文件**）。\n`
          + `  总纲已标记为「校准到第 ${r.compassRevisedUpToChapter ?? 0} 章」。\n`
          + '  下一步：审阅后改入 `outline/总纲.md`，再\n'
          + '    novel plan confirm --book <同一本书> --layer outline\n'
          + '  然后才展开下一卷：novel planner expand --book <同一本书>\n',
      );
    });

  pl.command('expand')
    .description('展开**下一卷**卷纲（一次一卷）；总纲未校准会拒绝（--no-enforce-order 可跳过，会留痕）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--no-enforce-order', '跳过「先校准总纲」的检查（罕见；返回值里会标 orderEnforced=false）')
    .action(async (opts: { book: string; enforceOrder: boolean }) => {
      const r = await expandNextVolume(opts.book, { enforceOrder: opts.enforceOrder });
      if (!r.ok) {
        const status = 'status' in r ? `${r.status} ` : '';
        throw new Error(`展开第 ${'volume' in r ? r.volume : '?'} 卷失败 [${r.kind}] ${status}${r.detail}（未写任何文件）`);
      }
      process.stdout.write(JSON.stringify(r) + '\n');
      process.stderr.write(
        `第 ${r.volume} 卷卷纲草稿已写入 ${r.draftFile}（**不是正式文件**）。\n`
          + (r.orderEnforced ? '' : '  ⚠️ 本次跳过了「先校准总纲」的检查（orderEnforced=false）——留痕在此。\n')
          + '  下一步：审阅后改入正式文件，再确认（卷纲确认**必须给章节范围**）：\n'
          + `    novel plan confirm --book <同一本书> --layer volume --volume ${r.volume} --chapters <a-b>\n`
          + '  注意：**不要一次展开多卷**——远卷只留一行标题，写着写着故事会变。\n',
      );
    });
}
