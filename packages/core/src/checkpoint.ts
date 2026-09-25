import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeState, readState, serializeState, snapshotChapterHashes, writeState } from './state.js';
import { contentHash } from './hash.js';
import { cfgSection, readBookConfig } from './bookcfg.js';
import type { StoryState } from './types.js';

/**
 * 两步提交 + 快照 checkpoint + resume + rollback（B-24 / v0.2 M4.4–4.6）。
 *
 * 治的是什么：`writeState` 是「一次原子写」，但**一次原子写不等于一次可恢复的事务**。
 * 崩溃点只要落在「正文已改、state 未写」之间，重启后 state 与正文就对不上，
 * 而两边都「看起来正常」——这正是本项目最忌的那类不一致。
 *
 * ★两步提交（4.4）：
 *   ① 写 checkpoint（含 story.json 的**完整快照**）
 *   ② 写 `state/run.pendingCommit`（记目标指纹）
 *   ③ 写 story.json
 *   ④ 清 pendingCommit
 *   任一步崩溃，`resume` 都能判定「该补完还是该回退」——判定依据是
 *   **目标指纹是否已就位**，不是靠猜。
 *
 * ★四条纪律：
 *   1. **restoreFrom 不静默覆盖**（4.5）：当前 story.json 若不是引擎按 checkpoint
 *      序列写出来的（journal 里找不到它的指纹），说明**被手改或外部写入过**——
 *      必须显式 `force` 才覆盖，并把「为什么认为它来历不明」说清楚。
 *   2. **rollback 不改正文**（4.6）：正文文件的回退交给**书仓 git**。
 *      工具替作者改正文是不可逆的破坏；git 有历史、可再看一遍。
 *   3. **checkpoint 是派生数据**：`state/` 整体可清空重建，checkpoint 也跟着没——
 *      真正不可重建的只有 `.soloent/feedback.jsonl`。所以这里**不假装它是备份**。
 *   4. **保留策略**（4.8）：最近 50 份 + 每卷末 1 份。无限增长会把 `state/` 撑爆，
 *      而 `state/` 的语义是「随时可清空」——留太多就违背了那个语义。
 */

export interface Checkpoint {
  id: string;
  seq: number;
  at: string;
  /** 为什么建这份（如 `chapter-committed` / `manual`） */
  reason: string;
  /** story.json 的完整快照 */
  state: StoryState;
  /** 章文件内容指纹：判定「快照之后正文有没有被改过」 */
  chapterHashes: Record<string, string>;
  /** 所属卷（保留策略用；取不到就不填） */
  volume?: number;
}

export interface PendingCommit {
  checkpointId: string;
  startedAt: string;
  /** 目标 story.json 的内容指纹。**判定「补完还是回退」全靠它** */
  targetHash: string;
  reason: string;
}

const CP_DIR = 'state/checkpoints';
const PENDING_REL = 'state/run.pendingCommit';
const JOURNAL_REL = 'state/journal.jsonl';

function cpPath(root: string, id: string): string {
  return path.join(root, CP_DIR, `${id}.json`);
}

function stripBom(t: string): string {
  return t.replace(/^\uFEFF/, '');
}

async function atomicWrite(target: string, text: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, text, 'utf-8');
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

/** 追加一条 journal 记录。**只追加、永不整份替换**——它是「引擎做过什么」的流水 */
async function appendJournal(root: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(root, 'state'), { recursive: true });
  await appendFile(path.join(root, JOURNAL_REL), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
}

export interface JournalEntry {
  at: string;
  kind: string;
  [k: string]: unknown;
}

export async function readJournal(root0: string): Promise<JournalEntry[]> {
  const root = path.resolve(root0);
  const raw = await readFile(path.join(root, JOURNAL_REL), 'utf-8').catch(() => null);
  if (raw === null) return [];
  const out: JournalEntry[] = [];
  for (const line of stripBom(raw).split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push(JSON.parse(t) as JournalEntry);
    } catch {
      // 残行（上次写到一半崩了）：丢弃。追加式的前提是残行只可能是最后一行
    }
  }
  return out;
}

/**
 * 章文件的内容指纹表（`Map` → 可 JSON 化的 `Record`）。
 *
 * ★**不在这里另写一份「读章文件算指纹」**：那是 `state.ts` 的
 * `snapshotChapterHashes`，全项目只允许一处。这里只做形状转换——
 * 两份实现必然漂移，而漂移的表现是「checkpoint 记的指纹与 gateStatus 记的对不上」，
 * 那会让 rollback 报出一堆假的「正文变了」。
 */
