import type { Command } from 'commander';
import { adoptRuleCandidate, auditRules, listRuleCandidates } from '@novel/core';

/**
 * novel rules：规则配置维护。
 *
 * `audit`   声明 vs 磁盘对账（认识「有意不启用」的 forbid）
 * `candidates` 列出 `_candidates/` 里的改稿候选（recordFeedback 的产出）
 * `adopt`   把候选**采纳进生效规则**（B-28）
 *
 * 为什么 adopt 不是「复制文件」：候选是**行级 diff 报告**，不是规则条文。
 * 原样搬进 `rules/` 并声明，等于每章往 prompt 里塞一份 diff——
 * prompt 变长、内容却不是规则，且没有任何红灯。所以 core 会拒绝未改写的候选。
 */
export function registerRules(program: Command): void {
  const rules = program.command('rules').description('规则配置维护');

  rules
    .command('audit')
    .description('检查规则文件是否遗漏声明或声明路径是否失效')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      process.stdout.write(JSON.stringify(await auditRules(opts.book)) + '\n');
    });

  rules
    .command('candidates')
    .description('列出 .soloent/rules/_candidates/ 里的改稿候选（由 novel feedback add 产出）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const list = await listRuleCandidates(opts.book);
      process.stdout.write(JSON.stringify(list) + '\n');
      if (list.length === 0) {
        process.stderr.write('没有候选。候选由 novel feedback add 产出（人工改稿的 diff 聚合）。\n');
        return;
      }
      for (const c of list) {
        process.stderr.write(
          `  ${c.id}｜${c.count} 条｜${c.rawDiff ? '⛔ 未改写（直接采纳会被拒）' : '✅ 已改写为规则'}\n`,
        );
      }
      process.stderr.write(
        '\n采纳前请先把候选**提炼成规则条文**（删掉「原文/改后」引用块与机械生成标记）：\n'
          + '  novel rules adopt --book <书目录> --candidate <id>\n',
      );
    });

  rules
    .command('adopt')
    .description('把候选采纳进生效规则：移到 rules/ → 声明进 book.json → 在 feedback.jsonl 记账')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--candidate <id>', '候选 id（文件名去 .md，如 2026-09-25-ch-05）')
    .option('--group <g>', '声明进哪一组：author（默认）或 plugin', 'author')
    .option('--name <file>', '目标文件名（相对 .soloent/rules/），默认 <候选 id>.md')
    .option('--force', '明知候选仍是机械 diff 也采纳（罕见；默认拒绝）')
    .action(async (opts: { book: string; candidate: string; group: string; name?: string; force?: boolean }) => {
      if (opts.group !== 'author' && opts.group !== 'plugin') {
        throw new Error(`--group 只能是 author 或 plugin，收到「${opts.group}」`);
      }
      const r = await adoptRuleCandidate({
        bookRoot: opts.book,
        id: opts.candidate,
        group: opts.group,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.force === true ? { force: true } : {}),
      });
      process.stdout.write(JSON.stringify(r) + '\n');
      process.stderr.write(
        `已采纳：.soloent/${r.from} → .soloent/${r.to}\n`
          + `  已在 book.json 的 rules.${r.group} 声明（不声明等于没生效——rules 不扫目录）。\n`
          + (r.forced ? '  ⚠️ 这是 --force 强采的，候选仍是机械 diff——prompt 里会多一份 diff 报告。\n' : '')
          + '  验证：novel rules audit --book <同一本书>（应无 undeclared/missing）\n',
      );
    });
}
