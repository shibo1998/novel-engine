import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadFeedback, recordFeedback, readState, saveChapterText, summarizeGateResult, writeState } from '../src/index.js';
import type { GateResult } from '../src/types.js';

/** 造一本最小可用的书：.soloent/book.json + chapters/ch-01.md */
async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-fb-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), '{}', 'utf-8');
  await writeFile(path.join(root, 'chapters', 'ch-01.md'), '# 第一章 测试\n\n他知道，这是原文。\n', 'utf-8');
  return root;
}

test('summarizeGateResult：同章多条 finding 累加 count 且 worst 取最大', () => {
  const result: GateResult = {
    gate: 'g',
    book_root: '/x',
    chapter_count: 1,
    counts: { 提示: 1, 严重: 1, 轻微: 1 },
    findings: [
      // 故意把最严重的放中间——若实现退化成「取最后一条」，worst 会是 轻微
      { severity: '提示', chapter: 'ch-01.md', line: 1, check: 'a', detail: '' },
      { severity: '严重', chapter: 'ch-01.md', line: 2, check: 'b', detail: '' },
      { severity: '轻微', chapter: 'ch-01.md', line: 3, check: 'c', detail: '' },
    ],
  };
  const m = summarizeGateResult(result);
  assert.equal(m.get('ch-01.md')?.count, 3, 'count 必须累加到 3');
  assert.equal(m.get('ch-01.md')?.worst, '严重', 'worst 必须取最大严重度，而非最后一条');
  assert.equal(m.get('ch-01.md')?.checkedMtimeMs, 0, '聚合层拿不到 mtime，恒为占位 0');
});

test('recordFeedback：落 .soloent/feedback.jsonl，一条一行，可反查', async () => {
  const root = await makeBook();
  try {
    const before = await readState({ bookRoot: root, force: true });
    assert.equal(before.chapters[0]?.file, 'ch-01.md');

    await recordFeedback({ bookRoot: root, chapterNo: 1, revisedText: '# 第一章 测试\n\n改后，他不那样想了。\n' });
    await recordFeedback({ bookRoot: root, chapterNo: 1, revisedText: '# 第一章 测试\n\n第二次改后。\n' });

    const raw = await readFile(path.join(root, '.soloent', 'feedback.jsonl'), 'utf-8');
    // 两条记录 = 两个物理行（末尾还有一个空元素，故按非空行数断言）
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 2, '追加写：两次调用产生两行');

    const all = await loadFeedback(root);
    assert.equal(all.length, 2);
    assert.equal(all[0]?.file, 'ch-01.md');
    assert.equal(all[0]?.chapterNo, 1);
    assert.ok(all[0]!.original.includes('这是原文'), 'original 存的是改前原文');
    assert.ok(all[0]!.revised.includes('改后'), 'revised 存的是人工改后稿');

    // limit 取的是**最近** N 条 —— 尾部
    const lastOne = await loadFeedback(root, { limit: 1 });
    assert.equal(lastOne.length, 1);
    assert.ok(lastOne[0]!.revised.includes('第二次改后'), 'limit 取尾部（最近）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordFeedback：revisedText 为空则抛错，且不留下任何记录', async () => {
  const root = await makeBook();
  try {
    await assert.rejects(
      recordFeedback({ bookRoot: root, chapterNo: 1, revisedText: '' }),
      /revisedText 不能为空/,
    );
    const raw = await readFile(path.join(root, '.soloent', 'feedback.jsonl'), 'utf-8').catch(() => null);
    assert.equal(raw, null, '抛错发生在落盘之前，jsonl 不应被创建');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordFeedback：正文先保存时可用 originalText 保留改前版本', async () => {
  const root = await makeBook();
  try {
    const originalText = await readFile(path.join(root, 'chapters', 'ch-01.md'), 'utf-8');
    const revisedText = '# 第一章 测试\n\n保存后的正文。\n';
    await saveChapterText({ bookRoot: root, chapterNo: 1, text: revisedText });
    await recordFeedback({ bookRoot: root, chapterNo: 1, originalText, revisedText });

    const [entry] = await loadFeedback(root);
    assert.equal(entry?.original, originalText);
    assert.equal(entry?.revised, revisedText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveChapterText：保存后同步刷新章节索引并清空旧门禁状态', async () => {
  const root = await makeBook();
  try {
    const state = await readState({ bookRoot: root, force: true });
    state.chapters[0]!.gateStatus = {
      worst: 'clean', count: 0, checkedAt: '2026-01-01T00:00:00.000Z', checkedMtimeMs: 1,
    };
    await writeState(state);

    await saveChapterText({ bookRoot: root, chapterNo: 1, text: '# 第二章 新标题\n\n更新后的正文。\n' });

    const refreshed = await readState({ bookRoot: root });
    assert.equal(refreshed.chapters[0]?.title, '新标题');
    assert.equal(refreshed.chapters[0]?.wordCount, 14);
    assert.equal(refreshed.chapters[0]?.gateStatus, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadFeedback：残行（写到一半）被丢弃，不牵连其余记录', async () => {
  const root = await makeBook();
  try {
    const good = JSON.stringify({
      at: '2026-01-01T00:00:00.000Z', chapterNo: 1, file: 'ch-01.md',
      category: '(无)', findingCount: 0, original: 'a', revised: 'b',
    });
    await mkdir(path.join(root, '.soloent'), { recursive: true });
    await writeFile(path.join(root, '.soloent', 'feedback.jsonl'), `${good}\n{"broken":`, 'utf-8');

    const all = await loadFeedback(root);
    assert.equal(all.length, 1, '好行保留，残行丢弃');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadFeedback：book 没有 feedback.jsonl 时返回空数组，不抛错', async () => {
  const root = await makeBook();
  try {
    assert.deepEqual(await loadFeedback(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
