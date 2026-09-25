#!/usr/bin/env node
import { CommanderError, program, type Command } from 'commander';
import { registerPrompt } from './commands/prompt.js';
import { registerGenerate } from './commands/generate.js';
import { registerBook } from './commands/book.js';
import { registerWrite } from './commands/write.js';
import { registerInit } from './commands/init.js';
import { registerGates } from './commands/gates.js';
import { registerState } from './commands/state.js';
import { registerFeedback } from './commands/feedback.js';
import { registerPreflight } from './commands/preflight.js';
import { registerSummarize } from './commands/summarize.js';
import { registerRules } from './commands/rules.js';
import { registerHooks } from './commands/hooks.js';
import { registerPlan } from './commands/plan.js';
import { registerJudge } from './commands/judge.js';
import { registerLock } from './commands/lock.js';
import { registerStats } from './commands/stats.js';
import { registerExtract } from './commands/extract.js';
import { registerForeshadow } from './commands/foreshadow.js';
import { registerLookup } from './commands/lookup.js';
import { registerOps } from './commands/ops.js';
import { registerCheckpoint } from './commands/checkpoint.js';
import { registerWrapup } from './commands/wrapup.js';
import { registerImpact } from './commands/impact.js';
import { registerStyleAnchor } from './commands/style-anchor.js';
import { registerPlanner } from './commands/planner.js';
import { registerArbiter } from './commands/arbiter.js';

program.name('novel').description('novel-engine 命令行外壳').version('0.0.0');

registerPrompt(program);
registerGenerate(program);
registerBook(program);
registerWrite(program);
registerInit(program);
registerGates(program);
registerState(program);
registerFeedback(program);
registerPreflight(program);
registerSummarize(program);
registerRules(program);
registerHooks(program);
registerPlan(program);
registerJudge(program);
registerLock(program);
registerStats(program);
registerExtract(program);
registerForeshadow(program);
registerLookup(program);
registerOps(program);
registerCheckpoint(program);
registerWrapup(program);
registerImpact(program);
registerStyleAnchor(program);
registerPlanner(program);
registerArbiter(program);

/**
 * ★`exitOverride`：让 commander 的**自身报错也走我们的 catch**。
 *
 * 不加它的后果（2026-09-25 实测踩到）：`--reason` 这类必填项缺失时，
 * commander 自己 `writeErr` 然后 `process.exit(1)` —— **绕过退出码契约**。
 * 于是「命令敲错了」报 1，而按 v0.2 M16 它该报 2（1 是「内容未通过」）。
 * 两者混用会让调用方分不清「稿子没过」与「参数写错」——那正是 B-14 要治的。
 *
 * ★**必须递归装到每个子命令**：父级装 `exitOverride` **不会自动传给子命令**
 * （实测：`novel 不存在的命令` 报 2，而 `novel arbiter decide` 缺 `--reason` 仍报 1
 * ——后者是子命令自己 `_exit` 的）。所以注册完所有命令后整棵树都装一遍。
 */
function exitOverrideAll(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) exitOverrideAll(sub);
}
exitOverrideAll(program);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // commander 的报错消息它自己已经写过 stderr 了，这里**不重复写**
  if (err instanceof CommanderError) {
    const benign = err.code === 'commander.helpDisplayed'
      || err.code === 'commander.version'
      || err.code === 'commander.help';
    if (!benign) process.exitCode = 2;
    else process.exitCode = 0;
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(message + '\n');
    // 退出码契约（v0.2 M16，B-14 统一）：
    //   0 = 成功（含「内容未过闸但流程跑完了」这类结论——结论看 stdout 的 JSON）
    //   1 = 内容未通过
    //   2 = 环境或参数错误 ← 抛到这里的就是这一类：参数写错、书目录不存在、配置非法、LLM 环境缺失
    //   3 = 需要人工介入（各命令在 stopped === 'human-needed' 时显式设置）
    // 为什么不是 1：1 是「内容未通过」，而走到这个 catch 的从来不是内容结论。
    // 两者混用会让调用方分不清「稿子没过」和「命令敲错了」。
    process.exitCode = 2;
  }
}
