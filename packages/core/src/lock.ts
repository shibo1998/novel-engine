import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';

/**
 * 书级文件锁（B-25，v0.2 M4.7）。
 *
 * 治的是什么：CLI 与 server 可能同时写同一本书（面板点「生成」的同时命令行也在跑
 * `novel book`）。两个进程各自 readState → 各自写章节 → 各自 writeState，
 * 后写的那个把前一个的结果覆盖掉，而**两边都报告成功**。
 * 这不是理论风险：`convergeChapter` 一轮就要读写 state 两次。
 *
 * ★为什么锁在 `writeChapter` / `convergeChapter` **内部**，而不是各入口手工接线：
 * 接线模式必然漏——B-10 那轮就抓到 `novel write` 一道门都没接（风格闸门也没接）。
 * 锁放在**唯一真正写章节文件的两个函数**里，新入口自动被覆盖，没有「忘记接线」这个选项。
 *
 * 三条设计：
 *   1. **pid + 时间戳**：记 `{pid, host, label, at, token}`。
 *   2. **陈旧锁可接管**：pid 不在了（进程崩了），或锁龄超过 `staleMs` → 直接接管并如实报告。
 *      没有这条，一次崩溃会让整本书再也写不了，只能人工删文件。
 *   3. **同进程可重入**：`convergeChapter` 内部会调 `writeChapter`，
 *      后者若再抢一次锁就会自己挡住自己。pid 相同即视为已持有。
 */

const LOCK_REL = '.soloent/lock.json';

export interface BookLockInfo {
  pid: number;
  host: string;
  /** 谁持有（如 "novel book 第 1-5 章"） */
  label: string;
  /** 获取时刻，ISO 8601 */
  at: string;
  /** 释放凭据：只释放自己持有的那把锁 */
  token: string;
}

export interface BookLockHandle {
  /** 是否本次真的拿到了（重入时为 false，表示「本进程已持有」） */
  acquired: boolean;
  info: BookLockInfo;
  /** 接管了一把陈旧锁时给出原因 */
  tookOverFrom?: { pid: number; label: string; ageMs: number; why: string };
  release: () => Promise<void>;
}

export class BookLockedError extends Error {
  constructor(readonly holder: BookLockInfo, readonly ageMs: number) {
    super(
      `本书正被另一个进程写入，已拒绝并发写：\n`
        + `  持有者：pid ${holder.pid} @ ${holder.host}｜${holder.label}\n`
        + `  获取于：${holder.at}（${Math.round(ageMs / 1000)}s 前）\n`
        + '  等它结束，或确认它已经死了之后接管：\n'
        + '    novel lock status --book <书目录>   # 看是谁\n'
        + '    novel lock release --book <书目录>  # 强制释放（**先确认那个进程真的没了**）',
    );
    this.name = 'BookLockedError';
  }
}

/** 默认陈旧阈值：30 分钟。比任何一次正常生成都长，又短到不用人工干预 */
const DEFAULT_STALE_MS = 30 * 60_000;

function lockPath(bookRoot: string): string {
  return path.join(path.resolve(bookRoot), LOCK_REL);
}

/** 进程是否还活着。`kill(pid, 0)` 不发信号，只做存在性检查。 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在、只是不归我管（算活着）；ESRCH = 真没了
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读当前锁（没有 / 坏了 → null）。坏了按「没有」处理——不让自己被一个残文件永久挡住。 */
export async function readBookLock(bookRoot: string): Promise<BookLockInfo | null> {
  const raw = await readFile(lockPath(bookRoot), 'utf-8').catch(() => null);
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw.replace(/^\uFEFF/, '')) as BookLockInfo;
    if (typeof o.pid !== 'number' || typeof o.token !== 'string') return null;
    return o;
  } catch {
    return null;
  }
}

async function writeLockFile(bookRoot: string, info: BookLockInfo): Promise<void> {
  const target = lockPath(bookRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(info, null, 2) + '\n', 'utf-8');
  try {
    await rename(tmp, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      await rm(target, { force: true });
      await rename(tmp, target);
      return;
    }
    throw e;
  }
}

export interface AcquireOptions {
  label: string;
  /** 超过这个时长即视为陈旧，可接管。默认 30 分钟 */
  staleMs?: number;
}

/**
 * 取锁。已有人持有时抛 `BookLockedError`；陈旧（进程已死 / 超时）则**接管并如实报告**。
 * 同进程重入返回 `acquired: false` 且 release 为空操作——`convergeChapter` 内部要调
 * `writeChapter`，不能自己挡自己。
 */
export async function acquireBookLock(bookRoot: string, o: AcquireOptions): Promise<BookLockHandle> {
  const root = path.resolve(bookRoot);
  const staleMs = o.staleMs ?? DEFAULT_STALE_MS;
  const existing = await readBookLock(root);

  if (existing !== null) {
    const ageMs = Date.now() - Date.parse(existing.at);
    // 同进程重入：convergeChapter → writeChapter
    if (existing.pid === process.pid) {
      return { acquired: false, info: existing, release: async () => undefined };
    }
    const dead = !pidAlive(existing.pid);
    const stale = Number.isFinite(ageMs) && ageMs > staleMs;
    if (!dead && !stale) throw new BookLockedError(existing, Number.isFinite(ageMs) ? ageMs : 0);
    // 接管
    const info: BookLockInfo = {
      pid: process.pid,
      host: hostname(),
      label: o.label,
      at: new Date().toISOString(),
      token: randomBytes(8).toString('hex'),
    };
    await writeLockFile(root, info);
    return {
      acquired: true,
      info,
      tookOverFrom: {
        pid: existing.pid,
        label: existing.label,
        ageMs: Number.isFinite(ageMs) ? ageMs : 0,
        why: dead ? `原持有进程 ${existing.pid} 已不存在` : `锁龄超过 ${Math.round(staleMs / 60000)} 分钟`,
      },
      release: async () => { await releaseBookLock(root, info.token); },
    };
  }

  const info: BookLockInfo = {
    pid: process.pid,
    host: hostname(),
    label: o.label,
    at: new Date().toISOString(),
    token: randomBytes(8).toString('hex'),
  };
  await writeLockFile(root, info);
  return { acquired: true, info, release: async () => { await releaseBookLock(root, info.token); } };
}

/**
 * 释放。**只释放自己持有的那把**（token 对不上就不动）——
 * 否则「A 接管了 B 的锁、B 结束时把 A 的锁删了」这种竞态会重新打开。
 */
export async function releaseBookLock(bookRoot: string, token: string): Promise<boolean> {
  const root = path.resolve(bookRoot);
  const cur = await readBookLock(root);
  if (cur === null || cur.token !== token) return false;
  await rm(lockPath(root), { force: true });
  return true;
}

/** 强制释放（`novel lock release`）。不看 token，但把被释放的持有者信息返回给调用方如实报告。 */
export async function forceReleaseBookLock(bookRoot: string): Promise<BookLockInfo | null> {
  const root = path.resolve(bookRoot);
  const cur = await readBookLock(root);
  await rm(lockPath(root), { force: true });
  return cur;
}

/** 取锁 → 跑 → 无论成败都释放。写章节的两个入口用它包住整个流程。 */
export async function withBookLock<T>(
  bookRoot: string,
  label: string,
  fn: (handle: BookLockHandle) => Promise<T>,
): Promise<T> {
  const handle = await acquireBookLock(bookRoot, { label });
  try {
    return await fn(handle);
  } finally {
    await handle.release().catch(() => undefined);
  }
}
