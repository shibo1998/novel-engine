import type { Command } from 'commander';
import { auditRules } from '@novel/core';

export function registerRules(program: Command): void {
  program
    .command('rules')
    .description('规则配置维护')
    .command('audit')
    .description('检查规则文件是否遗漏声明或声明路径是否失效')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      process.stdout.write(JSON.stringify(await auditRules(opts.book)) + '\n');
    });
}
