import type { Command } from 'commander';
import { readState, writeState } from '@novel/core';
import type { StoryState } from '@novel/core';

export function registerState(program: Command): void {
  program
    .command('state')
    .description('读取或重建章节索引（对接 readState / writeState）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--rebuild', '强制重建索引并落盘')
    .option('--set <json>', '（保留）直接写入给定状态 JSON——⚠️ 原样落盘，绕过全部门禁不变量')
    .action(async (opts: { book: string; rebuild?: boolean; set?: string }) => {
      if (opts.set !== undefined) {
        const parsed = JSON.parse(opts.set) as StoryState;
        // ⚠️ 这是本仓唯一一条能**不经任何检查就写出绿色**的路（F12 的章数对账、F17 的
        // 跑前快照语义、readState 的过期清扫，全都被它绕过）：给一个
        // { worst:"clean", checkedMtimeMs:<真实 mtime> }，它会存活过期清扫、并出现在面板上。
        // 保留它是因为作者标了「（保留）」（疑为 fixture/迁移用途），且仓内零引用；
        // 但既然代价是「可以伪造绿」，就不能让它静默——落到 stderr，别混进 stdout 的 JSON。
        process.stderr.write(
          '⚠️ --set：状态 JSON 将被原样落盘，绕过章数对账与过期清扫。\n'
            + '   若其中有 gateStatus，它不会被任何检查验证过——等同于手改 state/story.json。\n',
        );
        const ret = await writeState(parsed);
        process.stdout.write(JSON.stringify(ret ?? null) + '\n');
        return;
      }
      if (opts.rebuild === true) {
        const rebuilt = await readState({ bookRoot: opts.book, force: true });
        await writeState(rebuilt);
        process.stdout.write(JSON.stringify(rebuilt) + '\n');
        return;
      }
      const state = await readState({ bookRoot: opts.book });
      process.stdout.write(JSON.stringify(state) + '\n');
    });
}
