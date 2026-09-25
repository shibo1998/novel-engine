import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EvalError, loadEvalSet, resetLlmBreaker, runEvalSet } from '../src/index.js';

/**
 * B-31 评测集：度量 Judge 的检出率与假红率。
 *
 * ★本文件最要紧的三条口径：
 *   · **`unsure` 既不算检出、也不算通过**（单独一列）——算进检出会虚高检出率，
 *     算进通过会虚低假红率，两个方向都在骗自己
 *   · **分母是「该类用例数」**：检出率分母是 fail 用例，假红率分母是 pass 用例
 *   · **用例数为 0 时是 `null` 不是 0**（「没测过」与「测了 0%」必须形状不同）
 */
async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-eval-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1, book: { title: '评测测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
    judges: { enabled: ['j3-continuity'] },
  }), 'utf-8');
  return root;
}

/** 造一个用例目录 */
async function addCase(
  root: string,
  name: string,
  chapterText: string,
  expect: { verdict: 'pass' | 'fail'; criterion?: string; note?: string },
): Promise<void> {
  const dir = path.join(root, 'evals', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'chapter.md'), chapterText, 'utf-8');
  await writeFile(path.join(dir, 'outline.md'), '# 细纲\n\n本章：林青回山门。\n', 'utf-8');
  await writeFile(path.join(dir, 'expect.json'), JSON.stringify({
    verdict: expect.verdict,
    ...(expect.criterion !== undefined ? { criterion: expect.criterion } : {}),
    note: expect.note ?? '',
  }), 'utf-8');
}

/** 假 LLM：按正文里的标记决定判什么（CONFLICT→fail / CLEAN→pass / UNSURE→unsure） */
async function withMarkerLLM(fn: () => Promise<void>): Promise<void> {
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const user = (JSON.parse(body) as { messages?: { role: string; content: string }[] })
        .messages?.find((m) => m.role === 'user')?.content ?? '';
      const verdict = user.includes('CONFLICT') ? 'fail' : (user.includes('UNSURE') ? 'unsure' : 'pass');
      const quote = /林青[^\n]*。/.exec(user)?.[0] ?? '他推开门。';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              results: [{ criterion: 'j3-continuity', verdict, quote, reason: `标记法判定：${verdict}` }],
            }),
          },
        }],
      }));
    });
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

// ── 装载 ──────────────────────────────────────────────────────────────────

