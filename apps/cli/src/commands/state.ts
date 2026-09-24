import path from 'node:path';
import type { Command } from 'commander';
import { readState, writeState, stripGateStatus } from '@novel/core';
import type { StoryState } from '@novel/core';

export function registerState(program: Command): void {
  program
    .command('state')
    .description('读取或重建章节索引（对接 readState / writeState）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--rebuild', '强制重建索引并落盘')
    .option('--set <json>', '（保留）写入给定状态 JSON——数据字段照写，门禁摘要会被摘掉')
    .action(async (opts: { book: string; rebuild?: boolean; set?: string }) => {
      if (opts.set !== undefined) {
        const parsed = JSON.parse(opts.set) as StoryState;
        // 这条路的定位（2026-09-24 作者裁定）：**保留入口，剥掉越界部分**。
        //   保留——作者标了「（保留）」（fixture／迁移用途），且仓内零引用。
        //   剥掉 gateStatus——它是**检查的结论**，不是作者输入。
        // 不剥的后果：这是本仓唯一一条**不经任何检查就能写出绿色**的路。
        // 喂 { worst:"clean", checkedMtimeMs:<真实 mtime> } 即可骗过 F12 的章数对账、
        // F17 的跑前快照语义、readState 的过期清扫，并在面板上显示为「已检通过」。
        // 摘掉之后，代价（这几章回到待检）如实报到 stderr，别混进 stdout 的 JSON。
        const { state: sanitized, removed } = stripGateStatus(parsed);
        process.stderr.write(
          '⚠️ --set：数据字段照原样落盘，但门禁摘要一律不写入。\n'
            + `   已摘除 ${removed} 章的 gateStatus——「绿」只能由 novel gates 跑出来。\n`
            + '   这些章回到「待检」；要重新有结论请跑 novel gates --book <书根> --write。\n',
        );
        await writeState(sanitized);
        process.stdout.write(
          JSON.stringify({
            bookRoot: path.resolve(sanitized.bookRoot),
            chapters: sanitized.chapters.length,
            gateStatusRemoved: removed,
          }) + '\n',
        );
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
