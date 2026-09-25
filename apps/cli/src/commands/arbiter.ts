import path from 'node:path';
import type { Command } from 'commander';
import { ARBITER_KINDS, askArbiter, listDecisions, recordHumanDecision } from '@novel/core';
import type { ArbiterKind } from '@novel/core';

/**
 * novel arbiter：四类封闭裁定（B-43 / v0.2 M13）。
 *
 * ★**默认人工**：不开 `--auto` 就直接交人，**连模型都不调**。
 * 这些决定影响几十章，而「自动」一旦是默认，作者会在不知情的情况下被替做决定。
 *
 * ★**候选集由调用方给全**：模型只能从中选一个。返回不在候选集里的值判无效。
 * 开放题让模型自由发挥，等于把「决定」变成「创作」——这一步的定位是**裁定**。
 *
 * ★**自洽采样 3 次**：不一致就交人。不用模型自报的置信度——
 * 那是没有校准的数字，而「同一题问三次答案一样吗」是可验证的事实。
 *
 * ★**只选不写**：输出里没有正文，只有「选了哪个 + 一句理由」。
 */
export function registerArbiter(program: Command): void {
  const arb = program.command('arbiter').description('四类封闭裁定：走哪条线 / 波及面 / 怎么脱身 / 爽点派给谁');

  arb.command('kinds')
    .description('列四类封闭题型（候选集必须由调用方给全）')
    .action(() => {
      process.stdout.write(JSON.stringify(ARBITER_KINDS) + '\n');
      for (const k of ARBITER_KINDS) process.stderr.write(`  ${k.kind}｜${k.label}：${k.desc}\n`);
    });

  const collect = (v: string, acc: string[]): string[] => [...acc, v];

  arb.command('ask')
    .description('提请裁定。**默认交人**（不调模型）；--auto 才走自洽采样 3 次')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--kind <k>', `题型：${ARBITER_KINDS.map((k) => k.kind).join(' / ')}`)
    .requiredOption('--prompt <p>', '问题描述（给人看的那句话）')
    .requiredOption('--candidate <c>', '候选项，可重复（**必须给全**，至少 2 项）', collect, [] as string[])
    .option('--context <c>', '上下文（只放**已发生的事实**，不要放「你希望它选哪个」）')
    .option('--auto', '允许自动裁定（默认关；开了会自洽采样 3 次，不一致仍交人）', false)
    .action(async (opts: { book: string; kind: string; prompt: string; candidate: string[]; context?: string; auto: boolean }) => {
      const r = await askArbiter(
        opts.book,
        {
          kind: opts.kind as ArbiterKind,
          prompt: opts.prompt,
          candidates: opts.candidate,
          ...(opts.context !== undefined ? { context: opts.context } : {}),
        },
        { auto: opts.auto },
      );
      if ('ok' in r && r.ok === false) {
        const status = 'status' in r ? `${r.status} ` : '';
        throw new Error(`裁定失败 [${r.kind}] ${status}${r.detail}（未写任何文件）`);
      }
      const d = r as Exclude<typeof r, { ok: false }>;
      process.stdout.write(JSON.stringify(d) + '\n');
      process.stderr.write(
        `[${d.id}] ${d.by === 'llm' ? '自动裁定' : '需要人工裁定'}`
          + `${d.choice !== undefined ? `：${d.choice}` : ''}\n`
          + `  ${d.reason}\n`,
      );
      if (d.samples !== undefined) {
        process.stderr.write(`  三次采样：${d.samples.join(' ｜ ')}\n`);
      }
      if (d.by === 'human-needed') {
        process.stderr.write(
          '\n请人工定夺（裁定不写正文，只选一项）：\n'
            + `  novel arbiter decide --book <同一本书> --kind ${d.question.kind} `
            + `--prompt "${d.question.prompt}" ${d.question.candidates.map((c) => `--candidate "${c}"`).join(' ')} `
            + '--choice "<选项>" --reason "<为什么>"\n',
        );
        process.exitCode = 3; // 需要人工介入
      }
    });

  arb.command('decide')
    .description('人工裁定（默认路径）。**必须给 --reason**——半年后要能回答「为什么走这条路」')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--kind <k>', '题型')
    .requiredOption('--prompt <p>', '问题描述')
    .requiredOption('--candidate <c>', '候选项，可重复', collect, [] as string[])
    .requiredOption('--choice <c>', '选定哪一项（必须与候选集逐字相同）')
    .requiredOption('--reason <r>', '为什么这么定')
    .action(async (opts: {
      book: string; kind: string; prompt: string; candidate: string[]; choice: string; reason: string;
    }) => {
      const d = await recordHumanDecision(
        opts.book,
        { kind: opts.kind as ArbiterKind, prompt: opts.prompt, candidates: opts.candidate },
        opts.choice,
        opts.reason,
      );
      process.stdout.write(JSON.stringify(d) + '\n');
      process.stderr.write(`[${d.id}] 已记人工裁定：${d.choice}\n`);
    });

  arb.command('list')
    .description('列历史裁定（「第 30 章为什么走了这条路」半年后要答得出来）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--pending', '只看还没定的（by=human-needed）', false)
    .action(async (opts: { book: string; pending: boolean }) => {
      const all = await listDecisions(opts.book);
      const list = opts.pending ? all.filter((d) => d.by === 'human-needed') : all;
      process.stdout.write(JSON.stringify(list) + '\n');
      if (list.length === 0) {
        process.stderr.write(opts.pending ? '没有待人工裁定的项。\n' : '还没有任何裁定记录。\n');
        return;
      }
      for (const d of list) {
        const who = d.by === 'human' ? '人工' : d.by === 'llm' ? '自动' : '⛔ 待人';
        process.stderr.write(`  ${d.id}｜${d.at}｜${who}｜${d.question.kind}`
          + `${d.choice !== undefined ? `：${d.choice}` : ''}\n`
          + `      ${d.question.prompt}\n`
          + `      理由：${d.reason}\n`);
      }
      const pending = all.filter((d) => d.by === 'human-needed').length;
      process.stderr.write(`共 ${all.length} 条${pending > 0 ? `，其中 ${pending} 条待人` : ''}。\n`);
    });
}
