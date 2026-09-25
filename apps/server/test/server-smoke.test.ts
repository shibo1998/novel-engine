import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * server 路由冒烟（B-44）。
 *
 * 补的是这一类洞：**路由接线只被手工 curl 验过，没固化成测试**。
 * 手工验过就删掉探针，等于把「/run 返回 202」「/edit 拒写 gateStatus」
 * 这些不变量交给注释去守——一次重构就能悄悄退回去，而且退回时不会有红灯。
 *
 * 一律起真子进程跑 `dist/index.js`，断言只看 HTTP 状态码 + 响应体。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'dist', 'index.js');
const TOKEN = 'test-token-b44';

/** 找一个空闲端口（写死端口会在并行跑测试时偶发占用） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface Harness {
  port: number;
  bookRoot: string;
  stop: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const parent = await mkdtemp(path.join(tmpdir(), 'novel-srv-'));
  const bookRoot = path.join(parent, '书');
  await mkdir(path.join(bookRoot, '.soloent'), { recursive: true });
  await mkdir(path.join(bookRoot, 'chapters'), { recursive: true });
  await writeFile(path.join(bookRoot, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '服务测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  await writeFile(path.join(bookRoot, 'chapters', 'ch-01.md'), '# 第1章\n\n他推开门。\n', 'utf-8');

  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    windowsHide: true,
    env: {
      ...process.env,
      NOVEL_SERVER_PORT: String(port),
      NOVEL_SERVER_TOKEN: TOKEN,
      NOVEL_ALLOW_WRITE: '1',
      NOVEL_ALLOWED_ROOT: parent,
    },
  });
  let log = '';
  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (d: string) => { log += d; });
  child.stderr?.on('data', (d: string) => { log += d; });

  // 等服务起来（轮询 /tasks，最多 15s）
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server 没起来：\n${log}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/tasks`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (r.ok) break;
    } catch {
      // 还没监听
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    port, bookRoot,
    stop: async (): Promise<void> => {
      child.kill('SIGKILL');
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const post = (h: Harness, p: string, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${h.port}${p}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('★B-44：POST /run 立即返回 202 + runId（不是等跑完）', async () => {
  const h = await startServer();
  try {
    const r = await post(h, '/run', { bookRoot: h.bookRoot, chapterNo: 1 });
    assert.equal(r.status, 202, '★202 = 已受理，不是 200 = 已完成');
    const j = await r.json() as { runId: string; mode: string; eventsUrl: string };
    assert.match(j.runId, /^run-[0-9a-f]{12}$/);
    assert.equal(j.mode, 'converge');
    assert.ok(j.eventsUrl.includes('/events'), '要告诉客户端进度去哪儿看');

    // /tasks 要能把 runId 对上（否则客户端认不出「这就是我起的那个」）
    const tasks = await (await fetch(`http://127.0.0.1:${h.port}/tasks`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as { tasks: { runId: string | null }[] };
    assert.ok(tasks.tasks.some((t) => t.runId === j.runId));
  } finally {
    await h.stop();
  }
});

test('★B-44：GET /events 支持 Last-Event-ID 补发，且闸门失败通过事件流如实报', async () => {
  const h = await startServer();
  try {
    await post(h, '/run', { bookRoot: h.bookRoot, chapterNo: 1 });
    // 等任务跑完（这本书风格层没填 → 会失败，但失败也必须以事件形式到达）
    await new Promise((r) => setTimeout(r, 2500));

    const res = await fetch(
      `http://127.0.0.1:${h.port}/events?bookRoot=${encodeURIComponent(h.bookRoot)}&lastEventId=0`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = res.body?.getReader();
    assert.notEqual(reader, undefined);
    let text = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !text.includes('"kind":"failed"')) {
      const { value, done } = await reader!.read() as { value?: Uint8Array; done: boolean };
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader!.cancel();

    assert.match(text, /^id: 1\n/, '补发要带 SSE 的 id 行（客户端靠它续传）');
    assert.match(text, /"kind":"started"/);
    assert.match(text, /"kind":"failed"/, '★闸门失败要以事件形式如实到达，不是静默');
    assert.match(text, /风格\/红线层未就绪/, '失败原因要能看见——那正是「/run 补了前置闸门」的证据');
  } finally {
    await h.stop();
  }
});

test('★B-44：POST /edit 是统一写入口，**拒绝写结论字段**', async () => {
  const h = await startServer();
  try {
    // 写 gateStatus → 400（「不经检查就能写出绿」的绕过路径必须堵死）
    const bad = await post(h, '/edit', {
      bookRoot: h.bookRoot, chapterNo: 1, text: 'x', gateStatus: { worst: 'clean' },
    });
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(await bad.json()), /拒绝写入 gateStatus/);

    // 写 needsReview → 400（它也是结论）
    const bad2 = await post(h, '/edit', { bookRoot: h.bookRoot, chapterNo: 1, text: 'x', needsReview: false });
    assert.equal(bad2.status, 400);

    // 正常写 → 200
    const ok = await post(h, '/edit', {
      bookRoot: h.bookRoot, chapterNo: 1, text: '# 第1章\n\n他推开门，风灌进来。\n',
    });
    assert.equal(ok.status, 200, await ok.text());
  } finally {
    await h.stop();
  }
});

test('★B-44：POST /steer 对已结束的 run **如实说没投递**，不假装成功', async () => {
  const h = await startServer();
  try {
    const started = await (await post(h, '/run', { bookRoot: h.bookRoot, chapterNo: 1 })).json() as { runId: string };
    await new Promise((r) => setTimeout(r, 2500)); // 等它失败结束

    const r = await post(h, '/steer', { bookRoot: h.bookRoot, runId: started.runId, instruction: '改冷一点' });
    assert.equal(r.status, 200);
    const j = await r.json() as { delivered: boolean; consumed: boolean; note: string };
    assert.equal(j.delivered, false, '★run 已结束 → 没投递，不许报 delivered:true');
    assert.match(j.note, /已结束/);

    // 未知 runId → 404
    const unknown = await post(h, '/steer', { bookRoot: h.bookRoot, runId: 'run-不存在', instruction: 'x' });
    assert.equal(unknown.status, 404);
  } finally {
    await h.stop();
  }
});

test('★B-44：无 token 一律 401（事件流也不例外）', async () => {
  const h = await startServer();
  try {
    const noAuth = await fetch(`http://127.0.0.1:${h.port}/events?bookRoot=${encodeURIComponent(h.bookRoot)}`);
    assert.equal(noAuth.status, 401, '★SSE 也要鉴权——把 token 放查询串会让它进访问日志，所以只认请求头');
  } finally {
    await h.stop();
  }
});
