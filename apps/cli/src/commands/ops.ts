import { rename } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { commitBook, isGitRepo, planNumberingMigration, readState, writeState } from '@novel/core';

/**
 * 运维命令：书目录 git 提交（B-51）+ 章号编号迁移（B-52）。
 *
 * 两者都是**对作者的文件动手**的事，所以默认都是保守姿态：
 *   · `commit` 只提交，**不 push**（推送是对外动作）
 *   · `migrate-numbering` **默认 dry-run**，要加 `--apply` 才真改
 */
export function registerOps(program: Command): void {
  program
    .command('commit')
    .description('提交书目录的全部改动（不 push）。书目录不是 git 仓库时会明说跳过')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--chapter <n>', '章号（进提交信息，方便 git log 扫读）', (v: string) => Number.parseInt(v, 10))
    .option('--title <t>', '章节标题（进提交信息）')
    .option('--message <m>', '自定义提交信息（给了就用它，不再拼章号）')
    .action(async (opts: { book: string; chapter?: number; title?: string; message?: string }) => {
      const r = await commitBook({
        bookRoot: opts.book,
        ...(opts.chapter !== undefined ? { chapterNo: opts.chapter } : {}),
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.message !== undefined ? { message: opts.message } : {}),
      });
      process.stdout.write(JSON.stringify(r) + '\n');
      process.stderr.write(
        r.committed
          ? `已提交 ${r.hash}：${r.message}\n  注意：**没有 push**——推送是对外动作，工具不做。\n`
          : `未提交：${r.skippedReason ?? '(未知原因)'}\n`,
      );
    });

  program
    .command('migrate-numbering')
    .description('章号编号迁移：ch-NN.md → ch-0001.md（**默认只出计划，加 --apply 才真改**）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--apply', '真的执行重命名（默认 dry-run）', false)
    .action(async (opts: { book: string; apply: boolean }) => {
      const root = path.resolve(opts.book);
      const plan = await planNumberingMigration(root);

      if (plan.entries.length === 0) {
        process.stdout.write(JSON.stringify({ plan, applied: 0 }) + '\n');
        process.stderr.write(
          plan.alreadyFour > 0
            ? `无需迁移：${plan.alreadyFour} 个文件已是四位编号。\n`
            : '没找到任何 ch-NN.md / ch-0001.md 形式的文件。\n',
        );
        return;
      }

      if (!opts.apply) {
        process.stdout.write(JSON.stringify({ plan, applied: 0 }) + '\n');
        process.stderr.write(`将要重命名 ${plan.entries.length} 个文件（**尚未执行**）：\n`);
        for (const e of plan.entries) process.stderr.write(`  ${e.from} → ${e.to}\n`);
        process.stderr.write(
          '\n★为什么默认不执行：重命名章文件会动 git 历史与你的习惯，那是你的决定。\n'
            + '  确认后：novel migrate-numbering --book <同一本书> --apply\n'
            + '  建议先提交一次，好回退：novel commit --book <同一本书> --message "迁移前"\n',
        );
        return;
      }

      // 先重命名文件，再重建 state——顺序不能反：反了会先索引到旧名、再发现文件没了
      const done: string[] = [];
      for (const e of plan.entries) {
        await rename(path.join(root, e.from), path.join(root, e.to));
        done.push(`${e.from} → ${e.to}`);
      }
      const rebuilt = await readState({ bookRoot: root, force: true });
      await writeState(rebuilt);

      process.stdout.write(JSON.stringify({ plan, applied: done.length, chapters: rebuilt.chapters.length }) + '\n');
      process.stderr.write(
        `已重命名 ${done.length} 个文件，并重建索引（${rebuilt.chapters.length} 章）。\n`
          + '  提醒：`state/facts.json` 与 `state/judges.json` 里以旧文件名为键的记录会因「文件不在」被清扫——\n'
          + '  那不是数据丢失，是「内容变了/文件挪了结论即作废」的既有语义。需要就重抽：novel extract --from 1 --to <末章>\n',
      );
      if (await isGitRepo(root)) {
        process.stderr.write('  书目录是 git 仓库：确认无误后 novel commit --book <同一本书> --message "章号迁移"\n');
      }
    });
}
