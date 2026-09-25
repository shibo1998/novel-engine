import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
  SCHEMA_VERSION,
  snapshotChapterHashes,
  stripConclusions,
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
    const snapshot = await snapshotChapterHashes(root, state.chapters);
    const target = state.chapters[1];

    // 模拟「快照之后、回填之前有人改了正文」。v2 起改的是**内容**——
    // 只动 mtime 已经骗不动了（见下一条用例），所以这里必须真改内容才叫「改过」。
    const p = path.join(root, 'chapters', target.file);
    await writeFile(p, `# 第2章 标题\n\n${'雨停了，他抬起头。'.repeat(10)}\n`, 'utf-8');

    await applyGateResult(state, fakeGateResult(root, 3), { hashSnapshot: snapshot });
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
    await writeFile(p, `# 第2章 标题\n\n${'雨停了，他抬起头。'.repeat(10)}\n`, 'utf-8');

    // 不给快照 → 回填时读到的是**改动后**的内容，于是 checkedHash 与之相等，
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

/**
 * `novel state --set` 的净化（2026-09-24 作者裁定「保留入口、剥掉越界部分」）。
 *
 * 为什么值得进这张不变量网：`--set` 原先能把任意 `gateStatus` 原样写盘，
 * 是本仓**唯一**一条不经任何检查就能写出绿的路。裁定之后它仍然存在（fixture／迁移
 * 用途），所以「它确实剥掉了摘要」这件事必须由测试守着——否则某次重构顺手删掉
 * `stripGateStatus`，那条路会**静默**回来，且不会有任何红灯。
 */
