import type { Command } from 'commander';
import { assertPlanReady, assertStyleReady, writeChapter } from '@novel/core';

/**
 * novel write：起草一章。
 *
 * ★补入前置闸门（2026-09-25）：本命令此前**一道门都没有**——`generate`/`book`/server 的
 * `/write` 都接了风格与逐层闸门，唯独这里没接。而它同样会产生新正文，
 * 于是「配置空着」「蓝图没确认」时，走 `novel write` 照样能写出来，
 * 闸门形同虚设。少挡一处就等于留了一条绕过路径——本仓反复栽在这上面。
 * 现在与其余入口同一道门、同一顺序。
 */
export function registerWrite(program: Command): void {
  program
    .command('write')
    .description('起草一章（对接 writeChapter：draft 流水线，LLM 失败不落盘不改 state）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--chapter <n>', '章号', (v: string) => Number.parseInt(v, 10))
    .action(async (opts: { book: string; chapter: number }) => {
      await assertStyleReady(opts.book);
      // 没有 .soloent/plan.json 的书恒为就绪（旧书不被连坐）
      await assertPlanReady(opts.book, opts.chapter);
      const result = await writeChapter({ bookRoot: opts.book, chapterNo: opts.chapter });
      if (!result.ok) {
        const llm = result.llm;
        const status = llm !== undefined && !llm.ok && 'status' in llm ? `${llm.status} ` : '';
        const detail = llm !== undefined && !llm.ok ? llm.detail : '未知错误';
        const kind = llm !== undefined && !llm.ok ? llm.kind : 'unknown';
        throw new Error(`LLM 调用失败 [${kind}] ${status}${detail}（未落盘、未改 state）`);
      }
      process.stdout.write(JSON.stringify(result) + '\n');
    });
}
