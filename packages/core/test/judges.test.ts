import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_JUDGE_DEFS,
  JudgeDefMissing,
  JudgesNotDeclared,
  evaluateCriteria,
  evidenceFound,
  loadJudges,
  parseJudgeOutput,
  readJudgeDecl,
  readJudgeStatus,
  scaffoldJudges,
  writeJudgeStatus,
} from '../src/index.js';
import type { GateFinding, JudgeDef, JudgeResult } from '../src/index.js';

// B-11 语义判据层：证据引句防幻觉 / 未声明不静默 / 结论落盘与过期清扫

async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-judge-'));
  await mkdir(path.join(root, '.soloent', 'judges'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    book: { title: '测试书', genre: '玄幻', platform: '番茄' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    rules: { author: [], plugin: [] },
  }), 'utf-8');
  return root;
}

async function setDeclared(root: string, ids: string[]): Promise<void> {
  const p = path.join(root, '.soloent', 'book.json');
  const cfg = JSON.parse(await readFile(p, 'utf-8')) as Record<string, unknown>;
  cfg['judges'] = { enabled: ids };
  await writeFile(p, JSON.stringify(cfg), 'utf-8');
}

const DEFS: JudgeDef[] = [
  { id: 'j2-hook', title: 'J2 章末钩子', quoteScope: 'chapter' },
  { id: 'j1-blueprint', title: 'J1 蓝图契约', quoteScope: 'any' },
];

const CHAPTER = '林青推开门，山风灌进来。\n他握紧了那枚玉简。\n';

// ── 证据引句核对 ──────────────────────────────────────────────────────────

test('evidenceFound：逐字命中 / 容忍换行缩进 / 命不中 / 空引句', () => {
  assert.equal(evidenceFound('他握紧了那枚玉简', CHAPTER), true, '逐字命中');
  assert.equal(evidenceFound('他握紧了\n  那枚玉简', CHAPTER), true, '换行缩进差异不该判幻觉');
  assert.equal(evidenceFound('他握紧了那枚玉佩', CHAPTER), false, '改字即命不中');
  assert.equal(evidenceFound('  ', CHAPTER), false, '空引句');
});

// ── 模型输出解析 ──────────────────────────────────────────────────────────

test('parseJudgeOutput：直出 JSON / ```json 围栏 / 前后废话都能抠出来', () => {
  const body = '{"results":[{"criterion":"j2-hook","verdict":"fail","quote":"q","reason":"r"}]}';
  for (const text of [body, '```json\n' + body + '\n```', '好的，结论如下：\n' + body + '\n以上。']) {
    const { items, dropped } = parseJudgeOutput(text);
    assert.equal(items.length, 1, `应解析出 1 条：${text.slice(0, 20)}`);
    assert.equal(items[0]?.id, 'j2-hook');
    assert.equal(items[0]?.verdict, 'fail');
    assert.equal(dropped.length, 0);
  }
});

test('parseJudgeOutput：verdict 不认识 / 缺 id 的条目**丢弃并报出来**，不静默当通过', () => {
  const text = JSON.stringify({
    results: [
      { criterion: 'j2-hook', verdict: 'failed', quote: 'q', reason: 'r' },   // 拼错的 verdict
      { verdict: 'pass', quote: 'q', reason: 'r' },                            // 缺 criterion
      { criterion: 'j3', verdict: 'pass', quote: 'q', reason: 'r' },           // 正常
    ],
  });
  const { items, dropped } = parseJudgeOutput(text);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, 'j3');
  assert.equal(dropped.length, 2, '丢掉的条目必须可见，否则「少回一条」会变成「这条没问题」');
});

test('parseJudgeOutput：整体不是含 results 的 JSON → 0 条 + 记录原因', () => {
  const { items, dropped } = parseJudgeOutput('我觉得这章写得还行。');
  assert.equal(items.length, 0);
  assert.equal(dropped.length, 1);
});

// ── 判定核心：引句核对 → 降级 → 分桶 ──────────────────────────────────────

const base = {
  judges: DEFS,
  chapterText: CHAPTER,
  contextText: '细纲：本章要求林青与慕容雪重逢。',
  file: 'ch-05.md',
  severity: '中等' as const,
};

