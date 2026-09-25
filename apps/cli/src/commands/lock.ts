import path from 'node:path';
import type { Command } from 'commander';
import { forceReleaseBookLock, readBookLock } from '@novel/core';

/**
 * novel lock：书级写锁的查看与强制释放（B-25）。
 *
 * 锁由 `writeChapter` / `convergeChapter` **内部**自动获取（不是各入口手工接线——
 * 接线模式必然漏）。所以本命令只有两个用途：
 *   `status`  看是谁占着、多久了
 *   `release` 强制释放（**先确认那个进程真的没了**）
 *
 * 正常路径下你**不该需要** `release`：进程崩了的话，下次取锁会因「pid 不存在」
 * 自动接管；锁龄超 30 分钟也会自动接管。`release` 是留给
 * 「pid 被别人复用了」或「进程卡住没死」这类罕见情况的。
 */
export function registerLock(program: Command): void {
  const lock = program.command('lock').description('书级写锁的查看与强制释放');

  lock
    .command('status')
    .description('看当前是谁持有本书的写锁（没有锁则明确说没有）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const info = await readBookLock(opts.book);
      process.stdout.write(JSON.stringify({ bookRoot: path.resolve(opts.book), lock: info }) + '\n');
      if (info === null) {
        process.stderr.write('当前没有锁（可以正常写入）。\n');
        return;
      }
      const ageMs = Date.now() - Date.parse(info.at);
      const ageSec = Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : -1;
      process.stderr.write(
        `持有者：pid ${info.pid} @ ${info.host}\n`
          + `  用途：${info.label}\n`
          + `  获取于：${info.at}（${ageSec >= 0 ? `${ageSec}s 前` : '时间戳不可解析'}）\n`
          + '  若那个进程已经不在，下次写入会自动接管；也可以显式：'
          + 'novel lock release --book <同一本书>\n',
      );
    });

  lock
    .command('release')
    .description('强制释放写锁（不看持有者；先确认那个进程真的没了）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const prev = await forceReleaseBookLock(opts.book);
      process.stdout.write(JSON.stringify({ bookRoot: path.resolve(opts.book), released: prev }) + '\n');
      process.stderr.write(
        prev === null
          ? '本来就没有锁。\n'
          : `已强制释放：原持有者 pid ${prev.pid} @ ${prev.host}｜${prev.label}\n`
            + '  ⚠️ 若那个进程其实还活着，它接下来的写入会与本进程交错——先确认它真的没了。\n',
      );
    });
}
