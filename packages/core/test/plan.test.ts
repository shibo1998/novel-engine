import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PlanNotReadyError,
  assertPlanReady,
  checkPlanGate,
  confirmLayer,
  initPlan,
  layerFile,
  planStatus,
  readPlan,
  writePosition,
} from '../src/index.js';

// B-10 逐层递进建书：确认闸门 / 待复核 / 旧书不连坐

const FULL_ANSWERS: Record<string, string> = {
  genre: '玄幻-高武',
  platform: '番茄',
  reader: '男频，偏爽文',
  logline: '落魄少年靠加点系统一路向上',
  protagonist: '林青，出身寒门，急躁，学会忍耐',
  cheat: '加点系统，只能加已练过的项',
  tone: '热血，第三人称限知，短句',
  selling: '打脸、升级、智斗',
  scale: '200 万字，10 卷，每章 2200 字',
  ending: '登临绝顶后回望来路',
};

async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-plan-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'outline'), { recursive: true });
  await mkdir(path.join(root, 'book'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    book: { title: '测试书', genre: '玄幻', platform: '番茄' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    rules: { author: [], plugin: [] },
  }), 'utf-8');
  return root;
}

const write = (root: string, rel: string, text: string): Promise<void> =>
  writeFile(path.join(root, rel), text, 'utf-8');

/** 把 5 层全部写完并确认，返回 root。volume 章节范围由调用方给 */
async function confirmAllLayers(root: string, chapters = { from: 1, to: 60 }): Promise<void> {
  await initPlan(root);
  await writePosition(root, FULL_ANSWERS);
  await confirmLayer(root, 'position');
  await write(root, layerFile('setting'), '# 正典\n\n境界：炼气→筑基→金丹。\n');
  await confirmLayer(root, 'setting');
  await write(root, layerFile('outline'), '# 总纲\n\n第一卷：山门崛起。\n');
  await confirmLayer(root, 'outline');
  await write(root, layerFile('volume', 1), '# 第 1 卷卷纲\n\n1-20 入门；21-40 扬名；41-60 立威。\n');
  await confirmLayer(root, 'volume', { volume: 1, chapters });
  await write(root, layerFile('detail', 1), '1 入山：林青拜入山门 ｜钩子·悬念：谁在暗处看他\n');
  await confirmLayer(root, 'detail', { volume: 1 });
}