test('★引句命不中 → fail 降为 unsure，原判留在 rawVerdict，且**不产生 finding**', () => {
  const out = evaluateCriteria({
    ...base,
    judges: [DEFS[0] as JudgeDef],
    items: [{ id: 'j2-hook', verdict: 'fail', quote: '他根本没有握任何东西', reason: '章末无钩子' }],
  });
  const c = out.results.find((r) => r.id === 'j2-hook');
  assert.equal(c?.verdict, 'unsure', '疑幻觉必须降级');
  assert.equal(c?.rawVerdict, 'fail', '原判要留着给人工核对');
  assert.equal(c?.evidence, 'not-found');
  assert.match(c?.reason ?? '', /疑幻觉/);
  assert.equal(out.findings.length, 0, '降级后不得计入拦截');
  assert.equal(out.manual.length, 1, '降级后进人工清单');
});

test('引句命中 → fail 记 finding（severity 可配），pass 两边都不进', () => {
  const out = evaluateCriteria({
    ...base,
    items: [
      { id: 'j2-hook', verdict: 'fail', quote: '他握紧了那枚玉简', reason: '章末无钩子' },
      { id: 'j1-blueprint', verdict: 'pass', quote: '细纲：本章要求林青与慕容雪重逢', reason: '已兑现' },
    ],
  });
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0]?.severity, '中等');
  assert.equal(out.findings[0]?.chapter, 'ch-05.md');
  assert.equal(out.findings[0]?.line, 0, '语义判据是整章级');
  assert.match(out.findings[0]?.check ?? '', /^\[J2 章末钩子\]/);
  assert.equal(out.findings[0]?.detail, '他握紧了那枚玉简');
  assert.equal(out.manual.length, 0);
  assert.deepEqual(out.counts, { 中等: 1 });
});

test('★quoteScope：chapter 判据不认参考材料的引句，any 判据认（同一条引句，只换判据作用域）', () => {
  // 只让 quoteScope 变，其它一律相同——否则测不出「到底是不是它决定的」
  const anyDef: JudgeDef = { id: 'jx', title: 'X', quoteScope: 'any' };
  const chapterDef: JudgeDef = { id: 'jx', title: 'X', quoteScope: 'chapter' };
  const items = [{ id: 'jx', verdict: 'fail' as const, quote: '细纲：本章要求林青与慕容雪重逢', reason: '未写到' }];

  // any：引细纲里的要求合法（缺席断言没有正文句子可引）
  const loose = evaluateCriteria({ ...base, judges: [anyDef], items });
  assert.equal(loose.findings.length, 1);
  assert.equal(loose.results[0]?.evidence, 'ok');

  // chapter：同一句引句在正文里找不到 → 降 unsure
  const strict = evaluateCriteria({ ...base, judges: [chapterDef], items });
  assert.equal(strict.findings.length, 0);
  assert.equal(strict.results[0]?.evidence, 'not-found');
  assert.equal(strict.manual.length, 1);
});

test('unsure 原样进人工清单：既不算通过也不算拦截', () => {
  const out = evaluateCriteria({
    ...base,
    judges: [DEFS[0] as JudgeDef],
    items: [{ id: 'j2-hook', verdict: 'unsure', quote: '山风灌进来', reason: '细纲没标钩子类型，判不了' }],
  });
  assert.equal(out.findings.length, 0);
  assert.equal(out.manual.length, 1);
  assert.equal(out.manual[0]?.verdict, 'unsure');
  assert.deepEqual(out.counts, {});
});

test('★模型漏回一条 → 该条判 unsure 进人工清单，绝不默认通过', () => {
  const out = evaluateCriteria({
    ...base,
    items: [{ id: 'j2-hook', verdict: 'pass', quote: '他握紧了那枚玉简', reason: 'ok' }],
  });
  const missing = out.results.find((r) => r.id === 'j1-blueprint');
  assert.equal(missing?.verdict, 'unsure');
  assert.equal(missing?.evidence, 'empty');
  assert.match(missing?.reason ?? '', /漏回/);
  assert.equal(out.manual.length, 1);
});

test('advisory：severity 记为「提示」（只报告，不拦截）', () => {
  const out = evaluateCriteria({
    ...base,
    severity: '提示',
    items: [{ id: 'j2-hook', verdict: 'fail', quote: '他握紧了那枚玉简', reason: '章末无钩子' }],
  });
  assert.equal(out.findings[0]?.severity, '提示');
  assert.deepEqual(out.counts, { 提示: 1 });
});

// ── 声明与加载（未声明 / 缺文件都不许静默）─────────────────────────────────

