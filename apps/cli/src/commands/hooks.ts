import type { Command } from 'commander';
import { auditHooks, declaredOutlinePath, readHookSpecs, readState } from '@novel/core';

/**
 * `novel hooks` —— 章末钩子锚词校验的**只读报告**入口。
 *
 * ## 为什么是只读、且刻意不设退出码
 * 判据在 `packages/core/src/hooks.ts`，它的使用纪律写在 `docs/ne-架构与契约.md §7.2`
 * 「边界比功能重要」，是实测真书 34 章人工对账后定的：**细纲标的是「意图」，正文写的是
 * 「变体」**，因此在「对白有没有被改写」这个粒度上，词面匹配本质上不可靠。
 * 据此定下三条硬约束，本命令逐条遵守：
 *   ① 红灯只当**人工复核入口**，不当结论——所以报告里连 `tail`（实际比对的末段）一起给，
 *      让人能自己读一眼再判断，而不是只拿到一个 true/false；
 *   ② **不接 CI 硬失败**——所以本命令**永不设非 0 退出码**，也不产出任何 gate finding；
 *   ③ 明确的语义判定只能靠人工读或 LLM，不伪装成词面校验。
 *
 * ## 它替代了什么
 * 原先这件事由 `gates/consistency_check.py` 的 `_hook_check` 承担，但那份靠
 * `import brief` 取细纲钩子，而 `brief.py` 未随迁 → 恒不生效且静默（2026-09-24 删除）。
 * 同一判据两份副本是本仓禁止的，故此处只调用 core，不重写判据。
 */
export function registerHooks(program: Command): void {
  program
    .command('hooks')
    .description('章末钩子锚词校验（只读线索报告；不计入拦截、不影响退出码，红灯须人工复核）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--all', '连通过项与未标锚词的跳过项一并列出（默认只列红灯）')
    .action(async (opts: { book: string; all?: boolean }) => {
      const state = await readState({ bookRoot: opts.book });
      const outlineRel = await declaredOutlinePath(state.bookRoot);
      const specs = outlineRel === '' ? [] : await readHookSpecs(state.bookRoot, outlineRel);
      const entries = await auditHooks(state.bookRoot, state.chapters, specs);

      const failed = entries.filter((e) => !e.ok);
      const checked = entries.filter((e) => e.checked).length;
      const skipped = entries.filter((e) => !e.checked).length;
      // 细纲常常写到了还没动笔的章（高武：specs 60 而正文 34 章）。不单列这个数的话，
      // 读的人会拿 specs 去减 checked/skipped，算不平 → 怀疑报告漏了东西。
      // 数字必须对得上，这是 F12 章数对账同一条道理。
      const written = new Set(state.chapters.map((c) => c.chapterNo));
      const unwritten = specs.filter((s) => !written.has(s.chapterNo)).length;

      // ★「没查到」与「查了没问题」必须形状不同——本仓最核心的一条纪律。
      // 若 specs 为空却只输出 failed:0，读的人会以为「钩子全都没问题」，
      // 而事实是**一条都没查**。所以这两种情况必须在 notes 里说清，且走 stderr 提醒。
      const notes: string[] = [];
      if (outlineRel === '') {
        notes.push('book.json 的 paths.outline 未声明 → 细纲没读到，本次一条都没查。');
      } else if (specs.length === 0) {
        notes.push(
          `细纲 ${outlineRel} 里没解析到任何「｜钩子·<型>：<内容>」标注 → 本次一条都没查。`,
        );
      }
      if (skipped > 0) {
        notes.push(
          `${skipped} 章标了钩子但提炼不出锚词（引号内容过短或疑似人名被剔除）`
            + '→ 这些章 checked=false，**不计入通过**，也不计入红灯。',
        );
      }

      process.stdout.write(
        JSON.stringify({
          book_root: state.bookRoot,
          outline: outlineRel,
          // 五个计数彼此独立，**不构成恒等式**（正文文件读不到的章也不进 checked/skipped）：
          //   specs     = 细纲里解析出锚词的章数
          //   unwritten = 其中正文还没写的章（未参与比对）
          //   checked   = 真的做了词面比对的章数
          //   skipped   = 标了钩子但提炼不出锚词的章（checked=false，既不算过也不算红）
          //   failed    = 比对结果为红灯的章数
          specs: specs.length,
          unwritten,
          checked,
          skipped,
          failed: failed.length,
          notes,
          // 默认只列红灯：通过项无需人工复核，全列出来只是噪音。
          // 但红灯必须带 tail —— 纪律①要求「别只给个 true/false」。
          entries: (opts.all === true ? entries : failed).map((e) => ({
            chapterNo: e.chapterNo,
            file: e.file,
            ok: e.ok,
            checked: e.checked,
            anchors: e.anchors,
            tail: e.tail,
          })),
        }) + '\n',
      );

      if (specs.length === 0) {
        process.stderr.write(
          '⚠️ novel hooks：本次一条都没查（细纲未读到，或细纲里没有钩子标注）。\n'
            + '   不要把这当成「章末钩子都没问题」——这两件事形状不同。\n',
        );
      }
      // 刻意不设 process.exitCode：§7.2 明写「不接 CI 硬失败」。
    });
}
