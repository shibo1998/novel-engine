import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleLongContext, buildPrompt } from '../src/index.js';

// B-01 当前状态卡 / B-02 细纲关键词参与相关摘要召回

async function makeBook(nowRel = '.soloent/memory/now.md'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-memory-'));
  await mkdir(path.join(root, '.soloent', 'memory'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'outline'), { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    book: { title: '测试书', genre: '玄幻', platform: '番茄' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', now: nowRel },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    rules: { author: [], plugin: [] },
  }), 'utf-8');
  return root;
}

test('buildPrompt：now.md 有实质内容 → 以「当前状态卡」追加块注入', async () => {
  const root = await makeBook();
  try {
    await writeFile(path.join(root, '.soloent', 'memory', 'now.md'), '# 当前进度\n\n林青：炼气三层，左臂重伤。\n', 'utf-8');
    const bundle = await buildPrompt({ bookRoot: root, chapterNo: 1, mode: 'draft' });
    assert.ok(bundle.user.includes('# 当前状态卡'));
    assert.ok(bundle.user.includes('左臂重伤'));
    assert.ok(bundle.user.indexOf('# 当前状态卡') < bundle.user.indexOf('# 要求'), '追加在要求之前');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPrompt：now.md 仍是 init 占位或缺失 → 不注入空壳', async () => {
  const root = await makeBook();
  try {
    let bundle = await buildPrompt({ bookRoot: root, chapterNo: 1, mode: 'draft' });
    assert.ok(!bundle.user.includes('# 当前状态卡'), '文件缺失');
    await writeFile(path.join(root, '.soloent', 'memory', 'now.md'), '# 当前进度\n\n（待填）\n', 'utf-8');
    bundle = await buildPrompt({ bookRoot: root, chapterNo: 1, mode: 'draft' });
    assert.ok(!bundle.user.includes('# 当前状态卡'), '占位');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPrompt：尊重 book.json 的 paths.now', async () => {
  const root = await makeBook('.soloent/now.md');
  try {
    await writeFile(path.join(root, '.soloent', 'now.md'), '# 状态\n\n苏婉在城南。\n', 'utf-8');
    const bundle = await buildPrompt({ bookRoot: root, chapterNo: 1, mode: 'draft' });
    assert.ok(bundle.user.includes('苏婉在城南'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assembleLongContext：上一章没露面、只在本章细纲出现的人，能召回其早期出场章', async () => {
  const root = await makeBook();
  try {
    for (let i = 1; i <= 4; i++) {
      await writeFile(path.join(root, 'chapters', `ch-0${i}.md`), `# 第${i}章\n\n正文${i}\n`, 'utf-8');
    }
    const summary = (n: number, s: string) => ({ chapterNo: n, summary: s, updatedAt: '', sourceMtimeMs: 0 });
    await writeFile(path.join(root, 'state', 'summaries.json'), JSON.stringify({
      schemaVersion: 1,
      bookRoot: root,
      chapters: {
        'ch-01.md': summary(1, '慕容雪在藏经阁赠林青一枚玉简。'),
        'ch-02.md': summary(2, '林青下山采药。'),
        'ch-03.md': summary(3, '林青与猎户喝酒。'),
        'ch-04.md': summary(4, '林青回到山门。'),
      },
    }), 'utf-8');
    const prevTail = '山风很冷，他推开了门。';
    const without = await assembleLongContext(root, 5, prevTail);
    assert.ok(!without.relatedSummaries.some((s) => s.chapterNo === 1), '只看上一章末尾召不回');
    const withOutline = await assembleLongContext(root, 5, prevTail, '本章：慕容雪再次出现，追问玉简下落。');
    assert.ok(withOutline.relatedSummaries.some((s) => s.chapterNo === 1), '细纲人名能召回第 1 章');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
