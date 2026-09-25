import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ARBITER_SAMPLES,
  ArbiterError,
  askArbiter,
  assertQuestion,
  listDecisions,
  parseChoice,
  recordHumanDecision,
  resetLlmBreaker,
} from '../src/index.js';

/**
 * B-43 Arbiter 四类封闭裁定。
 *
 * ★五条纪律各有对应用例，最要紧的三条：
 *   · **默认人工**：不开 auto 就**连模型都不调**（不配 LLM env 也不该报错）
 *   · **候选集由 Engine 给全**：返回不在候选集里的值判**无效**，不猜它想说什么
 *   · **自洽采样 3 次**：不一致就交人（不用模型自报的置信度——那是没校准的数字）
 */
async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-arbiter-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1, book: { title: '裁定测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  return root;
}

const Q = {
  kind: 'pick-strategy' as const,
  prompt: '林青被围在藏经阁，走哪条线？',
  candidates: ['正面突围', '诈降后反杀', '从密道走'],
};

/** 起一个按调用次序返回不同内容的假 LLM；返回请求计数器 */
async function withFakeLLM(
  replies: string[],
  fn: (calls: () => number) => Promise<void>,
): Promise<void> {
  let calls = 0;
  const srv = createServer((_req, res) => {
    const i = calls;
    calls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: replies[i] ?? replies.at(-1) ?? '' } }] }));
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
    await fn(() => calls);
  } finally {
    Object.assign(process.env, saved);
    resetLlmBreaker();
    srv.close();
  }
}

// ── 候选集是边界 ──────────────────────────────────────────────────────────

test('★assertQuestion：未知题型 / 候选少于 2 项 / 候选重复 都拒绝', async () => {
  await assert.rejects(async () => assertQuestion({ ...Q, kind: '瞎猜' as never }), /未知题型/);
  await assert.rejects(async () => assertQuestion({ ...Q, candidates: ['只有一个'] }), /候选集少于 2 项/);
  await assert.rejects(async () => assertQuestion({ ...Q, candidates: ['A', 'A'] }), /重复项/);
  // 「候选少于 2 项」的报错要说清为什么不能交给模型自由发挥
  await assert.rejects(
    async () => assertQuestion({ ...Q, candidates: [] }),
    /没有可选的东西就不是裁定/,
  );
});

test('★parseChoice：只认候选集里的字面值；模糊匹配一律判无效', () => {
  assert.equal(parseChoice('正面突围', Q.candidates), '正面突围', '整段就是一个候选');
  assert.equal(parseChoice('{"choice":"诈降后反杀","reason":"x"}', Q.candidates), '诈降后反杀', 'JSON 形式');
  assert.equal(parseChoice('我选 从密道走。', Q.candidates), '从密道走', '唯一提及');
  assert.equal(parseChoice('正面突围或者诈降后反杀都行', Q.candidates), null, '★提及多个 → 无效，不猜');
  assert.equal(parseChoice('第四条路：装死', Q.candidates), null, '★自己造第五个选项 → 无效');
});

// ── 默认人工 ──────────────────────────────────────────────────────────────

test('★默认人工：不开 auto → **连模型都不调**（不配 LLM env 也不报错）', async () => {
  const root = await makeBook();
  const saved = { ...process.env };
  try {
    delete process.env['LLM_BASE_URL'];
    delete process.env['LLM_API_KEY'];
    delete process.env['LLM_MODEL'];
    const r = await askArbiter(root, Q);
    assert.equal('ok' in r, false, '默认路径不该返回 LLM 失败 union');
    const d = r as Exclude<typeof r, { ok: false }>;
    assert.equal(d.by, 'human-needed');
    assert.equal(d.choice, undefined, '★没定就是没定——不许填一个默认值');
    assert.match(d.reason, /默认人工裁定/);
    assert.match(d.reason, /不替作者决定/);
  } finally {
    Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true });
  }
});

// ── 自洽采样 ──────────────────────────────────────────────────────────────

