import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPrompt, checkChapterReadiness } from '../src/index.js';

async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-readiness-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'outline'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    book: { title: '测试书', genre: '都市', platform: '番茄' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    rules: { author: [], plugin: [] },
  }), 'utf-8');
  return root;
}

test('checkChapterReadiness：缺正典和细纲时给出软提醒', async () => {
  const root = await makeBook();
  try {
    const report = await checkChapterReadiness(root, 1);
    assert.equal(report.outlineFile, 'outline/ch-01.md');
    assert.equal(report.outlineText, null);
    assert.equal(report.warnings.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPrompt：注入本章细纲且不因缺少细纲阻断起稿', async () => {
  const root = await makeBook();
  try {
    await writeFile(path.join(root, '.soloent', 'canon.md'), '# 正典\n主角叫林青。\n', 'utf-8');
    await writeFile(path.join(root, 'outline', 'ch-01.md'), '# 本章目标\n林青第一次发现线索。\n', 'utf-8');
    const bundle = await buildPrompt({ bookRoot: root, chapterNo: 1, mode: 'draft' });
    assert.ok(bundle.user.includes('本章细纲'));
    assert.ok(bundle.user.includes('林青第一次发现线索'));
    assert.ok(!bundle.user.includes('缺少本章细纲'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
