import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyGateResult,
  assertPlanReady,
  assertStyleReady,
  auditRules,
  buildPrompt,
  checkChapterReadiness,
  checkPlanGate,
  convergeChapter,
  GateFailureError,
  recordFeedback,
  readState,
  runGates,
  runStyleGate,
  saveChapterText,
  snapshotChapterHashes,
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

/**
 * 在跑的长任务登记表（F20-2）。
 * 为什么必须登记：前端断开连接**只是断开连接**——server 无状态、每次现读，
 * spawn 出去的检查器与收敛循环会照跑到底，「前端点取消」纯属幻觉。
 * 要真能停，只能由持有句柄的一侧掐掉，而能够持有句柄的只有 server。
 * 粒度按 bookRoot：同一本书若允许并存两个长任务，「取消」到底取消了谁就说不清了。
 */
interface InflightTask {
  controller: AbortController;
  label: string;
  startedAt: number;
}
const inflight = new Map<string, InflightTask>();

function beginTask(bookRoot: string, label: string): AbortController {
  const existing = inflight.get(bookRoot);
  if (existing !== undefined) {
    throw new HttpError(
      409,
      `该书已有任务在跑：${existing.label}`
        + `（已 ${Math.round((Date.now() - existing.startedAt) / 1000)}s）。先取消它，或等它结束。`,
    );
  }
  const controller = new AbortController();
  inflight.set(bookRoot, { controller, label, startedAt: Date.now() });
  return controller;
}

function endTask(bookRoot: string, controller: AbortController): void {
  if (inflight.get(bookRoot)?.controller === controller) inflight.delete(bookRoot);
}

/**
 * 取消导致的失败**绝不能**长得像正常结果。
 * 这里返回 cancelled:true 且**一个 findings 字段都不带**——
 * 空的 findings 与「查完没问题」在本项目里形状无法区分，正是最要命的那类混淆。
 */
