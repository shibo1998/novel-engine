import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildWrapUpReport,
  contentHash,
  syncForeshadows,
  updateForeshadow,
} from '../src/index.js';
import type { ChapterFacts, FactsStore } from '../src/index.js';

/**
 * B-42 完本报告。
 *
 * ★本文件最要紧的一条：**所有比率都必须带「分母可信吗」**。
 * 伏笔回收率的分母来自抽取，而抽取覆盖不满时那个比率不可信——
 * 所以覆盖率是 `blockers` 的一部分，不是脚注。本项目已经为
 * 「零输入被读成零发现」吃过太多次亏。
 */
const TEXT = '# 第N章\n\n他推开门，山风灌进来。\n';

async function makeBook(chapters: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-wrapup-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '完本测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  for (let i = 1; i <= chapters; i++) {
    await writeFile(path.join(root, 'chapters', `ch-${String(i).padStart(2, '0')}.md`), TEXT, 'utf-8');
  }
  return root;
}

type FactsInput = Partial<Omit<ChapterFacts, 'contentHash' | 'extractedAt' | 'model'>>;

async function seedFacts(root: string, byFile: Record<string, FactsInput>): Promise<void> {
  const chapters: Record<string, ChapterFacts> = {};
  for (const [file, facts] of Object.entries(byFile)) {
    chapters[file] = {
      extractedAt: new Date().toISOString(), contentHash: contentHash(TEXT), model: 'm',
      characters: [], foreshadows: [], timeline: [], dropped: 0, malformed: [], ...facts,
    };
  }
  const store: FactsStore = { schemaVersion: 1, bookRoot: path.resolve(root), chapters };
  await writeFile(path.join(root, 'state', 'facts.json'), JSON.stringify(store, null, 2), 'utf-8');
}

const char = (name: string, realm: string, alive = true) => ({
  name, voice: { catchphrases: [], speechStyle: '' },
  state: { realm, location: '', knows: [], ignores: [], relations: [], alive },
  cause: '', evidence: '他推开门',
});

