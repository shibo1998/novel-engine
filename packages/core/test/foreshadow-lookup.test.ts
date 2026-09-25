import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  characterHistory,
  contentHash,
  findFactConflicts,
  lookupCharacter,
  lookupTimeline,
  readForeshadowLedger,
  readState,
  summarizeForeshadows,
  syncForeshadows,
  updateForeshadow,
} from '../src/index.js';
import type { ChapterFacts, FactsStore } from '../src/index.js';

/**
 * B-23 伏笔台账 / B-22 结构化反查 / B-21 角色 history。
 *
 * 三项都建在 B-20 的事实库上。最要紧的两条：
 *   · **id 由引擎分配**——让模型自己编号，两章之间必然撞号
 *   · **逾期是读时派生的**——存进文件的话，「写到第 61 章」这个事件没地方触发重算
 */
const TEXT = '# 第N章\n\n林青推开门，山风灌进来。\n';

async function makeBook(chapters: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-fs-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '台账测试书' },
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

/** 直接写事实库（跳过模型），key 是章文件名 */
async function seedFacts(root: string, byFile: Record<string, FactsInput>): Promise<void> {
  const chapters: Record<string, ChapterFacts> = {};
  for (const [file, facts] of Object.entries(byFile)) {
    chapters[file] = {
      extractedAt: new Date().toISOString(),
      contentHash: contentHash(TEXT),
      model: 'm',
      characters: [], foreshadows: [], timeline: [], dropped: 0, malformed: [],
      ...facts,
    };
  }
  const store: FactsStore = { schemaVersion: 1, bookRoot: path.resolve(root), chapters };
  await writeFile(path.join(root, 'state', 'facts.json'), JSON.stringify(store, null, 2), 'utf-8');
}

const fshadow = (content: string, extra: Partial<{ level: string; paidOff: string[]; plantedChapter: number }> = {}) => ({
  content, level: 'minor', plantedChapter: 0, paidOff: [], evidence: '林青推开门', ...extra,
});

// ── B-23 台账 ─────────────────────────────────────────────────────────────

