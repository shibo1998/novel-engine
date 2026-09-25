import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * `book.json` 的**唯一**读写入口。
 *
 * 为什么必须收成一处：全项目曾有 **8 处**各自 `readFile + 剥 BOM + JSON.parse + 兜底`，
 * 每处的兜底语义还不一样（有的返回 null、有的返回 `{}`、有的直接抛）。
 * 这类分散不是「风格问题」——`paths.now` 的缺省值 `.soloent/memory/now.md`
 * 就在三处各写了一遍，改一处必漏两处，而漏了的表现是「状态卡读不到」这种**静默失效**。
 * 本项目已经因为「同一个值有两个副本」吃过多次亏。
 *
 * ★BOM 纪律：`novel init` 刻意写带 BOM 的 book.json（Windows 记事本友好）。
 * 读要剥、**写要还原**——否则一次写入就把 BOM 洗掉，作者用记事本再打开时中文会乱码。
 * 这条纪律现在只有一份实现。
 */

export interface BookConfig {
  cfg: Record<string, unknown>;
  /** 读进来时是否带 BOM；写回时必须原样带上 */
  hadBom: boolean;
}

export function bookConfigPath(bookRoot: string): string {
  return path.join(path.resolve(bookRoot), '.soloent', 'book.json');
}

/**
 * 读 book.json。文件不存在 / JSON 坏 → `null`。
 *
 * 返回 `null` 而不是抛：调用方分两种（「配置坏了就用缺省」与「配置坏了就报错」），
 * 由它们自己决定，本函数不替它们猜。**但绝不允许静默返回空对象**——
 * 那会让「配置坏了」与「配置是空的」同形，正是本项目最忌的那种同形。
 */
export async function readBookConfig(bookRoot: string): Promise<BookConfig | null> {
  const raw = await readFile(bookConfigPath(bookRoot), 'utf-8').catch(() => null);
  if (raw === null) return null;
  try {
    return { cfg: JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>, hadBom: raw.startsWith('\uFEFF') };
  } catch {
    return null;
  }
}

/** 原子写回 book.json，按 `hadBom` 还原 BOM。 */
export async function writeBookConfig(bookRoot: string, cfg: Record<string, unknown>, hadBom: boolean): Promise<void> {
  const target = bookConfigPath(bookRoot);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, (hadBom ? '\uFEFF' : '') + JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
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

/** 取顶层段的字符串字段；段缺失 / 值不是字符串 / 空串 → fallback */
export function cfgString(cfg: Record<string, unknown>, section: string, key: string, fallback = ''): string {
  const sec = cfg[section];
  if (typeof sec !== 'object' || sec === null) return fallback;
  const v = (sec as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : fallback;
}

/** 取顶层段的字符串数组；段缺失 / 值不是数组 → fallback（并过滤掉非字符串项） */
export function cfgStringArray(cfg: Record<string, unknown>, section: string, key: string, fallback: string[] = []): string[] {
  const sec = cfg[section];
  if (typeof sec !== 'object' || sec === null) return fallback;
  const v = (sec as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : fallback;
}

/** 取顶层段的对象；段缺失 / 不是对象 → fallback */
export function cfgSection(cfg: Record<string, unknown>, section: string): Record<string, unknown> {
  const sec = cfg[section];
  return typeof sec === 'object' && sec !== null && !Array.isArray(sec) ? (sec as Record<string, unknown>) : {};
}

/** `paths.now` 的缺省值——**只在这里写一遍** */
export const DEFAULT_NOW_PATH = '.soloent/memory/now.md';