test('★auto + 三次一致 → 采信；samples 留着供核对', async () => {
  const root = await makeBook();
  try {
    await withFakeLLM(
      ['诈降后反杀', '{"choice":"诈降后反杀"}', '我选 诈降后反杀。'],
      async (calls) => {
        const r = await askArbiter(root, Q, { auto: true });
        const d = r as Exclude<typeof r, { ok: false }>;
        assert.equal(d.by, 'llm');
        assert.equal(d.choice, '诈降后反杀');
        assert.equal(d.samples?.length, ARBITER_SAMPLES, `要采样 ${ARBITER_SAMPLES} 次`);
        assert.equal(calls(), ARBITER_SAMPLES);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★auto + 三次不一致 → **交人**（不用模型自报的置信度）', async () => {
  const root = await makeBook();
  try {
    await withFakeLLM(['正面突围', '诈降后反杀', '从密道走'], async () => {
      const r = await askArbiter(root, Q, { auto: true });
      const d = r as Exclude<typeof r, { ok: false }>;
      assert.equal(d.by, 'human-needed', '★不一致就是有歧义，那正是人该介入的地方');
      assert.equal(d.choice, undefined);
      assert.deepEqual(d.samples, ['正面突围', '诈降后反杀', '从密道走'], '三次原始结果要留着供排查');
      assert.match(d.reason, /不一致/);
      assert.match(d.reason, /这题本身有歧义/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★auto + 模型造了候选集外的选项 → 判无效 → 交人', async () => {
  const root = await makeBook();
  try {
    await withFakeLLM(['装死', '装死', '装死'], async () => {
      const r = await askArbiter(root, Q, { auto: true });
      const d = r as Exclude<typeof r, { ok: false }>;
      assert.equal(d.by, 'human-needed');
      assert.match(d.reason, /没能选出候选集里的项/);
      assert.ok((d.samples ?? []).every((s) => s.startsWith('(无效：')), '无效的采样要标出来，不能静默丢弃');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 人工裁定 ──────────────────────────────────────────────────────────────

test('★recordHumanDecision：choice 必须在候选集里；reason 必填', async () => {
  const root = await makeBook();
  try {
    await assert.rejects(
      () => recordHumanDecision(root, Q, '第四条路', '因为'),
      (e: unknown) => e instanceof ArbiterError && /不在候选集里/.test(e.message)
        && /要加选项，先把它加进候选集/.test(e.message),
    );
    await assert.rejects(
      () => recordHumanDecision(root, Q, '正面突围', '   '),
      /必须给 --reason/,
    );
    const d = await recordHumanDecision(root, Q, '正面突围', '读者要的是爽，不是绕');
    assert.equal(d.by, 'human');
    assert.equal(d.choice, '正面突围');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('落盘：d-0001 递增，list 能读回来，且**不含正文字段**（只选不写）', async () => {
  const root = await makeBook();
  try {
    const a = await askArbiter(root, Q);
    const b = await askArbiter(root, { ...Q, kind: 'escape-route' });
    assert.equal((a as { id: string }).id, 'd-0001');
    assert.equal((b as { id: string }).id, 'd-0002');

    const raw = await readFile(path.join(root, 'state', 'decisions', 'd-0001.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ['at', 'by', 'id', 'question', 'reason'],
      '★裁定记录里不该有正文类字段——裁定层只选不写');

    const list = await listDecisions(root);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((d) => d.id), ['d-0001', 'd-0002']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listDecisions：坏文件跳过，不因为一个坏文件让整份清单读不出来', async () => {
  const root = await makeBook();
  try {
    await askArbiter(root, Q);
    await writeFile(path.join(root, 'state', 'decisions', 'd-9999.json'), '{ 这不是 JSON', 'utf-8');
    const list = await listDecisions(root);
    assert.equal(list.length, 1, '坏文件跳过，好的照读');
    assert.equal(list[0]?.id, 'd-0001');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('四类题型都可用；题型不在清单里就拒绝', async () => {
  const root = await makeBook();
  try {
    for (const kind of ['pick-strategy', 'blast-radius', 'escape-route', 'assign-payoff'] as const) {
      const r = await askArbiter(root, { ...Q, kind });
      assert.equal((r as { question: { kind: string } }).question.kind, kind);
    }
    await assert.rejects(() => askArbiter(root, { ...Q, kind: 'x' as never }), /未知题型/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
