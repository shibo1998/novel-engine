import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyGateResult,
  auditRules,
  buildPrompt,
  checkChapterReadiness,
  convergeChapter,
  recordFeedback,
  readState,
  runGates,
  saveChapterText,
  updateChapterSummary,
  writeChapter,
  writeState,
} from '@novel/core';
import type { ChapterReadiness, GateFinding } from '@novel/core';

const PORT = Number(process.env['NOVEL_SERVER_PORT'] ?? 4319);

/**
 * 绑定地址：默认只回环。
 * 必须显式传 host —— 旧版 `server.listen(PORT, cb)` 不传 host 时 Node 听**所有网卡**，
 * 而日志却写着 127.0.0.1：「日志说一套、实际听另一套」正是「以为只有本机能连」的全部来源。
 * 需要局域网访问请显式设 NOVEL_SERVER_HOST，日志会照实打印并告警。
 */
const HOST = process.env['NOVEL_SERVER_HOST'] ?? '127.0.0.1';
const IS_LOOPBACK = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';

/** 可读根边界：设了则所有 bookRoot 必须落在其内；未设则只放宽可读面（写操作另行要求）。 */
const ALLOWED_ROOT = process.env['NOVEL_ALLOWED_ROOT'] ?? '';

/** 写盘总开关：默认关。要开需同时给出 NOVEL_ALLOWED_ROOT（见 requireWriteEnabled）。 */
const WRITE_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  (process.env['NOVEL_ALLOW_WRITE'] ?? '').toLowerCase(),
);

/**
 * 鉴权 token：优先 NOVEL_SERVER_TOKEN，缺省则每次启动随机生成。
 * 旧版所有路由无认证 + 绑所有网卡，等于「同一 WiFi 下任何人可读写任意路径」。
 */
const CONFIGURED_TOKEN = process.env['NOVEL_SERVER_TOKEN'] ?? '';
const ACTIVE_TOKEN = CONFIGURED_TOKEN === '' ? randomBytes(32).toString('hex') : CONFIGURED_TOKEN;

/** 薄服务：node:http 零依赖。无状态——每次请求从 bookRoot 现读，不缓存任何东西。 */

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 带 HTTP 状态码的错误：让兜底 catch 能区分 400/401/403，而不是一律 500 把鉴权失败也说成服务端故障。 */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new HttpError(400, '请求体必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  // 长度不等直接失败：timingSafeEqual 要求等长，而长度本身不构成秘密
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function authorize(req: IncomingMessage): void {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (presented === '' || !safeEqual(presented, ACTIVE_TOKEN)) {
    throw new HttpError(401, '未授权：请求须带 Authorization: Bearer <token>（token 见服务端启动日志）');
  }
}

/**
 * bookRoot 归一 + 边界校验，返回**归一后的绝对路径**，下游一律用它。
 * core 的 readState/writeState 内部各自 resolve；服务端入口先归一，
 * 免得同一个仓里「有的入口归一、有的入口不归一」两套标准（F12 同源问题）。
 */
function resolveBookRoot(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, 'bookRoot 缺失或不是非空字符串');
  const resolved = path.resolve(v);
  if (ALLOWED_ROOT !== '') {
    const allowed = path.resolve(ALLOWED_ROOT);
    const rel = path.relative(allowed, resolved);
    // rel==='' 即自身；以 .. 开头或落成绝对路径都算越界。
    // 不能用字符串前缀比较：/bk 会「包含」/bk-evil 这种同前缀旁支。
    if (rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
      throw new HttpError(403, `bookRoot 越界：${resolved} 不在允许根 ${allowed} 之内`);
    }
  }
  return resolved;
}

/**
 * 写盘路由的统一闸门。两把锁互相独立：
 * NOVEL_ALLOW_WRITE 是总开关，NOVEL_ALLOWED_ROOT 是「能写到哪儿」——
 * 只开总开关不给边界，等于「可写」还是任意路径可写。
 */
function requireWriteEnabled(): void {
  if (!WRITE_ENABLED) {
    throw new HttpError(403, '写盘类操作已禁用：需显式设置 NOVEL_ALLOW_WRITE=1');
  }
  if (ALLOWED_ROOT === '') {
    throw new HttpError(403, '写盘类操作要求同时配置 NOVEL_ALLOWED_ROOT（否则「可写」等于任意路径可写）');
  }
}

/** 会改盘的路由清单。集中判定而非散落在各 handler 里，新增路由时漏判能在评审时一眼看见。 */
const WRITE_PATHNAMES: ReadonlySet<string> = new Set(['/write', '/generate', '/summarize', '/feedback']);

function isWriteRequest(method: string, pathname: string, body: Record<string, unknown>): boolean {
  if (method === 'PUT' && pathname === '/chapter') return true;
  if (method === 'POST' && WRITE_PATHNAMES.has(pathname)) return true;
  // /gates 自身只读，但 write:true 会把结果回填落盘
  if (method === 'POST' && pathname === '/gates' && body['write'] === true) return true;
  return false;
}

function requireChapterNo(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error('chapterNo 缺失或不是正整数');
  return n;
}

function requireText(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new Error(`${field} 缺失或不是字符串`);
  return v;
}

function publicReadiness(report: ChapterReadiness): Omit<ChapterReadiness, 'outlineText'> {
  return { chapterNo: report.chapterNo, outlineFile: report.outlineFile, warnings: report.warnings };
}

