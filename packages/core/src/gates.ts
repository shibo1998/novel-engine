import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GateFailureKind, GateResult, GateSeverity } from './types.js';

export interface RunGatesOptions {
  bookRoot: string;    // 书根目录绝对路径
  gate?: string;       // 默认 "consistency_check"
  python?: string;     // 默认 NOVEL_PYTHON 环境变量，再回退平台默认
  /** 子进程硬超时（ms）。缺省取 NOVEL_GATE_TIMEOUT_MS，再缺省 DEFAULT_GATE_TIMEOUT_MS。 */
  timeoutMs?: number;
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
  | { ok: false; kind: 'spawn' | 'timeout'; detail: string; stdout: string; stderr: string };

function collect(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<Collected> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (r: Collected): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(r);
    };

    timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL：不留「让它自己退」的余地。注意 kill 只负责发信号，
      // 真正让 Promise 落地的是下面任何一个 finish 分支——只 kill 不 resolve 等于没修。
      child.kill('SIGKILL');
      // 兜底：即使 close 因平台原因不触发，也要在宽限期后结算，绝不允许永久 pending
      const grace = setTimeout(() => {
        finish({ ok: false, kind: 'timeout', detail: `SIGKILL 后 ${KILL_GRACE_MS}ms 仍未收到 close`, stdout, stderr });
      }, KILL_GRACE_MS);
      grace.unref();
    }, timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    // error 兜的是「进程根本没起来」；起来了再卡住只能靠上面的超时兜
    child.on('error', (e) => finish({ ok: false, kind: 'spawn', detail: e.message, stdout, stderr }));
    child.on('close', (code) => {
      if (timedOut) {
        finish({ ok: false, kind: 'timeout', detail: `超过 ${timeoutMs}ms 未结束，已 SIGKILL`, stdout, stderr });
        return;
      }
      finish({ ok: true, code, stdout, stderr });
    });
  });
}

function firstLine(text: string): string {
  const [line = ''] = text.split('\n', 1);
  return line.trim();
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
  const child = spawn(py, [gatePath, '--root', opts.bookRoot], {
    // 不加 PYTHONIOENCODING=utf-8，findings 里的中文在 Windows 上会变 gbk 乱码
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
  });

  const collected = await collect(child, timeoutMs);
  if (!collected.ok) {
    const head = collected.kind === 'timeout'
      ? `gate 执行超时（${timeoutMs}ms，已 SIGKILL）`
      : `gate 子进程启动失败（${py}）`;
    throw new GateFailureError(
      collected.kind,
      `${head}：${gate} @ ${opts.bookRoot}\n` +
        `  详情：${collected.detail}\n` +
        `  stderr 首行：${firstLine(collected.stderr) || '(无)'}\n` +
        `  提示：书越长全量扫描越慢——可用 NOVEL_GATE_TIMEOUT_MS 调大超时，或先用 --since 做增量检查。`,
    );
  }

  const { code, stdout, stderr } = collected;
  // 语义钉注：检查器「发现问题也返回 0」，非 0（exit 2）才是执行失败
  if (code !== 0) {
    throw new GateFailureError('exit', `gate 执行失败（exit ${code ?? 'signal'}）：${firstLine(stderr)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GateFailureError('parse', `gate 输出不是合法 JSON；stdout 前 200 字符：${stdout.slice(0, 200)}`);
  }
  return assertGateResult(parsed, stdout);
}
