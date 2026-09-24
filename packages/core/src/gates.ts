import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateFailureKind, GateResult, GateSeverity } from './types.js';

export interface RunGatesOptions {
  bookRoot: string;    // 书根目录绝对路径
  gate?: string;       // 默认 "consistency_check"
  python?: string;     // 默认 NOVEL_PYTHON 环境变量，再回退平台默认
  /** 子进程硬超时（ms）。缺省取 NOVEL_GATE_TIMEOUT_MS，再缺省 DEFAULT_GATE_TIMEOUT_MS。 */
  timeoutMs?: number;
  /**
   * 外部取消（F20-2）。触发时 SIGKILL 子进程并以 kind='aborted' 失败。
   * 存在的理由：前端断开连接**只是断开连接**——server 是无状态的、每次现读，
   * spawn 出去的检查器会继续跑完。要真能停，只能由持有句柄的一侧显式取消。
   */
  signal?: AbortSignal;
}

const SEVERITIES: ReadonlySet<string> = new Set<GateSeverity>(['严重', '中等', '轻微', '提示']);

/**
 * 默认硬超时：2 分钟。
 * 为什么必须有：检查器是 spawn 出来的外部进程，「起来了但卡住」（死循环、等 stdin、
 * 读巨大文件）既不会触发 error 事件，close 也永不到来——旧版全仓只有 llm.ts 有超时，
 * 这条外部调用线完全没有，Promise 会永久 pending（CLI 永不返回、Web 按钮一直转）。
 */
const DEFAULT_GATE_TIMEOUT_MS = 120_000;
/** 发出 SIGKILL 之后再等这么久；close 若因平台原因不来，也必须把 Promise 结算掉。 */
const KILL_GRACE_MS = 5_000;

function resolveTimeoutMs(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromEnv = Number(process.env['NOVEL_GATE_TIMEOUT_MS'] ?? '');
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_GATE_TIMEOUT_MS;
}

/** gate 失败：带分类抛错，调用方可按 kind 分流（如超时≠脚本缺失）。 */
export class GateFailureError extends Error {
  constructor(readonly kind: GateFailureKind, message: string) {
    super(message);
    this.name = 'GateFailureError';
  }
}

/**
 * 子进程结果。**失败也走 resolve、不走 reject**——分类是正常返回值的一部分，
 * 「超时」和「启动失败」用异常形状表达，会逼调用方 catch 一切、并且必然漏掉一种。
 * 形状刻意与 types.ts 的 LLMError 一致：{ ok:false, kind }。
 */
type Collected =
  | { ok: true; code: number | null; stdout: string; stderr: string }
  | { ok: false; kind: 'spawn' | 'timeout' | 'aborted'; detail: string; stdout: string; stderr: string };

function collect(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Collected> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (r: Collected): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    // 先发信号再结算：kill 只负责发信号，让 Promise 落地的永远是某个 finish 分支
    const killNow = (): void => {
      child.kill('SIGKILL');
      const grace = setTimeout(() => {
        finish({
          ok: false,
          kind: aborted ? 'aborted' : 'timeout',
          detail: `SIGKILL 后 ${KILL_GRACE_MS}ms 仍未收到 close`,
          stdout,
          stderr,
        });
      }, KILL_GRACE_MS);
      grace.unref();
    };

    function onAbort(): void {
      aborted = true;
      killNow();
    }

    timer = setTimeout(() => {
      timedOut = true;
      killNow();
    }, timeoutMs);

    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    // error 兜的是「进程根本没起来」；起来了再卡住只能靠上面的超时兜
    child.on('error', (e) => finish({ ok: false, kind: 'spawn', detail: e.message, stdout, stderr }));
    child.on('close', (code) => {
      // 取消优先于超时：两个都可能为真，但「是被人按停的」比「是自己慢」更该被报出来
      if (aborted) {
        finish({ ok: false, kind: 'aborted', detail: '已被取消（SIGKILL）', stdout, stderr });
        return;
      }
      if (timedOut) {
        finish({ ok: false, kind: 'timeout', detail: `超过 ${timeoutMs}ms 未结束，已 SIGKILL`, stdout, stderr });
        return;
      }
      finish({ ok: true, code, stdout, stderr });
    });
  });
}

/**
 * 取 stderr 的前几行非空内容。
 * 为什么不能只用首行：检查器的**配置校验错误是把缺项逐行列出来的**
 * （book.title 缺失 / paths 段缺失 / chapter.file_regex 缺失 …），
 * 只回显首行恰好把「哪个键写错了」截掉——那正是读日志的人唯一想要的信息。
 */
function headLines(text: string, limit = 6): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.slice(0, limit).join('\n    ');
}

function shapeError(field: string, raw: string): Error {
  return new GateFailureError('shape', `gate 输出 shape 不符：字段 ${field}；stdout 前 200 字符：${raw.slice(0, 200)}`);
}

