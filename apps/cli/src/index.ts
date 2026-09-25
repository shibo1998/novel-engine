#!/usr/bin/env node
import { program } from 'commander';
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

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
