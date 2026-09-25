import { randomBytes } from 'node:crypto';

/**
 * 长任务的事件流（B-44 / v0.2 M17）。
 *
 * 治的是什么：`POST /generate` 是**同步**跑的——一次收敛要几十秒到几分钟，
 * HTTP 连接就那么挂着，中间什么也看不见，客户端超时了就断，
 * 而服务端的任务照样跑完（断开 ≠ 停止）。
 *
 * ★三条纪律：
 *
 * 1. **`POST /run` 立即返回 `202 {runId}`**，任务在后台跑，进度走 `GET /events`。
 *    为什么不是「返回结果时一起给事件」：那就又回到同步了。
 *
 * 2. **`Last-Event-ID` 补发，但补不到就明说**。
 *    事件缓冲是**有界环形**（默认 1000 条），服务重启后更早的也没了。
 *    请求的 id 早于缓冲里最老的一条时，返回 `gap: true` 并给出 `oldest` ——
 *    **不许假装补发成功**：那会让客户端以为「中间没发生什么」，
 *    而真相是「中间发生的事已经不在缓冲里了」。
 *    这与本项目一贯的「查不到 ≠ 没问题」是同一条。
 *
 * 3. **事件只追加、不改写**（与 journal 同款）：SSE 的 id 单调递增，
 *    客户端才能用 Last-Event-ID 精确续传。改写历史事件会让续传错位。
 */

export interface RunEvent {
  /** SSE 的 `id` 字段：**单调递增**，跨 run 共享一条序列 */
  id: number;
  at: string;
  runId: string;
  /** 事件类型：started / progress / gates / converged / failed / finished / cancelled / steer */
  kind: string;
  data: Record<string, unknown>;
}

export interface SinceResult {
  events: RunEvent[];
  /** true = 请求的 id 早于缓冲里最老的一条，**中间的事件已经补不到了** */
  gap: boolean;
  /** 缓冲里最老的一条 id（没有事件时为 0） */
  oldest: number;
}

/** 有界事件缓冲：只追加、满了丢最老的。跨 run 共享一条 id 序列。 */
export class RunEventLog {
  private readonly events: RunEvent[] = [];
  private nextId = 1;
  private readonly subs = new Set<(e: RunEvent) => void>();

  constructor(readonly maxEvents = 1000) {
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      throw new Error(`RunEventLog：maxEvents 必须是正整数，收到 ${maxEvents}`);
    }
  }

  append(runId: string, kind: string, data: Record<string, unknown> = {}): RunEvent {
    const e: RunEvent = { id: this.nextId, at: new Date().toISOString(), runId, kind, data };
    this.nextId += 1;
    this.events.push(e);
    while (this.events.length > this.maxEvents) this.events.shift();
    for (const fn of this.subs) {
      try {
        fn(e);
      } catch {
        // 单个订阅者抛错不该影响其它订阅者与任务本身
      }
    }
    return e;
  }

  /**
   * 取 `id > lastEventId` 的事件。
   *
   * ★`gap` 的判据：请求的 id **早于缓冲里最老那条的前一个**，说明中间有事件被丢掉了。
   * 例：缓冲里最老是 5，请求 `since=2` → 3、4 已经不在 → `gap: true`。
   */
  since(lastEventId: number): SinceResult {
    const oldest = this.events[0]?.id ?? 0;
    const gap = this.events.length > 0 && lastEventId < oldest - 1;
    return { events: this.events.filter((e) => e.id > lastEventId), gap, oldest };
  }

  /** 订阅后续事件。返回取消订阅的函数。 */
  subscribe(fn: (e: RunEvent) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  get size(): number {
    return this.events.length;
  }

  /** 下一个将被分配的 id（测试与诊断用） */
  get nextEventId(): number {
    return this.nextId;
  }
}

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface RunRecord {
  runId: string;
  bookRoot: string;
  /** 人类可读的用途（如「收敛第 7 章」） */
  label: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  /** 结果摘要（done 时才有） */
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * 每个书根一条事件流 + 一份 run 清单。
 *
 * 为什么按书根隔离：事件是**给看这本书的人**看的。混在一起会让客户端
 * 在 `Last-Event-ID` 续传时收到别的书的事件，而它无从分辨。
 */
export class RunRegistry {
  private readonly logs = new Map<string, RunEventLog>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(readonly maxEventsPerBook = 1000) {}

  logFor(bookRoot: string): RunEventLog {
    let log = this.logs.get(bookRoot);
    if (log === undefined) {
      log = new RunEventLog(this.maxEventsPerBook);
      this.logs.set(bookRoot, log);
    }
    return log;
  }

  /**
   * 登记一个 run 并返回它的 id 与取消句柄。
   * **runId 随机**（不按序号）：它会被写进日志与前端状态，序号会泄漏「这台机器跑过多少任务」。
   */
  begin(bookRoot: string, label: string): { runId: string; signal: AbortSignal } {
    const runId = `run-${randomBytes(6).toString('hex')}`;
    const ctrl = new AbortController();
    this.runs.set(runId, { runId, bookRoot, label, startedAt: new Date().toISOString(), status: 'running' });
    this.aborts.set(runId, ctrl);
    this.logFor(bookRoot).append(runId, 'started', { label });
    return { runId, signal: ctrl.signal };
  }

  finish(runId: string, status: Exclude<RunStatus, 'running'>, opts: { result?: Record<string, unknown>; error?: string } = {}): void {
    const rec = this.runs.get(runId);
    if (rec === undefined) return;
    rec.status = status;
    rec.finishedAt = new Date().toISOString();
    if (opts.result !== undefined) rec.result = opts.result;
    if (opts.error !== undefined) rec.error = opts.error;
    this.aborts.delete(runId);
    this.logFor(rec.bookRoot).append(runId, status === 'done' ? 'finished' : status, {
      ...(opts.result !== undefined ? { result: opts.result } : {}),
      ...(opts.error !== undefined ? { error: opts.error } : {}),
    });
  }

  /** 取消一个 run。**返回是否真的发出了信号**（找不到 / 已结束 → false，不假装成功） */
  cancel(runId: string): boolean {
    const ctrl = this.aborts.get(runId);
    const rec = this.runs.get(runId);
    if (ctrl === undefined || rec === undefined || rec.status !== 'running') return false;
    ctrl.abort();
    this.logFor(rec.bookRoot).append(runId, 'cancelling', {});
    return true;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  list(bookRoot?: string): RunRecord[] {
    const all = [...this.runs.values()];
    return (bookRoot === undefined ? all : all.filter((r) => r.bookRoot === bookRoot))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** 投递一条指令到某个 run 的事件流。**当前收敛循环不消费它**——见 BACKLOG 的后续项 */
  steer(bookRoot: string, runId: string, instruction: string): RunEvent {
    return this.logFor(bookRoot).append(runId, 'steer', { instruction, consumed: false });
  }
}
