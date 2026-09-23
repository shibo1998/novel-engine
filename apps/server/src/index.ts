import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  applyGateResult,
  buildPrompt,
  readState,
  runGates,
  writeChapter,
  writeState,
} from '@novel/core';
import type { GateFinding } from '@novel/core';

const PORT = Number(process.env['NOVEL_SERVER_PORT'] ?? 4319);

/** 薄服务：node:http 零依赖。无状态——每次请求从 bookRoot 现读，不缓存任何东西。 */

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf-8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('请求体必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function requireBookRoot(v: unknown): string {
  if (typeof v !== 'string' || v === '') throw new Error('bookRoot 缺失或不是非空字符串');
  return v;
}

function requireChapterNo(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error('chapterNo 缺失或不是正整数');
  return n;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/state') {
      const bookRoot = requireBookRoot(url.searchParams.get('bookRoot'));
      send(res, 200, await readState({ bookRoot }));
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const bookRoot = requireBookRoot(body['bookRoot']);

      if (url.pathname === '/prompt') {
        const bundle = await buildPrompt({
          bookRoot,
          chapterNo: requireChapterNo(body['chapterNo']),
          mode: body['mode'] === 'revise' ? 'revise' : 'draft',
          ...(Array.isArray(body['findings']) ? { findings: body['findings'] as GateFinding[] } : {}),
        });
        send(res, 200, bundle);
        return;
      }

      if (url.pathname === '/write') {
        send(res, 200, await writeChapter({ bookRoot, chapterNo: requireChapterNo(body['chapterNo']) }));
        return;
      }

      if (url.pathname === '/gates') {
        const result = await runGates({ bookRoot });
        if (body['write'] === true) {
          const state = await readState({ bookRoot });
          await applyGateResult(state, result);
          await writeState(state);
          send(res, 200, state);
          return;
        }
        send(res, 200, result);
        return;
      }
    }

    send(res, 404, { error: `未知端点: ${req.method} ${url.pathname}` });
  } catch (e) {
    send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => {
  // 人读日志一律走 stderr，与 CLI 同一契约
  process.stderr.write(`novel-server listening on 127.0.0.1:${PORT}\n`);
});