function sendIfCancelled(res: ServerResponse, e: unknown, bookRoot: string): boolean {
  if (e instanceof GateFailureError && e.kind === 'aborted') {
    send(res, 200, {
      cancelled: true,
      bookRoot,
      note: '本请求已被取消，未产出 gate 结果（不要当成「查了没问题」）',
    });
    return true;
  }
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
  // outlineText 不外传（整卷细纲文本，面板用不上、还白传一遍）；
  // 但决定「这是本章细纲还是卷级背景」的两个字段必须传，否则面板无法如实呈现。
  return {
    chapterNo: report.chapterNo,
    outlineFile: report.outlineFile,
    outlineScope: report.outlineScope,
    outlineChapterSectionMissing: report.outlineChapterSectionMissing,
    warnings: report.warnings,
  };
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

    if (req.method === 'GET' && url.pathname === '/tasks') {
      // 只读、只报告在跑的任务。给前端用来区分「我这儿在等」和「服务端确实还在跑」（F20-1）：
      // 少了这个，一次卡死与一次正常长跑在界面上长得一模一样。
      send(res, 200, {
        tasks: [...inflight.entries()].map(([bookRoot, t]) => ({
          bookRoot,
          label: t.label,
          startedAt: new Date(t.startedAt).toISOString(),
          elapsedMs: Date.now() - t.startedAt,
        })),
      });
      return;
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = await readJsonBody(req);
      const bookRoot = resolveBookRoot(body['bookRoot']);
      // 写盘类路由统一在此拦下（含 /gates?write=true 这种「看着像读」的）
      if (isWriteRequest(req.method, url.pathname, body)) requireWriteEnabled();

      if (url.pathname === '/cancel') {
        // 取消是**改服务端内存状态**，不落盘，所以不走写盘闸门
        const target = inflight.get(bookRoot);
        if (target === undefined) {
          send(res, 200, { cancelled: false, note: '该书当前没有在跑的任务' });
          return;
        }
        target.controller.abort();
        send(res, 200, {
          cancelled: true,
          label: target.label,
          note: '已发出取消信号：检查器会被 SIGKILL，收敛循环会在下一个可中断点停下',
        });
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/chapter') {
        const chapterNo = requireChapterNo(body['chapterNo']);
        const text = requireText(body['text'], 'text');
        send(res, 200, await saveChapterText({ bookRoot, chapterNo, text }));
        return;
      }

      if (url.pathname === '/preflight') {
        const chapterNo = requireChapterNo(body['chapterNo']);
        // ★面板的预检必须与 CLI 的 preflight 给出**同一个结论**（B-10 / B-62）。
        // 两道门都接上：若面板说「可以写」而 CLI 拒绝（或反过来），
        // 就正好复刻本仓反复在治的矛盾——检查器说没问题、上层却当问题。
        // 风格闸门抛错时收成显式的「没跑成」，不让它把整个响应冲掉。
        let styleGate: unknown;
        try {
          styleGate = await runStyleGate(bookRoot);
        } catch (e) {
          styleGate = { ready: false, error: e instanceof Error ? e.message : String(e) };
        }
        const [readiness, planGate] = await Promise.all([
          checkChapterReadiness(bookRoot, chapterNo),
          checkPlanGate(bookRoot, chapterNo),
        ]);
        send(res, 200, { ...publicReadiness(readiness), styleGate, planGate });
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
        // 风格/红线层未就绪 → 拒绝起草。面板是「一章一章点」的入口，
        // 与 CLI 的 generate/book 同属「会产生新正文」的动作，必须同一道门。
        // 少挡一处就等于留了一条绕过路径（本仓反复栽在「判据只在一处生效」上）。
        await assertStyleReady(bookRoot);
        // 逐层蓝图闸门（B-10）：与 CLI 的 generate/book 同一道门。少挡一处
        // 就等于留了一条绕过路径——本仓反复栽在「判据只在一处生效」上。
        // 没有 .soloent/plan.json 的书恒为就绪（旧书不被连坐）。
        await assertPlanReady(bookRoot, requireChapterNo(body['chapterNo']));
        send(res, 200, await writeChapter({ bookRoot, chapterNo: requireChapterNo(body['chapterNo']) }));
        return;
      }

      if (url.pathname === '/generate') {
        const chapterNo = requireChapterNo(body['chapterNo']);
        const task = beginTask(bookRoot, `收敛第 ${chapterNo} 章`);
        try {
          await assertStyleReady(bookRoot, { signal: task.signal });
          await assertPlanReady(bookRoot, chapterNo);
          const readiness = await checkChapterReadiness(bookRoot, chapterNo);
          const generation = await convergeChapter({ bookRoot, chapterNo, signal: task.signal });
          // ★顺序不能换（F17）：读 state → 取**跑前** mtime 快照 → 跑 gate → 回填
          const state = await readState({ bookRoot, skipStaleSweep: true });
          const hashSnapshot = await snapshotChapterHashes(bookRoot, state.chapters);
          const result = await runGates({ bookRoot, signal: task.signal });
          await applyGateResult(state, result, { hashSnapshot });
          await writeState(state);
          send(res, 200, { ...result, state, generation, readiness: publicReadiness(readiness) });
        } catch (e) {
          if (sendIfCancelled(res, e, bookRoot)) return;
          throw e;
        } finally {
          endTask(bookRoot, task);
        }
        return;
      }

      if (url.pathname === '/gates') {
        // /gates 两种模式都会 spawn 检查器（都很慢），统一登记成可取消任务；
        // 只读预览也登记——否则「取消」按钮对它按不动。
        const task = beginTask(bookRoot, body['write'] === true ? '过闸并回填' : '过闸（只读）');
        try {
          if (body['write'] === true) {
            // ★顺序不能换（F17）：读 state → 取**跑前** mtime 快照 → 跑 gate → 回填
            const state = await readState({ bookRoot, skipStaleSweep: true });
            const hashSnapshot = await snapshotChapterHashes(bookRoot, state.chapters);
            const result = await runGates({ bookRoot, signal: task.signal });
            await applyGateResult(state, result, { hashSnapshot });
            await writeState(state);
            send(res, 200, { ...result, state });
            return;
          }
          send(res, 200, await runGates({ bookRoot, signal: task.signal }));
        } catch (e) {
          if (sendIfCancelled(res, e, bookRoot)) return;
          throw e;
        } finally {
          endTask(bookRoot, task);
        }
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