async function chapterHashesRecord(root0: string, state: StoryState): Promise<Record<string, string>> {
  const m = await snapshotChapterHashes(root0, state.chapters);
  return Object.fromEntries(m);
}

export interface CommitOptions {
  bookRoot: string;
  reason: string;
  /** 卷号（保留策略用；给了才参与「每卷末留一份」） */
  volume?: number;
}

export interface CommitOutcome {
  checkpoint: Checkpoint;
  /** 提交后 story.json 的指纹 */
  stateHash: string;
  /** 中途是否有未完成的提交需要 resume（正常情况下没有） */
  hadPending: boolean;
}

/**
 * 两步提交（4.4）。**任一步崩溃都不会留下「正文改了、state 没写」的静默不一致**：
 * pendingCommit 会把「这次提交没走完」这件事留在盘上，下次 `resume` 能判定。
 */
export async function commitState(o: CommitOptions): Promise<CommitOutcome> {
  const root = path.resolve(o.bookRoot);
  const pending = await readPendingCommit(root);
  const state = await readState({ bookRoot: root, skipStaleSweep: true });
  const hashes = await chapterHashesRecord(root, state);

  // ① 写 checkpoint（含快照）
  const seq = await nextSeq(root);
  const cp: Checkpoint = {
    id: `cp-${String(seq).padStart(4, '0')}`,
    seq,
    at: new Date().toISOString(),
    reason: o.reason,
    state,
    chapterHashes: hashes,
    ...(o.volume !== undefined ? { volume: o.volume } : {}),
  };
  await atomicWrite(cpPath(root, cp.id), JSON.stringify(cp, null, 2) + '\n');

  // ② 写 pendingCommit（目标指纹 = 即将写入的 story.json 的指纹）
  // ★必须用 state.ts 的 serializeState 算：两边各拼一遍归一逻辑的话，
  // generatedAt 会各生成一次（相差毫秒）→ 指纹永远对不上 → 每次 resume 都误判成「回退」。
  const target = normalizeState({ ...state, generatedAt: new Date().toISOString() });
  const targetHash = contentHash(serializeState(target));
  await atomicWrite(path.join(root, PENDING_REL), JSON.stringify({
    checkpointId: cp.id, startedAt: new Date().toISOString(), targetHash, reason: o.reason,
  } satisfies PendingCommit, null, 2) + '\n');

  // ③ 写 story.json（用同一个 target，保证写出来的就是上面算过指纹的那份）
  await writeState(target, { generatedAt: target.generatedAt });

  // ④ 清 pendingCommit
  await rm(path.join(root, PENDING_REL), { force: true });

  await appendJournal(root, { kind: 'commit', checkpoint: cp.id, reason: o.reason, stateHash: targetHash });
  return { checkpoint: cp, stateHash: targetHash, hadPending: pending !== null };
}

async function nextSeq(root: string): Promise<number> {
  const ids = await listCheckpointIds(root);
  const max = ids.reduce((m, id) => Math.max(m, Number(id.replace(/^cp-/, '')) || 0), 0);
  return max + 1;
}

async function listCheckpointIds(root: string): Promise<string[]> {
  const files = await readdir(path.join(root, CP_DIR)).catch(() => [] as string[]);
  return files.filter((f) => /^cp-\d+\.json$/.test(f)).map((f) => f.replace(/\.json$/, '')).sort();
}

export async function readPendingCommit(root0: string): Promise<PendingCommit | null> {
  const root = path.resolve(root0);
  const raw = await readFile(path.join(root, PENDING_REL), 'utf-8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(stripBom(raw)) as PendingCommit;
  } catch {
    return null;
  }
}

export async function readCheckpoint(root0: string, id: string): Promise<Checkpoint | null> {
  const root = path.resolve(root0);
  const raw = await readFile(cpPath(root, id), 'utf-8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(stripBom(raw)) as Checkpoint;
  } catch {
    return null;
  }
}

export interface CheckpointMeta {
  id: string;
  seq: number;
  at: string;
  reason: string;
  chapters: number;
  volume?: number;
}