test('★空书：回收率是 null（不是 0），覆盖率 0/0 不误报', async () => {
  const root = await makeBook(0);
  try {
    const r = await buildWrapUpReport(root);
    assert.equal(r.chapters, 0);
    assert.equal(r.foreshadow.paidRate, null, '★「一条都没登记」与「回收率 0%」必须形状不同');
    assert.equal(r.foreshadow.total, 0);
    assert.deepEqual(r.blockers, [], '0/0 覆盖不该被当成「覆盖不满」');
    assert.ok(r.warnings.some((w) => w.includes('北极星指标没有数据')), '没改稿记录要说「没有数据」');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★抽取覆盖不满 → 进 blockers，并明说「下面所有比率都不可信」', async () => {
  const root = await makeBook(5);
  try {
    await seedFacts(root, { 'ch-01.md': {} });
    const r = await buildWrapUpReport(root);
    assert.deepEqual(r.coverage, { extracted: 1, total: 5 });
    assert.ok(r.blockers.some((b) => b.includes('抽取只覆盖 1/5 章')), '覆盖率必须是 blocker，不是脚注');
    assert.ok(r.blockers.some((b) => b.includes('不可信')));
    assert.ok(r.blockers.some((b) => b.includes('novel extract')), '要给出补齐命令');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★core 级伏笔未回收 → blocker（主线断了）；minor 逾期只提示', async () => {
  const root = await makeBook(5);
  try {
    await seedFacts(root, {
      'ch-01.md': { foreshadows: [
        { content: '主线：玉简的来历', level: 'core', plantedChapter: 1, paidOff: [], evidence: '他推开门' },
        { content: '支线：邻家的猫', level: 'minor', plantedChapter: 1, paidOff: [], evidence: '他推开门' },
      ] },
    });
    await syncForeshadows(root);
    await updateForeshadow(root, 'f-001', { targetChapter: 3 });
    await updateForeshadow(root, 'f-002', { targetChapter: 3 });

    const r = await buildWrapUpReport(root);
    assert.equal(r.foreshadow.openCore.length, 1);
    assert.equal(r.foreshadow.openCore[0]?.id, 'f-001');
    assert.ok(r.blockers.some((b) => b.includes('core 级伏笔未回收')));
    assert.ok(!r.blockers.some((b) => b.includes('f-002')), 'minor 不该进 blocker');
    assert.ok(r.warnings.some((w) => w.includes('非 core 级伏笔已逾期')), 'minor 逾期要提示（但不与 core 的 blocker 重复报）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('回收率的分母是「登记 − 放弃」，不是「登记」', async () => {
  const root = await makeBook(5);
  try {
    await seedFacts(root, {
      'ch-01.md': { foreshadows: [
        { content: 'A', level: 'minor', plantedChapter: 1, paidOff: [], evidence: '他推开门' },
        { content: 'B', level: 'minor', plantedChapter: 1, paidOff: [], evidence: '他推开门' },
        { content: 'C', level: 'minor', plantedChapter: 1, paidOff: [], evidence: '他推开门' },
      ] },
      'ch-02.md': { foreshadows: [
        { content: 'A', level: 'minor', plantedChapter: 1, paidOff: ['B'], evidence: '他推开门' },
      ] },
    });
    await syncForeshadows(root);
    await updateForeshadow(root, 'f-003', { abandon: true });

    const r = await buildWrapUpReport(root);
    assert.equal(r.foreshadow.total, 3);
    assert.equal(r.foreshadow.paid, 1);
    assert.equal(r.foreshadow.abandoned, 1);
    assert.equal(r.foreshadow.paidRate, 0.5, '1 / (3-1) = 0.5，放弃的不该拉低回收率');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★角色成长线：断线 / 境界不推进 / 已死亡，各出一条 issue', async () => {
  const root = await makeBook(30);
  try {
    await seedFacts(root, {
      'ch-01.md': { characters: [char('林青', '炼气一层') as never, char('路人甲', '炼气') as never] },
      'ch-02.md': { characters: [char('林青', '炼气一层') as never] },
      'ch-05.md': { characters: [char('林青', '炼气一层') as never, char('死者', '筑基', false) as never] },
    });
    const r = await buildWrapUpReport(root);
    const lin = r.characters.find((c) => c.name === '林青');
    assert.equal(lin?.appearances, 3);
    assert.equal(lin?.lastChapter, 5);
    assert.ok(lin?.issues.some((i) => i.includes('成长线可能断了')), '末章 30、最后一次出场 5 → 断线');
    assert.ok(lin?.issues.some((i) => i.includes('成长线可能没推进')), '出场 3 次境界不变 → 提示');
    assert.deepEqual(lin?.realms, ['炼气一层']);

    const dead = r.characters.find((c) => c.name === '死者');
    assert.equal(dead?.alive, false);
    assert.ok(dead?.issues.some((i) => i.includes('已被记为死亡')), '死亡角色不在末章要提示（结局有没有交代）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('时间线：统计事件数与不可逆事件数，并记最后的故事时间', async () => {
  const root = await makeBook(3);
  try {
    const ev = (storyTime: string, event: string, irreversible: boolean) => ({
      storyTime, event, participants: ['林青'], irreversible, evidence: '他推开门',
    });
    await seedFacts(root, {
      'ch-01.md': { timeline: [ev('第三日', '入门', false) as never] },
      'ch-03.md': { timeline: [ev('第十日', '师父身死', true) as never] },
    });
    const r = await buildWrapUpReport(root);
    assert.equal(r.timeline.events, 2);
    assert.equal(r.timeline.irreversible, 1);
    assert.equal(r.timeline.lastStoryTime, '第十日');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('覆盖率满 + 无未回收 core → 没有 blockers（不无中生有）', async () => {
  const root = await makeBook(2);
  try {
    await seedFacts(root, { 'ch-01.md': {}, 'ch-02.md': {} });
    const r = await buildWrapUpReport(root);
    assert.deepEqual(r.blockers, []);
    assert.deepEqual(r.coverage, { extracted: 2, total: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
