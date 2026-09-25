import path from 'node:path';
import type { Command } from 'commander';
import {
  commitState,
  listCheckpoints,
  pruneCheckpoints,
  readJournal,
  readPendingCommit,
  restoreFrom,
  resume,
  rollback,
} from '@novel/core';

/**
 * novel checkpoint：两步提交与快照回退（B-24 / v0.2 M4.4–4.6）。
 *
 * 治的是什么：`writeState` 是「一次原子写」，但**一次原子写不等于一次可恢复的事务**。
 * 崩溃点只要落在「正文已改、state 未写」之间，重启后 state 与正文就对不上，
 * 而两边都「看起来正常」。
 *
 * ★**正文文件的回退交给书仓 git**（4.6）：工具替作者改正文是不可逆的破坏，
 * 而 git 有历史、可再看一遍。所以 `rollback` 只把「哪些章的正文与快照不符」列出来。
 */
export function registerCheckpoint(program: Command): void {
  const cp = program.command('checkpoint').description('两步提交、快照回退、崩溃恢复');

  cp.command('list')
    .description('列 checkpoint 元信息（不加载每份的完整快照）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const metas = await listCheckpoints(opts.book);
      const pending = await readPendingCommit(opts.book);
      process.stdout.write(JSON.stringify({ checkpoints: metas, pendingCommit: pending }) + '\n');
      if (metas.length === 0) {
        process.stderr.write('还没有任何 checkpoint。收敛一章后会自动建一份。\n');
        return;
      }
      for (const m of metas) {
        process.stderr.write(`  ${m.id}｜${m.at}｜${m.reason}｜${m.chapters} 章`
          + `${m.volume !== undefined ? `｜第 ${m.volume} 卷末` : ''}\n`);
      }
      if (pending !== null) {
        process.stderr.write(
          `\n⚠️ 有一笔**未完成的提交**：${pending.checkpointId}（${pending.reason}，起于 ${pending.startedAt}）\n`
            + '  处置：novel checkpoint resume --book <同一本书>\n',
        );
      }
    });

  cp.command('commit')
    .description('手动建一份 checkpoint 并两步提交（收敛结束会自动建，这里用于「我自己想要一个回退点」）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--reason <r>', '为什么建（会进 journal）', 'manual')
    .option('--volume <n>', '卷号（保留策略会为每卷末留一份）', (v: string) => Number.parseInt(v, 10))
    .action(async (opts: { book: string; reason: string; volume?: number }) => {
      const r = await commitState({
        bookRoot: opts.book,
        reason: opts.reason,
        ...(opts.volume !== undefined ? { volume: opts.volume } : {}),
      });
      process.stdout.write(JSON.stringify({ id: r.checkpoint.id, stateHash: r.stateHash, hadPending: r.hadPending }) + '\n');
      process.stderr.write(
        `已建 ${r.checkpoint.id}（${r.checkpoint.state.chapters.length} 章）\n`
          + (r.hadPending ? '  ⚠️ 提交前发现有一笔未完成的提交——建议先 novel checkpoint resume 核对\n' : ''),
      );
    });

  cp.command('resume')
    .description('崩溃恢复：判定未完成的提交该「补完」还是「回退」')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const r = await resume(opts.book);
      process.stdout.write(JSON.stringify(r) + '\n');
      process.stderr.write(
        (r.action === 'none' ? '✓ ' : '⟳ ') + r.detail + '\n',
      );
    });

  cp.command('restore')
    .description('从 checkpoint 拷回 state。★当前 story.json 来历不明（被手改）时会拒绝，需 --force')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--id <id>', 'checkpoint id，如 cp-0007')
    .option('--force', '明知当前 state 来历不明也覆盖', false)
    .action(async (opts: { book: string; id: string; force: boolean }) => {
      const r = await restoreFrom(opts.book, opts.id, { force: opts.force });
      process.stdout.write(JSON.stringify(r) + '\n');
      process.stderr.write(
        `已从 ${r.restored} 恢复 state（指纹 ${r.stateHash.slice(0, 8)}）。\n`
          + '  ★**正文文件没有动**——那由书仓 git 负责。\n',
      );
    });

  cp.command('rollback')
    .description('显式回退：恢复 state，并列出「正文与快照不符」的章（正文由书仓 git 回退，工具不改）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--id <id>', 'checkpoint id')
    .option('--force', '明知当前 state 来历不明也覆盖', false)
    .action(async (opts: { book: string; id: string; force: boolean }) => {
      const r = await rollback(opts.book, opts.id, { force: opts.force });
      process.stdout.write(JSON.stringify(r) + '\n');
      process.stderr.write(`已回退 state 到 ${r.restored}。\n${r.hint}\n`);
    });

  cp.command('prune')
    .description('保留策略：最近 N 份 + 每卷末 1 份（默认 N=50）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--keep-recent <n>', '最近保留多少份', (v: string) => Number.parseInt(v, 10), 50)
    .action(async (opts: { book: string; keepRecent: number }) => {
      const r = await pruneCheckpoints(opts.book, { keepRecent: opts.keepRecent });
      process.stdout.write(JSON.stringify(r) + '\n');
      process.stderr.write(`保留 ${r.kept.length} 份，清掉 ${r.removed.length} 份。\n`);
    });

  cp.command('journal')
    .description('看引擎做过什么（追加式流水：commit / resume / restore / rollback / prune）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--limit <n>', '只看最近 N 条', (v: string) => Number.parseInt(v, 10), 20)
    .action(async (opts: { book: string; limit: number }) => {
      const all = await readJournal(opts.book);
      const tail = all.slice(-opts.limit);
      process.stdout.write(JSON.stringify({ total: all.length, entries: tail }) + '\n');
      if (all.length === 0) {
        process.stderr.write('journal 是空的（还没有过提交/恢复/回退）。\n');
        return;
      }
      for (const e of tail) {
        process.stderr.write(`  ${e.at}｜${e.kind}｜${JSON.stringify({ ...e, at: undefined, kind: undefined })}\n`);
      }
      process.stderr.write(`共 ${all.length} 条，显示最近 ${tail.length} 条。\n`);
    });
}