/** 列 checkpoint 的**元信息**（不把每份的 state 都读进内存——50 份 story.json 很占地方） */
export async function listCheckpoints(root0: string): Promise<CheckpointMeta[]> {
  const root = path.resolve(root0);
  const ids = await listCheckpointIds(root);
  const out: CheckpointMeta[] = [];
  for (const id of ids) {
    const cp = await readCheckpoint(root, id);
    if (cp === null) continue;
    out.push({
      id: cp.id, seq: cp.seq, at: cp.at, reason: cp.reason, chapters: cp.state.chapters.length,
      ...(cp.volume !== undefined ? { volume: cp.volume } : {}),
    });
  }
  return out;
}

export interface ResumeReport {
  /** none = 没有未完成的提交；completed = 补完了；rolled-back = 回退了 */
  action: 'none' | 'completed' | 'rolled-back';
  detail: string;
  checkpointId?: string;
}

/**
 * 崩溃恢复（4.4）。判定依据是**目标指纹是否已就位**：
 *   · story.json 的指纹 == pendingCommit.targetHash → 第 ③ 步其实写成功了，
 *     只是第 ④ 步没跑完 → **补完**（清 pendingCommit）。
 *   · 不等 → 第 ③ 步没写成或写了一半 → **回退**（从 checkpoint 拷回快照），
 *     因为「正文已改、state 没写」这个中间态不能留着。
 */
export async function resume(root0: string): Promise<ResumeReport> {
  const root = path.resolve(root0);
  const pending = await readPendingCommit(root);
  if (pending === null) return { action: 'none', detail: '没有未完成的提交。' };

  const raw = await readFile(path.join(root, 'state', 'story.json'), 'utf-8').catch(() => null);
  const currentHash = raw === null ? '' : contentHash(stripBom(raw));

  if (currentHash === pending.targetHash) {
    await rm(path.join(root, PENDING_REL), { force: true });
    await appendJournal(root, { kind: 'resume', action: 'completed', checkpoint: pending.checkpointId });
    return {
      action: 'completed',
      checkpointId: pending.checkpointId,
      detail: `第 ③ 步（写 story.json）其实已完成，只是没清 pendingCommit——已补完。`,
    };
  }

  const cp = await readCheckpoint(root, pending.checkpointId);
  if (cp === null) {
    return {
      action: 'none',
      checkpointId: pending.checkpointId,
      detail: `未完成的提交指向 ${pending.checkpointId}，但那份 checkpoint 不在了——无法自动判定。`
        + '请人工核对 state/story.json 与 chapters/，或从书仓 git 回退。',
    };
  }
  await writeState(cp.state);
  await rm(path.join(root, PENDING_REL), { force: true });
  await appendJournal(root, { kind: 'resume', action: 'rolled-back', checkpoint: cp.id });
  return {
    action: 'rolled-back',
    checkpointId: cp.id,
    detail: `story.json 与目标指纹不符（提交没走完）——已从 ${cp.id} 回退 state。`
      + '★正文文件未动：那由书仓 git 负责。',
  };
}

export class RestoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreRefused';
  }
}

/**
 * 从 checkpoint 拷回 state（4.5）。
 *
 * ★**不静默覆盖**：当前 story.json 的指纹若在 journal 里找不到（既不是某次 commit
 * 写的、也不等于某份 checkpoint 的快照），说明它**被手改或由外部写入过**——
 * 这时必须显式 `force`，并把「为什么认为它来历不明」说清楚。
 */
export async function restoreFrom(
  root0: string,
  id: string,
  opts: { force?: boolean } = {},
): Promise<{ restored: string; stateHash: string }> {
  const root = path.resolve(root0);
  const cp = await readCheckpoint(root, id);
  if (cp === null) {
    const ids = await listCheckpointIds(root);
    throw new RestoreRefused(`没有 checkpoint ${id}。现有：${ids.join('、') || '（空）'}`);
  }

  const raw = await readFile(path.join(root, 'state', 'story.json'), 'utf-8').catch(() => null);
  const currentHash = raw === null ? '' : contentHash(stripBom(raw));
  const journal = await readJournal(root);
  const known = new Set<string>([
    ...journal.filter((j) => j['kind'] === 'commit').map((j) => String(j['stateHash'] ?? '')),
    ...(await listCheckpointIds(root)).map((cid) => cid), // 占位，下面用真指纹补齐
  ]);
  // 把每份 checkpoint 自己的 state 指纹也算进「来历已知」
  for (const cid of await listCheckpointIds(root)) {
    const c = await readCheckpoint(root, cid);
    if (c !== null) known.add(contentHash(serializeState(c.state)));
  }
  known.delete('');

  if (raw !== null && !known.has(currentHash) && opts.force !== true) {
    throw new RestoreRefused(
      `拒绝覆盖：当前 state/story.json 的指纹在 journal 里找不到。\n`
        + `  当前指纹：${currentHash}\n`
        + `  这说明它**不是引擎按 checkpoint 序列写出来的**——被手改过，或由外部工具写入过。\n`
        + `  journal 里已知的提交：${journal.filter((j) => j['kind'] === 'commit').length} 次\n`
        + '  确认要覆盖（会丢掉当前 story.json 里的改动）：加 --force。\n'
        + '  注意：**正文文件不会被恢复**——那由书仓 git 负责。',
    );
  }

  await writeState(cp.state);
  const hash = contentHash(await readFile(path.join(root, 'state', 'story.json'), 'utf-8'));
  await appendJournal(root, { kind: 'restore', checkpoint: id, forced: opts.force === true });
  return { restored: id, stateHash: hash };
}