test('★syncForeshadows：id 由引擎按序号分配（f-001…），且**幂等**', async () => {
  const root = await makeBook(2);
  try {
    await seedFacts(root, {
      'ch-01.md': { foreshadows: [fshadow('玉简的来历') as never, fshadow('左臂的伤') as never] },
    });
    const r1 = await syncForeshadows(root);
    assert.deepEqual(r1.added.map((a) => a.id), ['f-001', 'f-002'], '★id 必须由引擎分配');
    assert.equal(r1.ledger.nextSeq, 3);

    const r2 = await syncForeshadows(root);
    assert.equal(r2.added.length, 0, '★幂等：同一份事实库跑两遍不该重复新增');
    assert.equal(r2.ledger.items.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★内容归一：措辞略有差异视为同一条（LLM 不会逐字复述）', async () => {
  const root = await makeBook(2);
  try {
    await seedFacts(root, { 'ch-01.md': { foreshadows: [fshadow('玉简的来历') as never] } });
    await syncForeshadows(root);
    // 第 2 章抽到「玉简的来历。」（多个句号、多空格）→ 归一后同一条
    await seedFacts(root, {
      'ch-01.md': { foreshadows: [fshadow('玉简的来历') as never] },
      'ch-02.md': { foreshadows: [fshadow('玉简的来历。 ') as never] },
    });
    const r = await syncForeshadows(root);
    assert.equal(r.added.length, 0, '归一后应视为同一条，不重复发 id');
    assert.equal(r.ledger.items.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★paidOff 销账；对不上的记进 unmatchedPaidOff（不许静默丢弃）', async () => {
  const root = await makeBook(3);
  try {
    await seedFacts(root, { 'ch-01.md': { foreshadows: [fshadow('玉简的来历') as never] } });
    await syncForeshadows(root);
    await seedFacts(root, {
      'ch-01.md': { foreshadows: [fshadow('玉简的来历') as never] },
      'ch-03.md': { foreshadows: [fshadow('新埋的东西', { paidOff: ['玉简的来历', '压根没埋过的东西'] }) as never] },
    });
    const r = await syncForeshadows(root);
    assert.equal(r.paid.length, 1, '对得上的销账');
    assert.equal(r.paid[0]?.paidChapter, 3);
    assert.equal(r.ledger.items.find((i) => i.content === '玉简的来历')?.status, 'paid');
    assert.equal(r.unmatchedPaidOff.length, 1, '★对不上的要报出来——否则那条伏笔永远挂着当逾期');
    assert.equal(r.unmatchedPaidOff[0]?.content, '压根没埋过的东西');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★逾期是**读时派生**的：写到第 N 章才判，不是存出来的', async () => {
  const root = await makeBook(3);
  try {
    await seedFacts(root, { 'ch-01.md': { foreshadows: [fshadow('玉简的来历', { level: 'core' }) as never] } });
    await syncForeshadows(root);
    await updateForeshadow(root, 'f-001', { level: 'core', targetChapter: 2 });

    // 当前写到第 3 章 > 计划第 2 章 → 逾期
    const a = await readForeshadowLedger(root);
    assert.equal(a.latestChapter, 3);
    assert.equal(a.ledger.items[0]?.status, 'overdue');
    assert.equal(summarizeForeshadows(a.ledger).needsHuman.length, 1, '★core 逾期必须交人（主线断了）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('未设 targetChapter 的伏笔**永远不判逾期**（没计划就没有「逾期」这个概念）', async () => {
  const root = await makeBook(3);
  try {
    await seedFacts(root, { 'ch-01.md': { foreshadows: [fshadow('玉简的来历', { level: 'core' }) as never] } });
    await syncForeshadows(root);
    const a = await readForeshadowLedger(root);
    assert.equal(a.ledger.items[0]?.status, 'open');
    assert.equal(summarizeForeshadows(a.ledger).needsHuman.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★人工改过的 level 被钉住，同步不再覆盖；放弃的伏笔不复活', async () => {
  const root = await makeBook(2);
  try {
    await seedFacts(root, { 'ch-01.md': { foreshadows: [fshadow('玉简的来历', { level: 'minor' }) as never] } });
    await syncForeshadows(root);
    await updateForeshadow(root, 'f-001', { level: 'core', abandon: true });

    // 再同步：抽取里还是 minor，但不该把人工改过的 core 覆盖回去
    const r = await syncForeshadows(root);
    const it = r.ledger.items[0];
    assert.equal(it?.level, 'core', '★人工改过的等级不许被同步覆盖（「多重要」不可推导）');
    assert.equal(it?.levelPinned, true);
    assert.equal(it?.status, 'abandoned', '★作者放弃过的伏笔不该被重新抽到就复活');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('updateForeshadow：reopen 清掉回收章；未知 id 报错并列出候选', async () => {
  const root = await makeBook(2);
  try {
    await seedFacts(root, {
      'ch-01.md': { foreshadows: [fshadow('玉简的来历') as never] },
      'ch-02.md': { foreshadows: [fshadow('x', { paidOff: ['玉简的来历'] }) as never] },
    });
    await syncForeshadows(root);
    await updateForeshadow(root, 'f-001', { reopen: true });
    const a = await readForeshadowLedger(root);
    assert.equal(a.ledger.items[0]?.status, 'open');
    assert.equal(a.ledger.items[0]?.paidChapter, undefined, 'reopen 要清掉回收章');

    await assert.rejects(
      () => updateForeshadow(root, 'f-999', { level: 'core' }),
      /没有伏笔 f-999/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── B-22 / B-21 反查 ──────────────────────────────────────────────────────

const char = (name: string, realm: string, alive = true, cause = '') => ({
  name,
  state: { realm, location: '山门', knows: [], ignores: [], relations: [], alive },
  cause, evidence: '林青推开门',
});

test('★lookupCharacter：出场史按章升序，并**报出抽取覆盖率**', async () => {
  const root = await makeBook(4);
  try {
    await seedFacts(root, {
      'ch-01.md': { characters: [char('林青', '炼气一层') as never] },
      'ch-03.md': { characters: [char('林青', '炼气三层', true, '闭关突破') as never, char('慕容雪', '筑基') as never] },
    });
    const r = await lookupCharacter(root, '林青');
    assert.deepEqual(r.appearances, [1, 3]);
    assert.equal(r.history.length, 2);
    assert.equal(r.history[1]?.state.realm, '炼气三层');
    assert.equal(r.history[1]?.cause, '闭关突破');
    assert.equal(r.lastSeen?.chapterNo, 3);
    // ★覆盖率必须报：只在抽过的章里统计，覆盖不满时「他只出场过 2 次」是不可信的结论
    assert.deepEqual(r.coverage, { extracted: 2, total: 4 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('characterHistory：纯函数，按章号升序（B-21 的 history 字段就是它）', async () => {
  const root = await makeBook(3);
  try {
    await seedFacts(root, {
      'ch-02.md': { characters: [char('林青', '二层') as never] },
      'ch-01.md': { characters: [char('林青', '一层') as never] },
    });
    const { readFacts } = await import('../src/index.js');
    const store = await readFacts(root);
    const state = await readState({ bookRoot: root });
    const h = characterHistory(store, '林青', state.chapters);
    assert.deepEqual(h.map((x) => x.chapterNo), [1, 2], '必须按章号升序，不是文件顺序');
    assert.deepEqual(h.map((x) => x.state.realm), ['一层', '二层']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lookupTimeline：按章号区间与参与人过滤', async () => {
  const root = await makeBook(3);
  try {
    const ev = (event: string, participants: string[]) => ({ storyTime: '第三日', event, participants, irreversible: false, evidence: '林青推开门' });
    await seedFacts(root, {
      'ch-01.md': { timeline: [ev('入门', ['林青']) as never] },
      'ch-03.md': { timeline: [ev('斗法', ['林青', '慕容雪']) as never] },
    });
    assert.equal((await lookupTimeline(root)).events.length, 2);
    assert.equal((await lookupTimeline(root, { from: 2 })).events.length, 1);
    assert.equal((await lookupTimeline(root, { participant: '慕容雪' })).events[0]?.event, '斗法');
    assert.equal((await lookupTimeline(root, { to: 2 })).events[0]?.event, '入门');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★findFactConflicts：只报**机械可判**的矛盾（已记死亡又出现）', async () => {
  const root = await makeBook(3);
  try {
    await seedFacts(root, {
      'ch-01.md': { characters: [char('路人甲', '炼气', false) as never] },
      'ch-03.md': { characters: [char('路人甲', '炼气') as never] },
    });
    const { readFacts } = await import('../src/index.js');
    const store = await readFacts(root);
    const state = await readState({ bookRoot: root });
    const hints = findFactConflicts(store, state.chapters);
    assert.equal(hints.length, 1);
    assert.match(hints[0]?.detail ?? '', /第 1 章被记为已死亡.*第 3 章又出现/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('findFactConflicts：正常复活顺序（先死后无）不报', async () => {
  const root = await makeBook(2);
  try {
    await seedFacts(root, { 'ch-01.md': { characters: [char('路人甲', '炼气', false) as never] } });
    const { readFacts } = await import('../src/index.js');
    const store = await readFacts(root);
    const state = await readState({ bookRoot: root });
    assert.deepEqual(findFactConflicts(store, state.chapters), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('事实库指纹作废后，台账/反查都不该再看到那一章', async () => {
  const root = await makeBook(2);
  try {
    await seedFacts(root, { 'ch-01.md': { characters: [char('林青', '一层') as never] } });
    assert.equal((await lookupCharacter(root, '林青')).appearances.length, 1);
    // 改正文 → 该章事实作废
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), TEXT + '\n他改了主意。\n', 'utf-8');
    assert.equal((await lookupCharacter(root, '林青')).appearances.length, 0, '过期的记忆不许被查到');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('台账落盘格式：nextSeq 单调递增，回收的 id 不复用', async () => {
  const root = await makeBook(2);
  try {
    await seedFacts(root, { 'ch-01.md': { foreshadows: [fshadow('A') as never] } });
    await syncForeshadows(root);
    await seedFacts(root, { 'ch-01.md': { foreshadows: [fshadow('B') as never] } });
    const r = await syncForeshadows(root);
    assert.deepEqual(r.ledger.items.map((i) => i.id), ['f-001', 'f-002']);
    const raw = JSON.parse(await readFile(path.join(root, 'state', 'foreshadows.json'), 'utf-8')) as { nextSeq: number };
    assert.equal(raw.nextSeq, 3, 'nextSeq 单调递增——复用 id 会让历史引用指错');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