const server = createServer(async (req, res) => {
  try {
    // 鉴权先于一切路由：401 不泄露「这个端点存不存在」
    authorize(req);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/state') {
      const bookRoot = resolveBookRoot(url.searchParams.get('bookRoot'));
      send(res, 200, await readState({ bookRoot }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/chapter') {
      const bookRoot = resolveBookRoot(url.searchParams.get('bookRoot'));
      const file = url.searchParams.get('file');
      if (typeof file !== 'string' || !/^[\w.-]+\.md$/.test(file)) throw new Error('file 缺失或不是合法 md 文件名');
      const text = await readFile(path.join(path.resolve(bookRoot), 'chapters', file), 'utf-8');
      send(res, 200, { file, text });
      return;
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = await readJsonBody(req);
      const bookRoot = resolveBookRoot(body['bookRoot']);
      // 写盘类路由统一在此拦下（含 /gates?write=true 这种「看着像读」的）
      if (isWriteRequest(req.method, url.pathname, body)) requireWriteEnabled();

      if (req.method === 'PUT' && url.pathname === '/chapter') {
        const chapterNo = requireChapterNo(body['chapterNo']);
        const text = requireText(body['text'], 'text');
        send(res, 200, await saveChapterText({ bookRoot, chapterNo, text }));
        return;
      }

      if (url.pathname === '/preflight') {
        send(res, 200, publicReadiness(await checkChapterReadiness(bookRoot, requireChapterNo(body['chapterNo']))));
        return;
      }

      if (url.pathname === '/summarize') {
        send(res, 200, await updateChapterSummary(bookRoot, requireChapterNo(body['chapterNo'])));
        return;
      }

      if (url.pathname === '/rules/audit') {
        send(res, 200, await auditRules(bookRoot));
        return;
      }

      if (url.pathname === '/feedback') {
        const chapterNo = requireChapterNo(body['chapterNo']);
        const originalText = requireText(body['originalText'], 'originalText');
        const revisedText = requireText(body['revisedText'], 'revisedText');
        const state = await readState({ bookRoot });
        const chapter = state.chapters.find((entry) => entry.chapterNo === chapterNo);
        if (chapter === undefined) throw new Error(`第 ${chapterNo} 章不存在`);
        const current = await readFile(path.join(path.resolve(bookRoot), 'chapters', chapter.file), 'utf-8');
        if (current !== revisedText) throw new Error('记录反馈前正文已变化，请先保存当前版本');
        send(res, 200, await recordFeedback({
          bookRoot,
          chapterNo,
          originalText,
          revisedText,
          ...(Array.isArray(body['findings']) ? { findings: body['findings'] as GateFinding[] } : {}),
        }));
        return;
      }

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

      if (url.pathname === '/generate') {
        const chapterNo = requireChapterNo(body['chapterNo']);
        const readiness = await checkChapterReadiness(bookRoot, chapterNo);
        const generation = await convergeChapter({ bookRoot, chapterNo });
        const result = await runGates({ bookRoot });
        const state = await readState({ bookRoot });
        await applyGateResult(state, result);
        await writeState(state);
        send(res, 200, { ...result, state, generation, readiness: publicReadiness(readiness) });
        return;
      }

      if (url.pathname === '/gates') {
        const result = await runGates({ bookRoot });
        if (body['write'] === true) {
          const state = await readState({ bookRoot });
          await applyGateResult(state, result);
          await writeState(state);
          send(res, 200, { ...result, state });
          return;
        }
        send(res, 200, result);
        return;
      }
    }

    send(res, 404, { error: `未知端点: ${req.method} ${url.pathname}` });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    send(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.on('error', (e: NodeJS.ErrnoException) => {
  // 绑特定 host 之后，端口占用/地址不可用都会走到这里；不接这个事件就是一句裸栈
  process.stderr.write(`novel-server 启动失败（${HOST}:${PORT}）：${e.code ?? ''} ${e.message}\n`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  // 人读日志一律走 stderr，与 CLI 同一契约（stdout 留给结构化输出的位置）。
  // 这里回显的 host 就是实际绑定的 host——日志与实际不允许再有第二套说法。
  process.stderr.write(
    [
      `novel-server listening on ${HOST}:${PORT}`,
      IS_LOOPBACK
        ? '  · 绑定：仅回环，非同机不可达（需要局域网访问请显式设 NOVEL_SERVER_HOST）'
        : '  · 绑定：⚠️ 非回环地址，局域网内可达（仅靠 token 保护，仍建议只在可信网络使用）',
      CONFIGURED_TOKEN === ''
        ? '  · 鉴权：本次启动随机生成的 token（重启即失效；用 NOVEL_SERVER_TOKEN 固定）'
        : '  · 鉴权：token 来自 NOVEL_SERVER_TOKEN',
      `  · token: ${ACTIVE_TOKEN}`,
      `  · 可读根：${ALLOWED_ROOT === '' ? '(未限制)' : ALLOWED_ROOT}`,
      `  · 写盘：${WRITE_ENABLED ? '开启' : '关闭（设 NOVEL_ALLOW_WRITE=1 且配 NOVEL_ALLOWED_ROOT 才开）'}`,
    ].join('\n') + '\n',
  );
});