test('★loadEvalSet：空目录 → 报错并给出结构说明（不返回空数组当「没事」）', async () => {
  const root = await makeBook();
  try {
    await assert.rejects(
      () => loadEvalSet(root),
      (e: unknown) => e instanceof EvalError && /评测集是空的/.test(e.message) && /chapter\.md/.test(e.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★loadEvalSet：缺 chapter.md / 缺 expect.json / verdict 非法 → 都报错（**不许静默跳过**）', async () => {
  const root = await makeBook();
  try {
    // 缺 chapter.md
    await mkdir(path.join(root, 'evals', 'a'), { recursive: true });
    await writeFile(path.join(root, 'evals', 'a', 'expect.json'), '{"verdict":"fail"}', 'utf-8');
    await assert.rejects(() => loadEvalSet(root), /缺 chapter\.md/);

    // 缺 expect.json
    await rm(path.join(root, 'evals'), { recursive: true, force: true });
    await mkdir(path.join(root, 'evals', 'b'), { recursive: true });
    await writeFile(path.join(root, 'evals', 'b', 'chapter.md'), '正文', 'utf-8');
    await assert.rejects(() => loadEvalSet(root), /缺 expect\.json.*没有期望就无从度量/s);

    // verdict 非法
    await rm(path.join(root, 'evals'), { recursive: true, force: true });
    await mkdir(path.join(root, 'evals', 'c'), { recursive: true });
    await writeFile(path.join(root, 'evals', 'c', 'chapter.md'), '正文', 'utf-8');
    await writeFile(path.join(root, 'evals', 'c', 'expect.json'), '{"verdict":"maybe"}', 'utf-8');
    await assert.rejects(() => loadEvalSet(root), /verdict 只能是 pass \/ fail/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadEvalSet：按目录名排序装载，缺 outline.md 不算错（J1 会判 unsure）', async () => {
  const root = await makeBook();
  try {
    await addCase(root, 'b-second', '林青走了。', { verdict: 'pass' });
    await addCase(root, 'a-first', '林青来了。', { verdict: 'fail', criterion: 'j3-continuity', note: '伤势矛盾' });
    const set = await loadEvalSet(root);
    assert.deepEqual(set.map((c) => c.name), ['a-first', 'b-second']);
    assert.equal(set[0]?.expect.criterion, 'j3-continuity');
    assert.equal(set[0]?.expect.note, '伤势矛盾');
    assert.ok(set[0]?.outlineText.includes('林青回山门'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 度量 ──────────────────────────────────────────────────────────────────

test('★全链路：命中/漏检/误报/unsure 四种结局与三个比率的分子分母', async () => {
  const root = await makeBook();
  try {
    await addCase(root, '1-应检出-真冲突', '林青推开门。CONFLICT', { verdict: 'fail', criterion: 'j3-continuity' });
    await addCase(root, '2-应检出-但被放过', '林青推开门。CLEAN', { verdict: 'fail', criterion: 'j3-continuity' });
    await addCase(root, '3-应放过-真干净', '林青推开门。CLEAN', { verdict: 'pass', criterion: 'j3-continuity' });
    await addCase(root, '4-应放过-被误报', '林青推开门。CONFLICT', { verdict: 'pass', criterion: 'j3-continuity' });
    await addCase(root, '5-判不出来', '林青推开门。UNSURE', { verdict: 'fail', criterion: 'j3-continuity' });

    await withMarkerLLM(async () => {
      const r = await runEvalSet(root);
      assert.equal(r.counts.total, 5);
      assert.equal(r.counts.fail, 3, '应检出 3 例');
      assert.equal(r.counts.pass, 2, '应放过 2 例');
      assert.equal(r.counts.hit, 1);
      assert.equal(r.counts.miss, 1);
      assert.equal(r.counts.falseAlarm, 1);
      assert.equal(r.counts.unsure, 1);

      // ★分母是「该类用例数」：检出率 1/3（fail 用例），假红率 1/2（pass 用例）
      assert.equal(r.detectionRate, Number((1 / 3).toFixed(3)));
      assert.equal(r.falseAlarmRate, 0.5);
      assert.equal(r.unsureRate, 0.2, 'unsure 分母是全部用例');

      const byName = new Map(r.cases.map((c) => [c.name, c]));
      assert.equal(byName.get('1-应检出-真冲突')?.outcome, 'hit');
      assert.equal(byName.get('2-应检出-但被放过')?.outcome, 'miss');
      assert.equal(byName.get('3-应放过-真干净')?.outcome, 'ok');
      assert.equal(byName.get('4-应放过-被误报')?.outcome, 'false-alarm');
      // ★unsure 既不算检出也不算放过
      assert.equal(byName.get('5-判不出来')?.outcome, 'unsure');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★用例数为 0 时比率是 null（「没测过」与「测了 0%」必须形状不同）', async () => {
  const root = await makeBook();
  try {
    // 只有 pass 用例 → 检出率分母为 0 → null
    await addCase(root, 'only-pass', '林青推开门。CLEAN', { verdict: 'pass', criterion: 'j3-continuity' });
    await withMarkerLLM(async () => {
      const r = await runEvalSet(root);
      assert.equal(r.counts.fail, 0);
      assert.equal(r.detectionRate, null, '★没有「应检出」的用例 → 检出率是没有数据，不是 100%');
      assert.equal(r.falseAlarmRate, 0, '有 pass 用例且没误报 → 真的是 0');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('未声明判据 → 明确报错（评测无从跑起），不返回空报告', async () => {
  const root = await makeBook();
  try {
    const cfgPath = path.join(root, '.soloent', 'book.json');
    const cfg = JSON.parse(await (await import('node:fs/promises')).readFile(cfgPath, 'utf-8')) as Record<string, unknown>;
    cfg['judges'] = { enabled: [] };
    await writeFile(cfgPath, JSON.stringify(cfg), 'utf-8');
    await addCase(root, 'x', '林青推开门。CLEAN', { verdict: 'pass' });
    await assert.rejects(() => runEvalSet(root), /未声明任何判据/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expect.criterion 指定了判据但判据没跑 → outcome=no-judges（不静默算成漏检）', async () => {
  const root = await makeBook();
  try {
    await addCase(root, 'x', '林青推开门。CLEAN', { verdict: 'fail', criterion: '不存在的判据' });
    await withMarkerLLM(async () => {
      const r = await runEvalSet(root);
      assert.equal(r.cases[0]?.outcome, 'no-judges');
      assert.equal(r.cases[0]?.actual, 'missing');
      // ★no-judges 不计入 hit/miss/falseAlarm/unsure 任何一桶
      assert.equal(r.counts.hit + r.counts.miss + r.counts.falseAlarm + r.counts.unsure, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
