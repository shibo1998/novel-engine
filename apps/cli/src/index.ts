#!/usr/bin/env node
import { program } from 'commander';
import { registerPrompt } from './commands/prompt.js';
import { registerGenerate } from './commands/generate.js';
import { registerWrite } from './commands/write.js';
import { registerGates } from './commands/gates.js';
import { registerState } from './commands/state.js';
import { registerFeedback } from './commands/feedback.js';

program.name('novel').description('novel-engine 命令行外壳').version('0.0.0');

registerPrompt(program);
registerGenerate(program);
registerWrite(program);
registerGates(program);
registerState(program);
registerFeedback(program);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
