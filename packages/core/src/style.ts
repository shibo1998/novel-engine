import { GateFailureError, runGates } from './gates.js';
import type { GateFinding, GateSeverity } from './types.js';

/**
 * 风格/红线层前置闸门（写正文之前）。
 *
 * 检查器：`gates/style_doc_check.py`（只读）。它把 `kit.style_doc_issues` /
 * `kit.style_gate_ready` 接进 gates 契约——那套判据在迁仓前就写好了，
 * 却**一个调用者都没有**（死代码），于是「有守卫」与「没守卫」在行为上完全一样。
 * 本模块负责把它接到真正会发生生成动作的入口上。
 *
 * ★为什么不在这里用 TS 重写一份判据：
 * 判据本体是「占位符词表 + 与模板逐字节比对 + 三份文件的路径约定」，
 * 在 Python 侧已经实现且被 `--list-checks` 与模板路径共用。
 * 在 TS 再写一份 = 同一判据两个副本，必然漂移——本项目已为此吃过多次亏
 * （「禁止同脚本重复副本」是项目 MEMORY 里的既有裁决）。
 * 所以这里只做**调用与判定**，不做判据。
 */
export const STYLE_GATE = 'style_doc_check';

export interface StyleGateReport {
  /** 三份风格/红线文件是否「存在且填过」。判据只有一条：检查器一条 finding 都没报。 */
  ready: boolean;
  counts: Partial<Record<GateSeverity, number>>;
  findings: GateFinding[];
  /** 未就绪项的人类可读说明，可直接展示给作者（形如「路径：原因」） */
  blocking: string[];
}

/**
 * 就绪判据的**唯一来源**是检查器自己（`ready` 字段）。
 * 这里额外做一次交叉校验：TS 侧独立算一遍「无 finding」，与检查器给的 ready 对不上就报错。
 *
 * 为什么要多这一步：`ready` 与 `findings` 是同一次运行的两种表述，
 * 一旦哪天检查器改了聚合口径而 TS 侧仍按老规矩算，就会出现
 * 「报告说就绪、列表明明有阻断项」这类自相矛盾——本仓已多次栽在这上面
 * （检查器说「只是提示」、收敛循环却当拦截，导致每章停在 max-rounds）。
 * 宁可当场抛错，也不要让两个口径各自活下去。
 */
function assertReadyConsistent(payload: unknown, findings: GateFinding[], payloadPreview: string): boolean {
  const ready = (payload as { ready?: unknown }).ready;
  if (typeof ready !== 'boolean') {
    throw new GateFailureError('shape', `style gate 输出缺 ready 字段；payload 前 200 字符：${payloadPreview.slice(0, 200)}`);
  }
  if (ready !== (findings.length === 0)) {
    throw new GateFailureError(
      'shape',
      `style gate 自相矛盾：ready=${ready}，但 findings 有 ${findings.length} 条。\n`
        + '  两处口径必须一致（就绪 ⟺ 无 finding），否则「就绪」会变成一句无法核对的话。',
    );
  }
  return ready;
}

export interface RunStyleGateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  python?: string;
}

/** 跑风格闸门。只读，不改任何文件。 */
export async function runStyleGate(
  bookRoot: string,
  opts: RunStyleGateOptions = {},
): Promise<StyleGateReport> {
  const result = await runGates({
    bookRoot,
    gate: STYLE_GATE,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.python !== undefined ? { python: opts.python } : {}),
  });
  const ready = assertReadyConsistent(result, result.findings, JSON.stringify(result));
  const blocking = result.findings.map((f) => `${f.check.replace(/^\[[^\]]+\]\s*/, '')}：${f.detail}`);
  return { ready, counts: result.counts, findings: result.findings, blocking };
}

/** 风格层未就绪：**故意**不继承普通 Error 的语义——调用方据此区分「配置没填好」与「程序出错」。 */
export class StyleNotReadyError extends Error {
  constructor(readonly report: StyleGateReport) {
    super(
      '风格/红线层未就绪，已拒绝开始生成。\n'
        + report.blocking.map((b) => `  · ${b}`).join('\n')
        + '\n  处理完这三份文件再重试（它们决定文风、红线与开书边界）：\n'
        + '    .soloent/rules/story-style.md\n'
        + '    .soloent/constitution/MASTER.md\n'
        + '    1-边界/预期.md\n'
        + '  随时查看状态：novel preflight --book <书目录> --chapter 1',
    );
    this.name = 'StyleNotReadyError';
  }
}

/**
 * 断言风格层就绪；不就绪则抛 StyleNotReadyError。
 *
 * 用途：所有**会产生新正文**的入口在动手之前调用它。
 * 为什么必须有这道门：这三份文件空着时，模型只能按自己的默认审美写，
 * 结果就是三章共用一个套路、句子流水账——本项目要解决的核心痛点。
 * 而旧链路上「配置空着」与「配置齐全」在行为上没有任何区别。
 */
export async function assertStyleReady(
  bookRoot: string,
  opts: RunStyleGateOptions = {},
): Promise<StyleGateReport> {
  const report = await runStyleGate(bookRoot, opts);
  if (!report.ready) throw new StyleNotReadyError(report);
  return report;
}
