import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyGateResult,
  callLLM,
  GateFailureError,
  llmBreakerState,
  readState,
  resetLlmBreaker,
  runGates,
  snapshotChapterMtimes,
  writeState,
} from '../src/index.js';

/**
 * 假绿防线的回归网。
 *
 * 为什么要有这个文件：F12/F13/F15/F17 那批修复的保证，当时只用一次性探针验过，
 * 探针用完即删——等于把「不再退回零章全绿」「跑期间改动不算已检」这些不变量
 * 交给注释去守。一次重构就能悄悄退回去，而且退回时**不会有任何红灯**。
 * 这里把其中不依赖 Python 的部分固化成测试。
 *
 * 未覆盖（需要外部依赖，留待专门的集成测试）：
 *   - gate 子进程超时（需往 gates/ 放一个假检查器）
 *   - 检查器 exit 2 那条路径（需真 Python）
 */

/** 造一本可通过配置校验的最小书；不用 gates/kit.py 校验，只要 readState/runGates 认。 */
async function makeBook(chapterCount: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-invariant-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '不变量测试书' },
    paths: {
      chapters: 'chapters',
      canon: '.soloent/canon.md',
      ledger: '.soloent/ledger.tsv',
      now: '.soloent/now.md',
    },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章', '标题'], chapter_column: '章', title_column: '标题' },
  }), 'utf-8');
  for (let i = 1; i <= chapterCount; i++) {
    await writeFile(
      path.join(root, 'chapters', `ch-${String(i).padStart(2, '0')}.md`),
      `# 第${i}章 标题\n\n${'他推开门，雨声压下来。'.repeat(10)}\n`,
      'utf-8',
    );
  }
  return root;
}

const fakeGateResult = (bookRoot: string, chapterCount: number) => ({
  gate: 'consistency_check',
  book_root: bookRoot,
  chapter_count: chapterCount,
  counts: {},
  findings: [],
});

test('F12：检查器扫到的章数与 state 不等时，拒绝对账并保持 state 原样', async () => {
  const root = await makeBook(3);
  try {
    const state = await readState({ bookRoot: root });
    const before = JSON.stringify(state.chapters.map((c) => c.gateStatus));
    await assert.rejects(
      () => applyGateResult(state, fakeGateResult(root, 0)),
      (e: unknown) => e instanceof GateFailureError && e.kind === 'count-mismatch',
    );
    assert.equal(JSON.stringify(state.chapters.map((c) => c.gateStatus)), before, 'state 不得被改动');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F17：跑 gate 期间被改过的章，回填后仍回到「待检」；其余章不受连坐', async () => {
  const root = await makeBook(3);
  try {
    const state = await readState({ bookRoot: root });
    const snapshot = await snapshotChapterMtimes(root, state.chapters);
    const target = state.chapters[1];

    // 模拟「快照之后、回填之前有人改了正文」
    const p = path.join(root, 'chapters', target.file);
    const later = new Date(Date.now() + 5000);
    await utimes(p, later, later);

    await applyGateResult(state, fakeGateResult(root, 3), { mtimeSnapshot: snapshot });
    await writeState(state);
    const after = await readState({ bookRoot: root });

    assert.equal(after.chapters.find((c) => c.file === target.file)?.gateStatus, null, '改动章必须回到待检');
    const others = after.chapters.filter((c) => c.file !== target.file);
    assert.equal(others.filter((c) => c.gateStatus !== null).length, others.length, '其余章状态应保留');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F17 反证：不给跑前快照时，改动章会被当成「已检」——这就是被修掉的那个窗口', async () => {
  const root = await makeBook(3);
  try {
    const state = await readState({ bookRoot: root });
    const target = state.chapters[1];
    const p = path.join(root, 'chapters', target.file);
    const later = new Date(Date.now() + 5000);
    await utimes(p, later, later);

    // 不给快照 → 回填时 stat 到的是**改动后**的 mtime，于是 checkedMtimeMs 与之相等，
    // 过期清扫认为它新鲜。断言「它没被置 null」正是为了钉住这个旧行为。
    await applyGateResult(state, fakeGateResult(root, 3));
    await writeState(state);
    const after = await readState({ bookRoot: root });
    assert.notEqual(
      after.chapters.find((c) => c.file === target.file)?.gateStatus,
      null,
      '不给快照时确实会留下假绿——这条断言就是 F17 存在的理由',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F12 落点1：bookRoot 不是目录时，spawn 之前就失败（kind=root）', async () => {
  const root = await makeBook(1);
  try {
    const notADir = path.join(root, 'chapters', 'ch-01.md');
    await assert.rejects(
      () => runGates({ bookRoot: notADir }),
      (e: unknown) => e instanceof GateFailureError && e.kind === 'root',
    );
    await assert.rejects(
      () => runGates({ bookRoot: path.join(root, '不存在的目录') }),
      (e: unknown) => e instanceof GateFailureError && e.kind === 'root',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F15：持续 5xx 时熔断开路，后续调用不再发请求（请求数有上界）', async () => {
  let requests = 0;
  const srv = createServer((_req, res) => {
    requests += 1;
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  const saved = { ...process.env };
  try {
    process.env['LLM_BASE_URL'] = `http://127.0.0.1:${port}`;
    process.env['LLM_API_KEY'] = 'k';
    process.env['LLM_MODEL'] = 'm';
    process.env['NOVEL_LLM_RETRY_ATTEMPTS'] = '0';
    process.env['NOVEL_LLM_BREAKER_THRESHOLD'] = '2';
    process.env['NOVEL_LLM_BREAKER_COOLDOWN_MS'] = '60000';
    resetLlmBreaker();

    const bundle = { system: 's', user: 'u', ruleRefs: { author: [], plugin: [] } };
    const r1 = await callLLM(bundle);
    assert.equal(r1.ok, false);
    const r2 = await callLLM(bundle);
    assert.equal(r2.ok, false);
    assert.equal(requests, 2, '重试层数为 0 时每次调用只发一个请求');

    // 第 3、4 次应被熔断直接挡回，不再产生新请求
    const r3 = await callLLM(bundle);
    const r4 = await callLLM(bundle);
    assert.equal(r3.ok === false && r3.kind, 'circuit-open');
    assert.equal(r4.ok === false && r4.kind, 'circuit-open');
    assert.equal(requests, 2, '熔断后请求数必须冻结');
    assert.ok(llmBreakerState().consecutiveFailures >= 2);
  } finally {
    srv.close();
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
    resetLlmBreaker();
  }
});

test('篇幅口径自检：测试用的造书函数确实写出了预期章数（防夹具本身失真）', async () => {
  const root = await makeBook(4);
  try {
    const state = await readState({ bookRoot: root });
    assert.equal(state.chapters.length, 4);
    const s = await stat(path.join(root, 'chapters', 'ch-04.md'));
    assert.ok(s.size > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
