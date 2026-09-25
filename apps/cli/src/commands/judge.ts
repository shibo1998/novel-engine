import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import {
  DEFAULT_JUDGE_DEFS,
  judgeChapter,
  readJudgeDecl,
  readJudgeStatus,
  scaffoldJudges,
  writeJudgeStatus,
} from '@novel/core';

/**
 * novel judge：语义判据层（B-11，v0.2 M11 / docs/24 P0-1）。
 *
 * 与机械 gates 的分工：gates 判「词面/阈值/格式」，judge 判「意图/契约/连续性」。
 * 两者**不查同一项**（M10.5），所以结论分开落盘（`state/judge.json`），不并进 gateStatus。
 *
 * 输出契约与其余子命令一致：结构化结果走 stdout，人类可读走 stderr。
 * 退出码：0 = 跑完（结论看 JSON）；1 = 有拦截级判据失败 / 未声明判据 / LLM 失败。
 */
export function registerJudge(program: Command): void {
  program
    .command('judge')
    .description('语义审稿：按 .soloent/judges/ 里声明的判据判本章（J1 蓝图契约 / J2 章末钩子 / J3 连续性），证据引句命不中即降 unsure')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--chapter <n>', '章号（--list/--scaffold/--status 时可不给）', (v: string) => Number.parseInt(v, 10))
    .option('--list', '只列出已声明的判据与内置默认判据，不调用模型', false)
    .option('--scaffold', '把内置默认判据落到 .soloent/judges/（已存在的不覆盖）', false)
    .option('--status', '只读 state/judge.json 的判据结论（含过期清扫），不调用模型', false)
    .option('--advisory', '全部判据记为「提示」级（只报告，不拦截）——假红率标定期用', false)
    .option('--write', '把本次结论写入 state/judge.json', false)
    .action(async (opts: {
      book: string;
      chapter?: number;
      list: boolean;
      scaffold: boolean;
      status: boolean;
      advisory: boolean;
      write: boolean;
    }) => {
      const root = path.resolve(opts.book);

      if (opts.list) {
        const declared = await readJudgeDecl(root);
        process.stdout.write(JSON.stringify({
          declared,
          builtin: DEFAULT_JUDGE_DEFS.map((d) => ({ id: d.id, title: d.title, quoteScope: d.quoteScope })),
        }) + '\n');
        for (const d of DEFAULT_JUDGE_DEFS) {
          const on = declared.includes(d.id) ? '已声明' : '未声明';
          process.stderr.write(`  ${on}  ${d.id}｜${d.title}（引句来源 ${d.quoteScope}）\n`);
        }
        if (declared.length === 0) {
          process.stderr.write(
            '⚠️ book.json 的 judges.enabled 为空 —— 此时 judge 不会做任何判定。\n'
              + '  先落默认判据：novel judge --book <书目录> --scaffold\n'
              + '  再在 book.json 写： "judges": { "enabled": ["j1-blueprint", "j2-hook", "j3-continuity"] }\n',
          );
        }
        return;
      }

      if (opts.scaffold) {
        const r = await scaffoldJudges(root);
        process.stdout.write(JSON.stringify(r) + '\n');
        process.stderr.write(
          `已写入 ${r.written.length} 份默认判据（保留已有 ${r.kept.length} 份，不覆盖）。\n`
            + '接着在 book.json 的 judges.enabled 里显式声明要跑哪些，例如：\n'
            + `  "judges": { "enabled": [${DEFAULT_JUDGE_DEFS.map((d) => `"${d.id}"`).join(', ')}] }\n`,
        );
        return;
      }

      if (opts.status) {
        const store = await readJudgeStatus(root);
        process.stdout.write(JSON.stringify(store) + '\n');
        const entries = Object.entries(store.chapters);
        if (entries.length === 0) {
          process.stderr.write('还没有任何判据结论（state/judge.json 为空，或全部因文件已改动而过期）。\n');
          return;
        }
        for (const [file, st] of entries) {
          process.stderr.write(`  ${file}  ${st.worst}（拦截 ${st.count}｜人工清单 ${st.manual}）\n`);
        }
        return;
      }

      if (opts.chapter === undefined || !Number.isInteger(opts.chapter) || opts.chapter <= 0) {
        throw new Error('缺少 --chapter（正整数）；或用 --list / --scaffold / --status');
      }

      const r = await judgeChapter({
        bookRoot: root,
        chapterNo: opts.chapter,
        ...(opts.advisory ? { advisory: true } : {}),
      });
      if (!r.ok) {
        const status = 'status' in r ? `${r.status} ` : '';
        throw new Error(`判据调用失败 [${r.kind}] ${status}${r.detail}（未写任何文件）`);
      }

      let persisted: unknown = null;
      if (opts.write) {
        const s = await stat(path.join(root, 'chapters', r.file)).catch(() => null);
        // 与 applyGateResult 同款：回填的 mtime 用**跑后** stat 只在单进程 CLI 里成立；
        // 这里没有并发写者（judge 是只读判定 + 一次性 CLI），故不引入快照机制。
        persisted = await writeJudgeStatus(root, r, s?.mtimeMs ?? 0);
      }
      process.stdout.write(JSON.stringify({ ...r, persisted }) + '\n');

      const line = (c: typeof r.results[number]): string => {
        const flag = c.evidence === 'ok' ? '' : `（引句${c.evidence === 'empty' ? '为空' : '未命中'}，原判 ${c.rawVerdict}）`;
        return `  ${c.verdict.padEnd(6)} ${c.id}${flag}：${c.reason}\n`;
      };
      process.stderr.write(`第 ${opts.chapter} 章（${r.file}）判据 ${r.judges.length} 条\n`);
      for (const c of r.results) process.stderr.write(line(c));
      if (r.dropped.length > 0) {
        process.stderr.write(`⚠️ 模型输出有 ${r.dropped.length} 条形状不符、已丢弃：${r.dropped[0]}\n`);
      }
      process.stderr.write(
        `拦截级 ${r.findings.length} 条｜人工清单（unsure）${r.manual.length} 条`
          + (opts.advisory ? '｜--advisory：全部按「提示」级记录，不拦截' : '')
          + (opts.write ? `｜已写入 state/judge.json` : '｜未写盘（加 --write 才落盘）')
          + '\n',
      );
      if (r.findings.length > 0) process.exitCode = 1;
    });
}