test('state --set 净化：stripConclusions 摘掉全部结论字段（gateStatus + needsReview），数据字段不连坐', async () => {
  const root = await makeBook(3);
  try {
    const state = await readState({ bookRoot: root });
    const forged = {
      ...state,
      chapters: state.chapters.map((ch, i) => ({
        ...ch,
        gateStatus: i === 0
          ? { worst: 'clean' as const, count: 0, checkedAt: new Date().toISOString(), checkedHash: 'deadbeef' }
          : null,
        needsReview: i === 1,
      })),
    };

    const { state: sanitized, removed } = stripConclusions(forged);

    assert.equal(removed.gateStatus, 1, '应如实报告摘掉了 1 章的摘要');
    assert.equal(removed.needsReview, 1, 'needsReview 也是结论，同样要摘');
    assert.equal(sanitized.chapters.every((c) => c.gateStatus === null), true, '不得残留任何摘要');
    assert.equal(sanitized.chapters.every((c) => !c.needsReview), true, '不得残留 needsReview');
    // 数据字段必须原样：净化只砍「结论」，不砍「输入」，否则迁移/fixture 用途就没了
    assert.deepEqual(
      sanitized.chapters.map((c) => [c.chapterNo, c.file, c.title, c.wordCount]),
      forged.chapters.map((c) => [c.chapterNo, c.file, c.title, c.wordCount]),
    );
    // 纯函数：不得就地改写调用方传进来的对象
    assert.notEqual(forged.chapters[0]?.gateStatus, null, '原对象应保持不变');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('state --set 净化：伪造的绿落盘后，readState 读回来仍是「待检」', async () => {
  const root = await makeBook(2);
  try {
    const state = await readState({ bookRoot: root });
    // ★这是关键夹具：checkedHash 取**真实内容指纹**，所以这枚假绿能存活过期清扫。
    // 若不走净化，它会一路显示成「已检通过」——这正是被堵掉的那条路。
    const realHash = state.chapters[0]!.contentHash;
    const forged = {
      ...state,
      chapters: state.chapters.map((ch) => ({
        ...ch,
        gateStatus: {
          worst: 'clean' as const,
          count: 0,
          checkedAt: new Date().toISOString(),
          checkedHash: realHash,
        },
        needsReview: true,
      })),
    };

    await writeState(stripConclusions(forged).state);
    const back = await readState({ bookRoot: root });

    assert.equal(
      back.chapters.every((c) => c.gateStatus === null),
      true,
      '未经检查的「绿」不得从 state --set 这条路进来',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── B-13：schema v2（指纹 mtime → contentHash）─────────────────────────────

test('★B-13：只动 mtime、内容没变 → 结论**不**作废（v1 在这里会白跑一遍检查器）', async () => {
  const root = await makeBook(2);
  try {
    const state = await readState({ bookRoot: root });
    await applyGateResult(state, fakeGateResult(root, 2));
    await writeState(state);
    const before = await readState({ bookRoot: root });
    assert.ok(before.chapters.every((c) => c.gateStatus !== null), '先有结论');

    // git checkout / 复制文件就是这个效果：内容一模一样，mtime 变了
    const p = path.join(root, 'chapters', 'ch-01.md');
    const later = new Date(Date.now() + 5000);
    await utimes(p, later, later);

    const after = await readState({ bookRoot: root });
    assert.ok(
      after.chapters.every((c) => c.gateStatus !== null),
      'v2 按内容指纹判定：内容没变，结论就不该作废',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★B-13：内容真变了 → 结论作废（哪怕 mtime 被改回去）', async () => {
  const root = await makeBook(2);
  try {
    const state = await readState({ bookRoot: root });
    await applyGateResult(state, fakeGateResult(root, 2));
    await writeState(state);
    const p = path.join(root, 'chapters', 'ch-01.md');
    const mtimeBefore = (await stat(p)).mtimeMs;

    await writeFile(p, '# 第1章 标题\n\n正文被换掉了。\n', 'utf-8');
    // 把 mtime 改回原值——v1 靠 mtime 判过期，这一步就能骗过它
    await utimes(p, new Date(mtimeBefore), new Date(mtimeBefore));

    const after = await readState({ bookRoot: root });
    assert.equal(
      after.chapters.find((c) => c.file === 'ch-01.md')?.gateStatus,
      null,
      'v2 按内容指纹判定：内容变了就必须作废，mtime 改回去也没用',
    );
    assert.equal(after.chapters.find((c) => c.file === 'ch-02.md')?.gateStatus !== null, true, '没改的章不受连坐');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★B-13：v1 的 story.json 能读进来，但 gateStatus 一律丢弃（不拿 mtime 给新格式背书）', async () => {
  const root = await makeBook(2);
  try {
    // 手写一份 v1 的 state：带 mtime 指纹的「绿」
    const files = ['ch-01.md', 'ch-02.md'];
    const v1 = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      bookRoot: path.resolve(root),
      chapters: files.map((file, i) => ({
        chapterNo: i + 1,
        file,
        title: `第${i + 1}章`,
        wordCount: 100,
        gateStatus: { worst: 'clean', count: 0, checkedAt: new Date().toISOString(), checkedMtimeMs: 1 },
      })),
    };
    await mkdir(path.join(root, 'state'), { recursive: true });
    await writeFile(path.join(root, 'state', 'story.json'), JSON.stringify(v1, null, 2), 'utf-8');

    const s = await readState({ bookRoot: root });
    assert.equal(s.schemaVersion, SCHEMA_VERSION, '读进来即升到 v2');
    assert.equal(s.chapters.length, 2, '章节不丢');
    assert.equal(s.chapters[0]?.title, '第1章', '数据字段保留');
    assert.equal(
      s.chapters.every((c) => c.gateStatus === null),
      true,
      'v1 的绿是用 mtime 判的——那正是要废掉的信号，不能带进 v2',
    );
    assert.equal(s.chapters.every((c) => c.contentHash !== ''), true, '迁移后指纹由当前内容算出来');

    // 落盘后再读，版本稳定
    await writeState(s);
    const raw = JSON.parse(await readFile(path.join(root, 'state', 'story.json'), 'utf-8')) as { schemaVersion: number };
    assert.equal(raw.schemaVersion, SCHEMA_VERSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
