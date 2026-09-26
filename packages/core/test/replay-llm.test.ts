import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callLLM, contentHash, resetLlmBreaker } from '../src/index.js';
import type { PromptBundle } from '../src/index.js';

/**
 * 录像 / 回放（B-26，v0.2 M7.6）。
 *
 * 治的是什么：凡「调模型的代码路径」都没法写确定性测试——要么每次真烧钱，
 * 要么只能测到「它没崩」。Judge / plan draft / 摘要 这些**判据型**逻辑因此
 * 只有纯函数部分被测到，真正「模型说了什么、我们怎么处理」那一段无人看守。
 *
 * ★三条纪律各有对应用例：
 *   1. 回放未命中 → **失败关闭**，绝不回退到真调模型
 *   2. 录像**脱敏**（不含 Authorization / API key）
 *   3. 回放**不需要 LLM_API_KEY**（否则不叫离线）
 */
const BUNDLE: PromptBundle = { system: 'sys', user: 'usr', ruleRefs: { author: [], plugin: [] } };

/** 起一个恒定返回 `text` 的假 LLM；返回 [baseUrl, 请求计数器, 关闭函数] */
async function fakeLLM(text: string): Promise<[string, () => number, () => void]> {
  let requests = 0;
  const srv = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return [`http://127.0.0.1:${port}`, () => requests, () => srv.close()];
}

/** 在给定的 env 覆盖下跑一段代码，结束后恢复原环境 */
async function withEnv(over: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // ★B-31 之后 LLM 配置有了第二种来源（~/.novel-engine/config.json）。
  // 不把它钉死，测试结果就取决于「作者磁盘上碰巧有什么」——那正是测试要消灭的不确定性。
  process.env['NOVEL_CONFIG_FILE'] = path.join(tmpdir(), 'novel-test-无此配置文件.json');
  resetLlmBreaker();
  try {
    await fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    resetLlmBreaker();
  }
}

const tmp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'novel-llmrec-'));

