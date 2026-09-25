import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectStats, editedLineCount } from '../src/index.js';

/**
 * B-29：全书度量。
 *
 * ★北极星 = **人工改稿行数 / 千字**。
 * 「修订次数」「findings 数」「Judge 通过率」都只说明机器忙不忙；
 * 只有「人要动多少字」才说明**机器写出来的东西到底能不能用**。
 *
 * 本文件最要紧的两条断言都与「形状」有关：
 *   · 没有改稿记录时，北极星是「**没有数据**」而不是 0（0 会被读成「完美」）
 *   · 没有判据结论时，通过率是 `null` 而不是 0
 * ——本项目已为「查不到 = 没问题」吃过多次亏。
 */
async function makeBook(chapters: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-stats-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '度量测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  for (let i = 1; i <= chapters; i++) {
    await writeFile(
      path.join(root, 'chapters', `ch-${String(i).padStart(2, '0')}.md`),
      `# 第${i}章 标题\n\n${'他推开门，雨声压下来。'.repeat(20)}\n`,
      'utf-8',
    );
  }
  return root;
}

test('editedLineCount：逐 hunk 取 max(原行数, 改后行数)', () => {
  assert.equal(editedLineCount('A\nB\nC\n', 'A\nB\nC\n'), 0, '没改 → 0 行');
  assert.equal(editedLineCount('A\nB\nC\n', 'A\nX\nC\n'), 1, '改一行 → 1');
  assert.equal(editedLineCount('A\nB\nC\n', 'A\nC\n'), 1, '删一行 → 1（max(1,0)）');
  assert.equal(editedLineCount('A\nC\n', 'A\nB\nC\n'), 1, '插一行 → 1');
});

test('★空书：计数为 0，但**北极星与通过率是「没有数据」而不是 0**', async () => {
  const root = await makeBook(0);
  try {
    const s = await collectStats(root);
    assert.equal(s.chapters, 0);
    assert.equal(s.words, 0);
    assert.equal(s.human.editedLinesPerKilo, 0, '千字比在 0 字时返回 0，不能是 NaN/Infinity');
    assert.equal(s.judge.passRate, null, '★一章都没跑过 → null。「还没跑过」与「跑过且全没过」必须形状不同');
    assert.equal(s.human.feedbackEntries, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★北极星：人工改稿行数 / 千字，只统计真的改过稿的章', async () => {
  const root = await makeBook(2);
  try {
    // 手写两条改稿记录：第 1 章改 2 行，第 2 章没改
    const entry = (chapterNo: number, original: string, revised: string): string => JSON.stringify({
      at: new Date().toISOString(), chapterNo, file: `ch-0${chapterNo}.md`,
      category: '裁判腔', findingCount: 1, original, revised,
    }) + '\n';
    await writeFile(
      path.join(root, '.soloent', 'feedback.jsonl'),
      entry(1, 'A\nB\nC\n', 'A\nX\nY\n') + entry(1, 'P\nQ\n', 'P\nQ\n'),
      'utf-8',
    );

    const s = await collectStats(root);
    assert.equal(s.human.feedbackEntries, 2);
    assert.equal(s.human.editedLines, 2, '第一条改 2 行、第二条 0 行');
    assert.ok(s.words > 0);
    // 逐章：只有第 1 章有改稿
    const c1 = s.perChapter.find((c) => c.chapterNo === 1);
    const c2 = s.perChapter.find((c) => c.chapterNo === 2);
    assert.equal(c1?.feedbackCount, 2);
    assert.equal(c1?.humanEditedLines, 2);
    assert.equal(c2?.feedbackCount, 0, '没改过的章不该被算进北极星');
    assert.equal(c2?.humanEditedLines, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('机器返工：定点修订与整章重写分开计，并报「涉及几章」', async () => {
  const root = await makeBook(3);
  try {
    const story = JSON.parse(await (await import('node:fs/promises')).readFile(
      path.join(root, 'state', 'story.json'), 'utf-8',
    ).catch(() => 'null')) as unknown;
    // story.json 还不存在 → 先让 readState 建一次（collectStats 会建，但我们要改它）
    const { readState, writeState } = await import('../src/index.js');
    const st = await readState({ bookRoot: root, force: true });
    st.chapters[0]!.reviseCount = 2;
    st.chapters[0]!.rewriteCount = 1;
    st.chapters[1]!.reviseCount = 1;
    await writeState(st);
    assert.equal(story, null, '夹具自检：一开始确实没有 story.json');

    const s = await collectStats(root);
    assert.equal(s.rework.reviseCount, 3);
    assert.equal(s.rework.rewriteCount, 1);
    assert.equal(s.rework.chaptersTouched, 2, '第 3 章没返工过，不该算进来');
    assert.equal(s.perChapter[2]?.reviseCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★Judge 通过率的分母是「有结论的章」——没跑过的章不拉低、也不算通过', async () => {
  const root = await makeBook(4);
  try {
    const { readState, writeState, writeJudgeStatus } = await import('../src/index.js');
    const st = await readState({ bookRoot: root, force: true });
    await writeState(st);

    // 两章有判据结论：一章 clean、一章 fail；另两章没跑过
    const mk = (file: string, worst: 'clean' | '中等'): Parameters<typeof writeJudgeStatus>[1] => ({
      ok: true, bookRoot: root, chapterNo: 1, file, judges: ['j2-hook'], results: [],
      findings: worst === 'clean' ? [] : [{ severity: '中等', chapter: file, line: 0, check: '[J2] x', detail: 'q' }],
      manual: [], counts: {}, dropped: [],
    });
    await writeJudgeStatus(root, mk('ch-01.md', 'clean'), st.chapters[0]!.contentHash);
    await writeJudgeStatus(root, mk('ch-02.md', '中等'), st.chapters[1]!.contentHash);

    const s = await collectStats(root);
    assert.equal(s.judge.checked, 2, '只有 2 章有结论');
    assert.equal(s.judge.clean, 1);
    assert.equal(s.judge.failing, 1);
    assert.equal(s.judge.passRate, 0.5, '★分母是有结论的 2 章，不是全部 4 章');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('机械 gates 的「提示级」不算拦截（与 BLOCKING_SEVERITIES 同一口径）', async () => {
  const root = await makeBook(2);
  try {
    const { readState, writeState } = await import('../src/index.js');
    const st = await readState({ bookRoot: root, force: true });
    st.chapters[0]!.gateStatus = { worst: '提示', count: 1, checkedAt: new Date().toISOString(), checkedHash: st.chapters[0]!.contentHash };
    st.chapters[1]!.gateStatus = { worst: '中等', count: 2, checkedAt: new Date().toISOString(), checkedHash: st.chapters[1]!.contentHash };
    await writeState(st);

    const s = await collectStats(root);
    assert.equal(s.gates.checked, 2);
    assert.equal(s.gates.clean, 0);
    assert.equal(s.gates.blocking, 1, '★提示级只报告，不计入拦截');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
