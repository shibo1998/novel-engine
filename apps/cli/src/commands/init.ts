import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';

/**
 * novel init：开新书骨架。book.json 严格按 gates/kit.py config_problems 的校验项生成
 * （_schema / book.title / paths 四键 / chapter.file_regex / ledger.columns+chapter_column），
 * 另带 rules.author/plugin 空声明。目标目录已存在且非空 → 显式拒绝（不做静默覆盖）。
 */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description('开新书：生成目录骨架 + 可通过机检校验的 book.json')
    .requiredOption('--dir <dir>', '书目录绝对路径')
    .requiredOption('--title <title>', '书名')
    .option('--genre <genre>', '题材', '')
    .option('--platform <platform>', '平台', '')
    .action(async (opts: { dir: string; title: string; genre: string; platform: string }) => {
      const root = path.resolve(opts.dir);
      const existing = await readdir(root).catch(() => null);
      if (existing !== null && existing.length > 0) {
        throw new Error(`init：目标目录已存在且非空：${root}（不做静默覆盖，请换空目录或先清空）`);
      }

      await mkdir(path.join(root, 'chapters'), { recursive: true });
      await mkdir(path.join(root, 'outline'), { recursive: true });
      await mkdir(path.join(root, 'notes'), { recursive: true });
      await mkdir(path.join(root, 'state'), { recursive: true });
      await mkdir(path.join(root, '.soloent', 'rules'), { recursive: true });
      await mkdir(path.join(root, '.soloent', 'memory'), { recursive: true });
      await mkdir(path.join(root, '.soloent', 'constitution'), { recursive: true });

      const bookJson = {
        _schema: 1,
        _readme: '本书配置。rules.author/plugin 为生成侧规则启用清单（显式声明，不扫目录）。',
        book: {
          title: opts.title,
          slug: path.basename(root),
          genre: opts.genre,
          platform: opts.platform,
        },
        paths: {
          chapters: 'chapters',
          canon: '.soloent/canon.md',
          ledger: '.soloent/ledger.tsv',
          now: '.soloent/memory/now.md',
        },
        chapter: { file_regex: '^ch-(\\d+)\\.md$' },
        ledger: { columns: ['ch', 'day', 'note'], chapter_column: 'ch' },
        rules: { author: [], plugin: [] },
      };
      await writeFile(
        path.join(root, '.soloent', 'book.json'),
        '﻿' + JSON.stringify(bookJson, null, 2) + '\n',
        'utf-8',
      );
      await writeFile(
        path.join(root, '.soloent', 'canon.md'),
        `# 正典速查表 · ${opts.title}\n\n> 写作前必读，关键值一律以此表为准，不凭印象。\n\n（待填）\n`,
        'utf-8',
      );
      await writeFile(path.join(root, '.soloent', 'memory', 'now.md'), '# 当前进度\n\n（待填）\n', 'utf-8');
      await writeFile(path.join(root, '.soloent', 'ledger.tsv'), 'ch\tday\tnote\n', 'utf-8');

      process.stdout.write(JSON.stringify({ ok: true, bookRoot: root }) + '\n');
    });
}