export interface RollbackReport {
  restored: string;
  /** 快照之后**正文**变过的章（工具只报，不改——4.6） */
  changedChapters: { file: string; note: string }[];
  hint: string;
}

/**
 * 显式回退（4.6）。允许 phase 回退；写 journal；
 * ★**正文文件由书仓 git 回退**——工具只把「哪些章的正文与快照不符」列出来，
 * 因为替作者改正文是不可逆的破坏，而 git 有历史、可再看一遍。
 */
export async function rollback(
  root0: string,
  id: string,
  opts: { force?: boolean } = {},
): Promise<RollbackReport> {
  const root = path.resolve(root0);
  const cp = await readCheckpoint(root, id);
  if (cp === null) throw new RestoreRefused(`没有 checkpoint ${id}`);

  await restoreFrom(root, id, opts);

  const changedChapters: RollbackReport['changedChapters'] = [];
  for (const [file, hash] of Object.entries(cp.chapterHashes)) {
    const raw = await readFile(path.join(root, 'chapters', file), 'utf-8').catch(() => null);
    const now = raw === null ? '' : contentHash(stripBom(raw));
    if (now !== hash) {
      changedChapters.push({
        file,
        note: raw === null ? '文件已不存在' : '内容与快照不符',
      });
    }
  }
  await appendJournal(root, { kind: 'rollback', checkpoint: id, changedChapters: changedChapters.map((c) => c.file) });

  const bookGit = await readBookConfig(root);
  const isGit = bookGit !== null;
  return {
    restored: id,
    changedChapters,
    hint: changedChapters.length === 0
      ? '正文与快照一致，无需回退正文。'
      : `以上 ${changedChapters.length} 个章文件的正文与快照不符。**工具不会替你改正文**——`
        + (isGit
          ? '用书仓 git 回退：git checkout <commit> -- chapters/<文件名>'
          : '书目录不是 git 仓库；建议先 git init，否则正文改动无法回退。'),
  };
}

export interface PruneReport {
  kept: string[];
  removed: string[];
}

/**
 * 保留策略（4.8）：最近 `keepRecent`（默认 50）份 + **每卷末 1 份**。
 *
 * 为什么要有：无限增长会把 `state/` 撑爆，而 `state/` 的语义是「随时可清空」——
 * 留太多就违背了那个语义。卷末那一份是**里程碑**，比中间态值钱得多。
 */
export async function pruneCheckpoints(root0: string, opts: { keepRecent?: number } = {}): Promise<PruneReport> {
  const root = path.resolve(root0);
  const metas = await listCheckpoints(root);
  const keepRecent = opts.keepRecent ?? 50;
  const sorted = [...metas].sort((a, b) => a.seq - b.seq);

  const keep = new Set<string>();
  for (const m of sorted.slice(-keepRecent)) keep.add(m.id);
  // 每卷末 1 份：按 volume 分组取该卷最后一checkpoint
  const byVolume = new Map<number, CheckpointMeta>();
  for (const m of sorted) {
    if (m.volume !== undefined) byVolume.set(m.volume, m);
  }
  for (const m of byVolume.values()) keep.add(m.id);

  const removed: string[] = [];
  for (const m of sorted) {
    if (keep.has(m.id)) continue;
    await rm(cpPath(root, m.id), { force: true });
    removed.push(m.id);
  }
  if (removed.length > 0) await appendJournal(root, { kind: 'prune', removed });
  return { kept: [...keep].sort(), removed };
}