test('★一个判据都没声明 → JudgesNotDeclared，绝不退化成「0 条 = 通过」', async () => {
  const root = await makeBook();
  try {
    assert.deepEqual(await readJudgeDecl(root), []);
    await assert.rejects(() => loadJudges(root), (e: unknown) => e instanceof JudgesNotDeclared);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★声明了但判据文件不存在 → JudgeDefMissing（显式报错，不跳过）', async () => {
  const root = await makeBook();
  try {
    await setDeclared(root, ['j2-hook']);
    await assert.rejects(
      () => loadJudges(root),
      (e: unknown) => e instanceof JudgeDefMissing && /j2-hook/.test(e.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scaffold → 声明 → 加载：标题与引句来源从文件解析；重跑不覆盖作者改过的判据', async () => {
  const root = await makeBook();
  try {
    const r1 = await scaffoldJudges(root);
    assert.equal(r1.written.length, DEFAULT_JUDGE_DEFS.length);
    assert.equal(r1.kept.length, 0);

    await setDeclared(root, ['j1-blueprint', 'j2-hook']);
    const loaded = await loadJudges(root);
    assert.deepEqual(loaded.map((j) => j.id), ['j1-blueprint', 'j2-hook'], '顺序 = 声明顺序');
    assert.equal(loaded[0]?.title, 'J1 蓝图契约');
    assert.equal(loaded[0]?.quoteScope, 'any');
    assert.equal(loaded[1]?.quoteScope, 'chapter');

    // 作者改过判据 → 重跑 scaffold 必须保留，不许冲掉
    const p = path.join(root, '.soloent', 'judges', 'j2-hook.md');
    await writeFile(p, '# 我自己的钩子判据\n\n只看最后一段。\n', 'utf-8');
    const r2 = await scaffoldJudges(root);
    assert.deepEqual(r2.written, [], '已存在的一律不覆盖');
    assert.equal(r2.kept.length, DEFAULT_JUDGE_DEFS.length);
    const after = await loadJudges(root);
    assert.equal(after[1]?.title, '我自己的钩子判据', '作者的判据不许被默认版冲掉');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 结论落盘与过期清扫 ────────────────────────────────────────────────────

function fakeResult(findings: GateFinding[], manualCount: number): JudgeResult {
  return {
    ok: true,
    bookRoot: '',
    chapterNo: 5,
    file: 'ch-05.md',
    judges: ['j2-hook'],
    results: [],
    findings,
    manual: Array.from({ length: manualCount }, (_, i) => ({
      id: `m${i}`, verdict: 'unsure' as const, quote: '', reason: '', evidence: 'empty' as const, rawVerdict: 'unsure' as const,
    })),
    counts: {},
    dropped: [],
  };
}

test('writeJudgeStatus：worst 取最高级、count 与 manual 分开记', async () => {
  const root = await makeBook();
  try {
    await writeFile(path.join(root, 'chapters', 'ch-05.md'), CHAPTER, 'utf-8');
    const findings: GateFinding[] = [
      { severity: '轻微', chapter: 'ch-05.md', line: 0, check: 'a', detail: '' },
      { severity: '中等', chapter: 'ch-05.md', line: 0, check: 'b', detail: '' },
    ];
    const st = await writeJudgeStatus(root, fakeResult(findings, 2), 12345);
    assert.equal(st.worst, '中等');
    assert.equal(st.count, 2);
    assert.equal(st.manual, 2, '人工清单长度与拦截条数分开记');
    assert.equal(st.checkedMtimeMs, 12345);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★readJudgeStatus：章节文件被改动（mtime 不符）→ 该章判据结论作废', async () => {
  const root = await makeBook();
  try {
    const abs = path.join(root, 'chapters', 'ch-05.md');
    await writeFile(abs, CHAPTER, 'utf-8');
    const st = await writeJudgeStatus(root, fakeResult([], 1), 111);
    assert.equal(st.count, 0);
    // 写盘时用的是 mtime 111，与真实 mtime 不符 → 读回来必须已清掉
    const stale = await readJudgeStatus(root);
    assert.equal(Object.keys(stale.chapters).length, 0, 'mtime 不符的结论是假绿，必须作废');

    // 用真实 mtime 落一次，再改文件 → 也要作废
    const { stat } = await import('node:fs/promises');
    const real = (await stat(abs)).mtimeMs;
    await writeJudgeStatus(root, fakeResult([], 0), real);
    assert.equal(Object.keys((await readJudgeStatus(root)).chapters).length, 1);
    await utimes(abs, new Date(), new Date(Date.now() + 5000));
    assert.equal(Object.keys((await readJudgeStatus(root)).chapters).length, 0, '内容变了结论即失效');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
