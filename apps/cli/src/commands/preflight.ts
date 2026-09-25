import type { Command } from 'commander';
import { checkChapterReadiness, checkPlanGate, runStyleGate } from '@novel/core';

/**
 * novel preflight：写前预检。
 *
 * ★契约变更（2026-09-24）：本命令从「只提示，不阻断」改为**会阻断**。
 *
 * 为什么必须改：它原先只检查「本章的正典与细纲准备了没」，而三份决定文风与红线的
 * 文件（story-style.md / MASTER.md / 1-边界/预期.md）**根本不在检查范围内**。
 * 于是「规则空着」与「规则填好」在这条路上给出同一个结果（退出码 0），
 * 作者看到「预检通过」就去写——而实际上模型没有任何文风依据。
 * 这正是本项目反复在治的那类信号失效：**检查通过 ≠ 具备开工条件**。
 *
 * 阻断范围刻意只有一项：风格/红线层未就绪（三份文件占位符/缺失/与模板一字不差）。
 * 细纲缺失、正典待填仍只是 warnings——它们可以边写边补，而文风依据不能。
 *
 * ★补入第二项阻断（B-10，2026-09-25）：逐层蓝图闸门。
 * 为什么它必须也在这里阻断，而不是只报个字段：`write`/`generate`/`book`/server 都已
 * 按逐层闸门硬拦（上层没确认就拒绝生成）。若 preflight 报「通过」而生成命令拒绝，
 * 就正好复刻本仓反复在治的那种矛盾——**检查器说没问题、上层却当问题**。
 * 两道门必须给出同一个结论。
 */
export function registerPreflight(program: Command): void {
  program
    .command('preflight')
    .description(
      '写前预检：风格/红线层与逐层蓝图是否就绪（任一未就绪则非 0 退出，阻断开写）+ 本章正典与细纲准备情况',
    )
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .action(async (opts: { book: string; chapter: number }) => {
      // ★B-62：风格闸门**抛错**（book.json 结构非法 → 检查器 exit 2）时，
      // 旧版整个 action 直接抛出，**stdout 一个字符都没有**——脚本与面板拿不到 planGate，
      // 只能从 stderr 的一坨文本里猜发生了什么。
      // 现在把它收成一个显式的「这道门没跑成」：字段在、原因在、退出码非 0。
      // 注意这与「就绪」不同形：`ready: false` + `error` 表示**没跑成**，
      // 而「跑成了但没就绪」只有 `ready: false` + `blocking`。
      let style: Awaited<ReturnType<typeof runStyleGate>> | { ready: false; error: string } | null = null;
      try {
        style = await runStyleGate(opts.book);
      } catch (e) {
        style = { ready: false, error: e instanceof Error ? e.message : String(e) };
      }
      const [readiness, planGate] = await Promise.all([
        checkChapterReadiness(opts.book, opts.chapter),
        checkPlanGate(opts.book, opts.chapter),
      ]);
      // 输出形状向后兼容：ChapterReadiness 的字段仍在顶层，新增 styleGate / planGate 两个键。
      process.stdout.write(JSON.stringify({ ...readiness, styleGate: style, planGate }) + '\n');
      let blocked = false;
      if (style !== null && 'error' in style) {
        process.stderr.write(
          '⛔ 风格/红线层闸门**没跑成**（不是「没就绪」）：\n'
            + `  ${style.error.split('\n').join('\n  ')}\n`
            + '  先修 book.json / 检查器环境，再重跑——此时无法判断风格层是否就绪。\n',
        );
        blocked = true;
      } else if (style !== null && !style.ready) {
        process.stderr.write(
          '⛔ 风格/红线层未就绪，已阻断开写：\n'
            + style.blocking.map((b) => `  · ${b}\n`).join('')
            + '  处理完这三份文件再重试：.soloent/rules/story-style.md、'
            + '.soloent/constitution/MASTER.md、1-边界/预期.md\n',
        );
        blocked = true;
      }
      // planGate.enabled=false（旧书，没有 plan.json）恒不阻断——不连坐
      if (planGate.enabled && !planGate.ready) {
        process.stderr.write(
          '⛔ 逐层蓝图未就绪，已阻断开写：\n'
            + planGate.blocking.map((b) => `  · ${b}\n`).join('')
            + '  看现状与下一层：novel plan status --book <同一本书>\n',
        );
        blocked = true;
      }
      if (blocked) process.exitCode = 1;
    });
}