test('★录像：成功调用后落一份脱敏记录，且**不含 API key**', async () => {
  const dir = await tmp();
  const [base, count, close] = await fakeLLM('模型说的话');
  try {
    await withEnv({
      LLM_BASE_URL: base, LLM_API_KEY: 'sk-SECRET-do-not-record', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
      NOVEL_LLM_RECORD_DIR: dir,
    }, async () => {
      const r = await callLLM(BUNDLE);
      assert.equal(r.ok, true);
      assert.equal(count(), 1);
    });

    const files = await readdir(dir);
    assert.equal(files.length, 1, '一次调用落一份记录');
    const raw = await readFile(path.join(dir, files[0] as string), 'utf-8');
    assert.ok(!raw.includes('sk-SECRET-do-not-record'), '★录像绝不能含 API key——它会进版本控制');
    assert.ok(!raw.includes('Authorization'), '连 header 名都不该出现');
    const rec = JSON.parse(raw) as { hash: string; model: string; response: { text: string }; request: { system: string } };
    assert.equal(rec.response.text, '模型说的话');
    assert.equal(rec.model, 'm');
    assert.equal(rec.request.system, 'sys');
    assert.equal(files[0], `${rec.hash}.json`, '文件名 = 请求指纹');
  } finally {
    close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('★回放命中：不发任何请求，且**不需要 LLM_API_KEY**（离线确定性）', async () => {
  const dir = await tmp();
  const [base, count, close] = await fakeLLM('录下来的回答');
  try {
    await withEnv({
      LLM_BASE_URL: base, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
      NOVEL_LLM_RECORD_DIR: dir,
    }, async () => { await callLLM(BUNDLE); });
    assert.equal(count(), 1, '录像阶段真调了一次');

    await withEnv({
      LLM_BASE_URL: undefined, LLM_API_KEY: undefined, LLM_MODEL: 'm',
      NOVEL_LLM_RECORD_DIR: undefined, NOVEL_LLM_REPLAY_DIR: dir,
    }, async () => {
      const r = await callLLM(BUNDLE);
      assert.equal(r.ok, true, '没有 API key 也必须能回放——否则不叫离线');
      assert.equal(r.ok === true ? r.text : '', '录下来的回答');
    });
    assert.equal(count(), 1, '★回放不该产生任何网络请求');
  } finally {
    close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('★回放未命中 → 失败关闭，**绝不回退到真调模型**', async () => {
  const dir = await tmp();
  const [base, count, close] = await fakeLLM('不该被调用');
  try {
    await withEnv({
      // 故意把真端点配好：若实现「未命中就回退」，这里会悄悄成功并烧钱
      LLM_BASE_URL: base, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
      NOVEL_LLM_REPLAY_DIR: dir,
    }, async () => {
      const r = await callLLM(BUNDLE);
      assert.equal(r.ok, false);
      assert.equal(r.ok === false ? r.kind : '', 'config');
      assert.match(r.ok === false ? r.detail : '', /回放未命中/);
      assert.match(r.ok === false ? r.detail : '', /不会\*\*回退到真调模型/, '错误信息要明说这条纪律');
    });
    assert.equal(count(), 0, '★未命中时一次网络请求都不许发——回退会把「夹具过期」伪装成「测试通过」');
  } finally {
    close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('★回放按**请求指纹**取：prompt 或 model 变了就取不到（夹具过期必须暴露）', async () => {
  const dir = await tmp();
  const [base, , close] = await fakeLLM('原回答');
  try {
    await withEnv({
      LLM_BASE_URL: base, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
      NOVEL_LLM_RECORD_DIR: dir,
    }, async () => { await callLLM(BUNDLE); });

    // 同一份 prompt + 同一个 model → 命中
    await withEnv({ LLM_MODEL: 'm', NOVEL_LLM_REPLAY_DIR: dir }, async () => {
      assert.equal((await callLLM(BUNDLE)).ok, true);
    });
    // prompt 改了 → 取不到
    await withEnv({ LLM_MODEL: 'm', NOVEL_LLM_REPLAY_DIR: dir }, async () => {
      const r = await callLLM({ ...BUNDLE, user: 'usr 改了' });
      assert.equal(r.ok, false, 'prompt 变了就不该命中——否则测试会在错误的夹具上「通过」');
    });
    // model 改了 → 取不到
    await withEnv({ LLM_MODEL: 'm2', NOVEL_LLM_REPLAY_DIR: dir }, async () => {
      assert.equal((await callLLM(BUNDLE)).ok, false, 'model 变了同样不该命中');
    });
  } finally {
    close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('指纹就是 contentHash(system+user+model)，可独立复算（夹具可人工核对）', () => {
  const h = contentHash('m\n\u0000\nsys\n\u0000\nusr');
  assert.equal(h.length, 16, '与 gateStatus 用同一套指纹口径');
});

// ── B-31 附带发现：numEnv 的 `?? ''` 把「未设置」当成 0 ──────────────────────
// 真书抽取实测抓到：熔断 1 次就开（阈值应为 3）、0s 冷却（应为 60s）。
// 根因是 `Number(env ?? '')`——env 未设置时空串被 Number 成 0，文档默认值从未生效。
// 本文件下面的用例之所以没暴露，是因为全都显式设了 RETRY_ATTEMPTS:'0'——
// **所有测试都绕过默认路径，默认路径就成了没有测试的荒地**。

test('★重试默认 1 次：env 未设置时文档值生效，而不是 0', async () => {
  let requests = 0;
  const srv = createServer((_req, res) => {
    requests += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await withEnv({ LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm' }, async () => {
      const r = await callLLM(BUNDLE, { temperature: 0.2 });
      assert.equal(r.ok, false);
      // ★1 次初始 + 1 次重试 = 2 次请求。旧 bug 下是 1（默认被当成 0，从不重试）
      assert.equal(requests, 2, `env 未设置时应按默认重试 1 次（共 2 次请求），实际 ${requests}`);
    });
  } finally {
    srv.close();
  }
});

test('★熔断默认阈值 3：env 未设置时第 3 次连续失败才开，冷却 60s', async () => {
  let requests = 0;
  const srv = createServer((_req, res) => {
    requests += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await withEnv({ LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm' }, async () => {
      // 每次调用 = 1 初始 + 1 重试 = 2 请求；3 次调用共 6 请求后熔断开
      for (let i = 0; i < 3; i++) await callLLM(BUNDLE, { temperature: 0.2 });
      assert.ok(requests >= 6, `三次失败应各含重试（至少 6 请求），实际 ${requests}`);
      const r4 = await callLLM(BUNDLE, { temperature: 0.2 });
      assert.equal(r4.ok, false);
      assert.equal(r4.ok === false && 'kind' in r4 ? r4.kind : '', 'circuit-open', '第 4 次应被熔断拦截');
    });
  } finally {
    srv.close();
  }
});