test('未开启逐层流程的书：status 不启用、闸门恒就绪、assert 不抛（旧书不被连坐）', async () => {
  const root = await makeBook();
  try {
    const s = await planStatus(root);
    assert.equal(s.enabled, false);
    assert.equal(s.next, null);
    const gate = await checkPlanGate(root, 1);
    assert.equal(gate.enabled, false);
    assert.equal(gate.ready, true);
    // 关键：断言函数对旧书必须是空操作，否则所有存量书一起被闸门挡死
    await assertPlanReady(root, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init 幂等：已存在 plan.json 时原样返回，不冲掉已有确认记录', async () => {
  const root = await makeBook();
  try {
    await initPlan(root);
    await writePosition(root, FULL_ANSWERS);
    await confirmLayer(root, 'position');
    const before = await readPlan(root);
    await initPlan(root);
    const after = await readPlan(root);
    assert.deepEqual(after, before, 'init 不得覆盖确认记录');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('定位层：缺必答项拒绝写盘；可选题留空不拦', async () => {
  const root = await makeBook();
  try {
    await initPlan(root);
    const { logline, ...missing } = FULL_ANSWERS;
    await assert.rejects(() => writePosition(root, missing), /定位问答缺必答项/);
    // 可选题（对标书/禁区）不答也能写
    await writePosition(root, FULL_ANSWERS);
    const text = await readFile(path.join(root, layerFile('position')), 'utf-8');
    assert.ok(text.includes('## 一句话故事'));
    assert.ok(text.includes(logline));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('闸门：上游未确认时确认下游被拒（逐层解锁，不能跳层）', async () => {
  const root = await makeBook();
  try {
    await initPlan(root);
    await write(root, layerFile('setting'), '# 正典\n\n境界：炼气。\n');
    await assert.rejects(() => confirmLayer(root, 'setting'), /上游层「position」状态为 missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('闸门：文件含「（待填）」时拒绝确认（占位符不算填过）', async () => {
  const root = await makeBook();
  try {
    await initPlan(root);
    await writePosition(root, FULL_ANSWERS);
    await confirmLayer(root, 'position');
    await write(root, layerFile('setting'), '# 正典\n\n境界：（待填）\n');
    await assert.rejects(() => confirmLayer(root, 'setting'), /仍含「（待填）」/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★确认后改动文件 → 回到待确认（签字只对签字那一刻的内容有效）', async () => {
  const root = await makeBook();
  try {
    await initPlan(root);
    await writePosition(root, FULL_ANSWERS);
    await confirmLayer(root, 'position');
    assert.equal((await planStatus(root)).layers[0]?.status, 'confirmed');
    await write(root, layerFile('position'), '# 故事定位\n\n## 一句话故事\n\n改过的定位。\n');
    assert.equal((await planStatus(root)).layers[0]?.status, 'unconfirmed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★上游重新确认 → 下游标待复核（stale），且不自动重写', async () => {
  const root = await makeBook();
  try {
    await confirmAllLayers(root);
    assert.equal((await planStatus(root)).next, null, '全确认后没有待办层');
    // 作者回头改了定位并重新确认 → 设定应变成待复核
    await write(root, layerFile('position'), '# 故事定位\n\n## 一句话故事\n\n换了个方向。\n');
    await confirmLayer(root, 'position');
    const setting = (await planStatus(root)).layers.find((l) => l.kind === 'setting');
    assert.equal(setting?.status, 'stale');
    assert.equal(setting?.staleBecause, 'position');
    // 正式文件本身没被动过（不自动重写）
    const text = await readFile(path.join(root, layerFile('setting')), 'utf-8');
    assert.ok(text.includes('炼气'), '下游文件不得被自动改写');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('卷纲确认必须给章节范围；范围重叠被拒', async () => {
  const root = await makeBook();
  try {
    await initPlan(root);
    await writePosition(root, FULL_ANSWERS);
    await confirmLayer(root, 'position');
    await write(root, layerFile('setting'), '# 正典\n\n境界：炼气。\n');
    await confirmLayer(root, 'setting');
    await write(root, layerFile('outline'), '# 总纲\n\n第一卷：山门崛起。\n');
    await confirmLayer(root, 'outline');
    await write(root, layerFile('volume', 1), '# 第 1 卷卷纲\n\n入门到立威。\n');
    await assert.rejects(() => confirmLayer(root, 'volume', { volume: 1 }), /须给出本卷章节范围/);
    await confirmLayer(root, 'volume', { volume: 1, chapters: { from: 1, to: 60 } });
    await write(root, layerFile('volume', 2), '# 第 2 卷卷纲\n\n出山。\n');
    await assert.rejects(
      () => confirmLayer(root, 'volume', { volume: 2, chapters: { from: 60, to: 120 } }),
      /与第 1 卷重叠/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★闸门：章节不属于任何已确认的卷 → 不就绪，assertPlanReady 抛 PlanNotReadyError', async () => {
  const root = await makeBook();
  try {
    await confirmAllLayers(root, { from: 1, to: 60 });
    const inVol = await checkPlanGate(root, 30);
    assert.equal(inVol.ready, true);
    assert.equal(inVol.volume, 1);
    const outVol = await checkPlanGate(root, 61);
    assert.equal(outVol.ready, false);
    assert.ok(outVol.blocking.some((b) => b.includes('不属于任何已确认的卷')));
    await assert.rejects(
      () => assertPlanReady(root, 61),
      (e: unknown) => e instanceof PlanNotReadyError && /不属于任何已确认的卷/.test(e.message),
    );
    // 就绪的那章必须放行
    await assertPlanReady(root, 30);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★闸门：上游某层回到待确认 → 整卷不就绪（一层的签字失效会挡住下游章节）', async () => {
  const root = await makeBook();
  try {
    await confirmAllLayers(root);
    assert.equal((await checkPlanGate(root, 10)).ready, true);
    await write(root, layerFile('outline'), '# 总纲\n\n改过的总纲。\n');
    const gate = await checkPlanGate(root, 10);
    assert.equal(gate.ready, false);
    assert.ok(gate.blocking.some((b) => b.includes('总纲')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('细纲确认后：book.json 的 paths.outline 指向该卷细纲，确认回传指纹', async () => {
  const root = await makeBook();
  try {
    await confirmAllLayers(root);
    const cfg = JSON.parse(await readFile(path.join(root, '.soloent', 'book.json'), 'utf-8')) as {
      paths: { outline?: string };
    };
    assert.equal(cfg.paths.outline, 'outline/vol-01-细纲.md');
    const r = await confirmLayer(root, 'detail', { volume: 1 });
    assert.equal(r.hash.length, 16, '确认要回传本次签下的指纹，供作者核对');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan.json 的 schemaVersion 不认识 → 明确报错，不静默当空', async () => {
  const root = await makeBook();
  try {
    await write(root, '.soloent/plan.json', JSON.stringify({ schemaVersion: 99, layers: {}, volumes: [] }));
    await assert.rejects(() => planStatus(root), /schemaVersion 不支持/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── B-58：定位层同步 book.json 的 book 段 ──────────────────────────────────

test('★B-58：定位答案写进 book 段的映射键；原有键不丢；可选题留空不覆盖', async () => {
  const root = await makeBook();
  try {
    await initPlan(root);
    await writePosition(root, { ...FULL_ANSWERS, reader: '男频爽文', tone: '热血短句' });
    const cfg = JSON.parse(await readFile(path.join(root, '.soloent', 'book.json'), 'utf-8')) as {
      book: Record<string, string>;
    };
    assert.equal(cfg.book['genre'], '玄幻-高武', 'genre 要被问答覆盖（初始值是「玄幻」）');
    assert.equal(cfg.book['audience'], '男频爽文', 'reader → book.audience');
    assert.equal(cfg.book['tone'], '热血短句');
    assert.equal(cfg.book['title'], '测试书', '原有键不许被冲掉');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★B-58：不认识的答案 id 不写进 book 段（问答表以后加题不会误塞）', async () => {
  const root = await makeBook();
  try {
    await initPlan(root);
    await writePosition(root, { ...FULL_ANSWERS, 未来才有的题: '值' });
    const cfg = JSON.parse(await readFile(path.join(root, '.soloent', 'book.json'), 'utf-8')) as {
      book: Record<string, string>;
    };
    assert.equal('未来才有的题' in cfg.book, false, '映射表外的 id 一律不写——否则 book 段会被问答表牵着走');
    assert.equal(cfg.book['title'], '测试书');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★B-58：book.json 坏掉时 premise.md 仍要落盘（真相源不陪葬）', async () => {
  const root = await makeBook();
  try {
    await initPlan(root);
    await write(root, '.soloent/book.json', '{ 这不是合法 JSON');
    const rel = await writePosition(root, FULL_ANSWERS);
    assert.equal(rel, 'book/premise.md');
    const text = await readFile(path.join(root, 'book/premise.md'), 'utf-8');
    assert.ok(text.includes('## 一句话故事'), 'premise.md 是真相源，book.json 坏不该连带它一起失败');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
