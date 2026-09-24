import type { Command } from 'commander';
import { checkChapterReadiness, runStyleGate } from '@novel/core';

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
 */
export function registerPreflight(program: Command): void {
  program
    .command('preflight')
    .description(
      '写前预检：风格/红线层是否就绪（未就绪则非 0 退出，阻断开写）+ 本章正典与细纲准备情况',
    )
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .action(async (opts: { book: string; chapter: number }) => {
      const [readiness, style] = await Promise.all([
        checkChapterReadiness(opts.book, opts.chapter),
        runStyleGate(opts.book),
      ]);
      // 输出形状向后兼容：ChapterReadiness 的字段仍在顶层，新增 styleGate 一个键。
      process.stdout.write(JSON.stringify({ ...readiness, styleGate: style }) + '\n');
      if (!style.ready) {
        process.stderr.write(
          '⛔ 风格/红线层未就绪，已阻断开写：\n'
            + style.blocking.map((b) => `  · ${b}\n`).join('')
            + '  处理完这三份文件再重试：.soloent/rules/story-style.md、'
            + '.soloent/constitution/MASTER.md、1-边界/预期.md\n',
        );
        process.exitCode = 1;
      }
    });
}
