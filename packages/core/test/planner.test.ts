import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PlannerError,
  confirmLayer,
  expandNextVolume,
  initPlan,
  nextVolume,
  resetLlmBreaker,
  reviseCompass,
  writePosition,
} from '../src/index.js';

/**
 * B-40 Planner 滚动展开。
 *
 * ★本文件最要紧的一条：**M8.6「顺序不可反」用形状强制，不靠文档提醒**。
 * 总纲没在本卷已写内容之后重新校准过，`expandNextVolume` 直接拒绝。
 * 靠文档说「记得先改指南针」是不够的——忘了不会有任何红灯。
 */
const ANSWERS: Record<string, string> = {
  genre: '玄幻-高武', platform: '番茄', reader: '男频爽文',
  logline: '落魄少年靠加点系统向上', protagonist: '林青，寒门',
  cheat: '加点系统', tone: '热血短句', selling: '打脸升级',
  scale: '200万字10卷', ending: '登临绝顶',
};

async function makeBook(chapters: number, withPlan = true): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-planner-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'outline'), { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '滚动展开测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  for (let i = 1; i <= chapters; i++) {
    await writeFile(path.join(root, 'chapters', `ch-${String(i).padStart(2, '0')}.md`), `# 第${i}章\n\n他推开门。\n`, 'utf-8');
  }
  if (withPlan) {
    await initPlan(root);
    await writePosition(root, ANSWERS);
    await confirmLayer(root, 'position');
    await writeFile(path.join(root, '.soloent', 'canon.md'), '# 正典\n\n境界：炼气→筑基。\n', 'utf-8');
    await confirmLayer(root, 'setting');
    await writeFile(path.join(root, 'outline', '总纲.md'), '# 总纲\n\n第一卷：山门崛起。\n', 'utf-8');
    await confirmLayer(root, 'outline');
  }
  return root;
}

/** 跑一段带假 LLM 的代码 */
async function withFakeLLM(text: string, fn: () => Promise<void>): Promise<void> {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
    });
    resetLlmBreaker();
    await fn();
  } finally {
    Object.assign(process.env, saved);
    resetLlmBreaker();
    srv.close();
  }
}

test('★nextVolume：一卷没登记 → 第 1 卷；已登记 → 最大号 + 1', async () => {
  const root = await makeBook(0);
  try {
    assert.equal((await nextVolume(root)).volume, 1);
    await writeFile(path.join(root, 'outline', 'vol-01.md'), '# 第 1 卷卷纲\n\n入门。\n', 'utf-8');
    await confirmLayer(root, 'volume', { volume: 1, chapters: { from: 1, to: 60 } });
    const info = await nextVolume(root);
    assert.equal(info.volume, 2);
    assert.deepEqual(info.knownVolumes, [1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★M8.6 顺序不可反：已写章节超过总纲校准点 → **拒绝展开**', async () => {
  const root = await makeBook(3);   // 已写 3 章，总纲从未校准（compassRevisedUpToChapter = 0）
  try {
    const info = await nextVolume(root);
    assert.equal(info.needsCompassRevision, true);
    assert.match(info.why, /已写到第 3 章.*总纲上次校准只到第 0 章/);

    await assert.rejects(
      () => expandNextVolume(root),
      (e: unknown) => {
        assert.ok(e instanceof PlannerError);
        assert.match(e.message, /拒绝展开第 1 卷/);
        assert.match(e.message, /novel planner compass/, '要给出下一步命令');
        assert.match(e.message, /顺序不可反/, '要说清为什么');
        assert.match(e.message, /--no-enforce-order/, '要给出罕见情况的出路');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★reviseCompass 之后就能展开；且只写 state/drafts/，不碰正式文件', async () => {
  const root = await makeBook(3);
  try {
    const outlineBefore = await readFile(path.join(root, 'outline', '总纲.md'), 'utf-8');
    await withFakeLLM('# 总纲（校准版）\n\n第一卷：山门崛起（已写 3 章）。\n', async () => {
      const r = await reviseCompass(root);
      assert.equal(r.ok, true, `校准应成功：${JSON.stringify(r)}`);
      if (r.ok) {
        assert.equal(r.draftFile, 'state/drafts/compass.md');
        assert.equal(r.compassRevisedUpToChapter, 3, '校准点要记成「已写到第几章」');
      }
      // 正式文件**没被动过**——起草只写派生稿
      assert.equal(await readFile(path.join(root, 'outline', '总纲.md'), 'utf-8'), outlineBefore);
      assert.equal(await stat(path.join(root, 'state', 'drafts', 'compass.md')).catch(() => null) !== null, true);

      const info = await nextVolume(root);
      assert.equal(info.needsCompassRevision, false, '校准后应可展开');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★expandNextVolume：展开下一卷，只写 drafts，且只展一卷', async () => {
  const root = await makeBook(3);
  try {
    await withFakeLLM('# 总纲（校准版）\n\n第一卷：山门崛起。\n', async () => {
      await reviseCompass(root);
    });
    await withFakeLLM('# 第 1 卷卷纲\n\n1-20 入门；21-40 扬名；41-60 立威。\n', async () => {
      const r = await expandNextVolume(root);
      assert.equal(r.ok, true, `展开应成功：${JSON.stringify(r)}`);
      if (r.ok) {
        assert.equal(r.volume, 1);
        assert.equal(r.draftFile, 'state/drafts/volume-01.md');
        assert.equal(r.orderEnforced, true);
      }
    });
    // ★一次只展一卷：正式文件仍不存在，drafts 里也只有这一卷
    assert.equal(await stat(path.join(root, 'outline', 'vol-01.md')).catch(() => null), null, '起草不碰正式文件');
    assert.equal(await stat(path.join(root, 'state', 'drafts', 'volume-02.md')).catch(() => null), null, '不许顺手展开远卷');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★--no-enforce-order：跳过顺序检查，但返回值里**留痕**（orderEnforced=false）', async () => {
  const root = await makeBook(3);
  try {
    await withFakeLLM('# 第 1 卷卷纲\n\n入门。\n', async () => {
      const r = await expandNextVolume(root, { enforceOrder: false });
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.orderEnforced, false, '★跳过了检查必须留痕，不能和正常路径同形');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('未开启逐层流程 → 明确报错（不是静默当成「第 1 卷」）', async () => {
  const root = await makeBook(0, false);
  try {
    await assert.rejects(() => nextVolume(root), /未开启逐层流程/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('校准后总纲又被改（未确认）不影响展开判定——判定只看「校准点 vs 已写进度」', async () => {
  const root = await makeBook(2);
  try {
    await withFakeLLM('# 校准版总纲\n', async () => { await reviseCompass(root); });
    // 作者改了正式总纲但没确认 → 不该让 expand 通过（那是 plan 闸门的事，不是 planner 的事）
    await writeFile(path.join(root, 'outline', '总纲.md'), '# 改过的总纲\n', 'utf-8');
    const info = await nextVolume(root);
    assert.equal(info.needsCompassRevision, false, 'planner 只管「顺序」，不管「确认状态」');
    // 确认状态由 layerConfirmed 单独回答（CLI 用它给提醒）
    const { layerConfirmed } = await import('../src/index.js');
    assert.equal(await layerConfirmed(root, 'outline'), false, '★改了没确认 → 不算已确认（两个问题分开回答）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