function assertGateResult(value: unknown, raw: string): GateResult {
  if (typeof value !== 'object' || value === null) throw shapeError('(root)', raw);
  const v = value as Record<string, unknown>;
  if (typeof v['gate'] !== 'string') throw shapeError('gate', raw);
  if (typeof v['book_root'] !== 'string') throw shapeError('book_root', raw);
  if (typeof v['chapter_count'] !== 'number') throw shapeError('chapter_count', raw);
  if (typeof v['counts'] !== 'object' || v['counts'] === null) throw shapeError('counts', raw);
  for (const [k, val] of Object.entries(v['counts'] as Record<string, unknown>)) {
    if (typeof val !== 'number') throw shapeError(`counts.${k}`, raw);
  }
  if (!Array.isArray(v['findings'])) throw shapeError('findings', raw);
  for (const f of v['findings'] as unknown[]) {
    if (typeof f !== 'object' || f === null) throw shapeError('findings[]', raw);
    const r = f as Record<string, unknown>;
    if (typeof r['severity'] !== 'string' || !SEVERITIES.has(r['severity'])) throw shapeError('findings[].severity', raw);
    if (typeof r['chapter'] !== 'string') throw shapeError('findings[].chapter', raw);
    if (typeof r['line'] !== 'number') throw shapeError('findings[].line', raw);
    if (typeof r['check'] !== 'string') throw shapeError('findings[].check', raw);
    if (typeof r['detail'] !== 'string') throw shapeError('findings[].detail', raw);
  }
  return v as unknown as GateResult;
}

export async function runGates(opts: RunGatesOptions): Promise<GateResult> {
  // Windows 可执行名是 python / py -3，不是 python3；NOVEL_PYTHON 可覆盖
  const py = opts.python ?? process.env['NOVEL_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');
  const gate = opts.gate ?? 'consistency_check';
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  // 书根先归一 + 必须是目录：态度照抄 readState（同样 resolve + isDirectory），
  // 不让同一个仓里出现「core 一条路一种标准、spawn 这条路另一种标准」。
  // 不校验的后果正是 F12 假绿链的起点：--root 打错一层照样 spawn 成功，
  // 检查器扫到 0 章、findings 为空、exit 0，上层拿到空数组就把所有章刷成 clean。
  const bookRoot = path.resolve(opts.bookRoot);
  let rootStat: Stats | null = null;
  try {
    rootStat = statSync(bookRoot);
  } catch {
    rootStat = null;
  }
  if (rootStat === null || !rootStat.isDirectory()) {
    throw new GateFailureError(
      'root',
      `bookRoot 不是目录（--root 打错一层？）：${bookRoot}\n  原始入参：${opts.bookRoot}`,
    );
  }
  // 路径层级钉注：本文件编译产物位于 packages/core/dist/，new URL 上溯三级 = 仓库根。
  // 若修改 tsconfig 的 outDir 或包目录深度，必须同步此处，否则会静默指到错误位置。
  const gatePath = fileURLToPath(new URL(`../../../gates/${gate}.py`, import.meta.url));
  // 上溯相对深度一旦失配，spawn 只会报「子进程启动失败」，排查时根本想不到是路径。
  // 所以在这里就把解析结果和解析基准一起摊开——错误信息本身要能定位问题。
  if (!existsSync(gatePath)) {
    throw new GateFailureError(
      'spawn',
      `gate 脚本不存在：${gatePath}\n` +
        `解析基准：${import.meta.url}\n` +
        `上溯相对深度：../../../gates/${gate}.py\n` +
        `若改过 tsconfig 的 outDir 或包目录深度，请同步校正相对深度。`,
    );
  }
  // 检查器书根只认 --root 开关；位置参数会被当成章节白名单（实测：exit 2）
  const child = spawn(py, [gatePath, '--root', bookRoot], {
    // 不加 PYTHONIOENCODING=utf-8，findings 里的中文在 Windows 上会变 gbk 乱码
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
  });

  const collected = await collect(child, timeoutMs, opts.signal);
  if (!collected.ok && collected.kind === 'aborted') {
    throw new GateFailureError(
      'aborted',
      `gate 执行已取消：${gate} @ ${opts.bookRoot}\n`
        + `  子进程已 SIGKILL。★本次检查**未产出结果**——上层不得把它当成「查了没问题」（绿）。`,
    );
  }
  if (!collected.ok) {
    const head = collected.kind === 'timeout'
      ? `gate 执行超时（${timeoutMs}ms，已 SIGKILL）`
      : `gate 子进程启动失败（${py}）`;
    throw new GateFailureError(
      collected.kind,
      `${head}：${gate} @ ${opts.bookRoot}\n` +
        `  详情：${collected.detail}\n` +
        `  stderr：\n    ${headLines(collected.stderr) || '(无)'}\n` +
        `  提示：书越长全量扫描越慢——可用 NOVEL_GATE_TIMEOUT_MS 调大超时，或先用 --since 做增量检查。`,
    );
  }

  const { code, stdout, stderr } = collected;
  // 语义钉注：检查器「发现问题也返回 0」，非 0（exit 2）才是执行失败
  if (code !== 0) {
    throw new GateFailureError(
      'exit',
      `gate 执行失败（exit ${code ?? 'signal'}）：\n    ${headLines(stderr) || '(stderr 无内容)'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GateFailureError('parse', `gate 输出不是合法 JSON；stdout 前 200 字符：${stdout.slice(0, 200)}`);
  }
  return assertGateResult(parsed, stdout);
}
