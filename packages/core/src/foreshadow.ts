import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFacts } from './extract.js';
import { readState } from './state.js';

/**
 * 伏笔台账（B-23 / v0.2 §2、附 A）。
 *
 * 治的是什么：伏笔散在正文里，作者靠脑子记。到第 60 章时「我第 12 章埋的那个
 * 还收不收」只能翻。台账把**引擎分配 id 的事实条目**集中起来，
 * 于是「哪些还开着、哪些逾期了」变成一次查询。
 *
 * ★三条纪律：
 *
 * 1. **id 由引擎分配，模型不得自造**（v0.2 §2 明文）。
 *    模型给的是「内容描述」，`f-001` 这种 id 只有引擎能发——
 *    让模型自己编号，两章之间必然撞号，而撞号之后「引用哪个」就说不清了。
 *
 * 2. **台账是引擎从事实库汇聚出来的，不是第二份真相源**。
 *    B-20 的 `state/facts.json` 是抽取结果，台账是它的**投影 + 人工修正**
 *    （level / targetChapter / abandon 由人定，因为「这个伏笔多重要」不可推导）。
 *    所以 `syncForeshadows` 只**新增**，绝不覆盖人工改过的字段。
 *
 * 3. **逾期要分等级**：`core` 逾期是必须处理的（主线断了），`minor` 逾期可以放着。
 *    一律当严重 → 噪音；一律当提示 → 主线断了也没人知道。
 */

export type ForeshadowLevel = 'minor' | 'major' | 'core';
export type ForeshadowStatus = 'open' | 'paid' | 'overdue' | 'abandoned';

export interface ForeshadowItem {
  /** 引擎分配：`f-001`。**模型不得自造** */
  id: string;
  content: string;
  level: ForeshadowLevel;
  /** 埋设章 */
  plantedChapter: number;
  /** 计划回收章（人填；没有就不判逾期） */
  targetChapter?: number;
  status: ForeshadowStatus;
  /** 实际回收章 */
  paidChapter?: number;
  /** 最近一次由哪一章的抽取贡献/更新 */
  sourceChapter: number;
  /** 原文引句（来自抽取，已核对逐字命中） */
  evidence: string;
  /** 人是否改过 level（改过就不再被同步覆盖） */
  levelPinned?: boolean;
}

export interface ForeshadowLedger {
  schemaVersion: 1;
  bookRoot: string;
  /** 下一个可用序号。单调递增，**回收 id 不复用**（复用了历史引用就指错） */
  nextSeq: number;
  items: ForeshadowItem[];
}

const LEDGER_REL = 'state/foreshadows.json';
const LEVELS: ReadonlySet<string> = new Set(['minor', 'major', 'core']);

function ledgerPath(root: string): string {
  return path.join(root, LEDGER_REL);
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

async function readLedger(root: string): Promise<ForeshadowLedger> {
  const raw = await readFile(ledgerPath(root), 'utf-8').catch(() => null);
  const empty: ForeshadowLedger = { schemaVersion: 1, bookRoot: root, nextSeq: 1, items: [] };
  if (raw === null) return empty;
  try {
    const p = JSON.parse(stripBom(raw)) as ForeshadowLedger;
    if (p.schemaVersion !== 1 || p.bookRoot !== root) return empty;
    return p;
  } catch {
    return empty;
  }
}

/** 内容归一：去空白 + 去标点。**同一伏笔的两种措辞**尽量能对上（LLM 不会逐字复述） */
function normContent(s: string): string {
  return s.replace(/\s/g, '').replace(/[，。！？；：、"'「」『』（）()\-—…]/g, '');
}

const pad3 = (n: number): string => String(n).padStart(3, '0');

/** 引擎分配 id */
export function allocForeshadowId(ledger: ForeshadowLedger): string {
  return `f-${pad3(ledger.nextSeq)}`;
}

export interface SyncResult {
  ledger: ForeshadowLedger;
  added: ForeshadowItem[];
  paid: ForeshadowItem[];
  /** 抽取里出现但**没能对上**任何台账条目的回收声明（内容措辞差太远） */
  unmatchedPaidOff: { chapterNo: number; content: string }[];
}

/**
 * 从事实库汇聚伏笔台账。
 *
 * - 抽取到的新伏笔：内容归一后能对上已有条目 → 视为同一条（不新增）；
 *   对不上 → 分配新 id 追加。
 * - 抽取里的 `paidOff`：按内容归一对已有条目 → 标 paid。
 *   对不上就记进 `unmatchedPaidOff` —— **不许静默丢弃**，否则「回收了但没销账」
 *   会一直挂着当逾期。
 * - 人改过的 `level`（`levelPinned`）**不被同步覆盖**。
 *
 * 幂等：同一份事实库跑两遍结果一样（除了 id 分配在第一次发生）。
 */
export async function syncForeshadows(bookRoot: string): Promise<SyncResult> {
  const root = path.resolve(bookRoot);
  const [facts, state] = await Promise.all([readFacts(root), readState({ bookRoot: root })]);
  const ledger = await readLedger(root);
  const chapterOf = new Map(state.chapters.map((c) => [c.file, c.chapterNo]));

  const added: ForeshadowItem[] = [];
  const paid: ForeshadowItem[] = [];
  const unmatchedPaidOff: SyncResult['unmatchedPaidOff'] = [];

  // 按章号升序处理：id 分配顺序与故事顺序一致，人工看台账时顺眼
  const entries = Object.entries(facts.chapters)
    .map(([file, f]) => ({ file, f, no: chapterOf.get(file) ?? 0 }))
    .filter((e) => e.no > 0)
    .sort((a, b) => a.no - b.no);

  const byNorm = new Map(ledger.items.map((it) => [normContent(it.content), it]));

  for (const { f, no } of entries) {
    for (const fs of f.foreshadows) {
      const key = normContent(fs.content);
      if (key === '') continue;
      const hit = byNorm.get(key);
      if (hit === undefined) {
        const item: ForeshadowItem = {
          id: allocForeshadowId(ledger),
          content: fs.content,
          level: LEVELS.has(fs.level) ? fs.level : 'minor',
          plantedChapter: fs.plantedChapter > 0 ? fs.plantedChapter : no,
          status: 'open',
          sourceChapter: no,
          evidence: fs.evidence,
        };
        ledger.nextSeq += 1;
        ledger.items.push(item);
        byNorm.set(key, item);
        added.push(item);
      } else if (hit.status === 'abandoned') {
        // 作者主动放弃过的伏笔又被抽到了：**不复活**，但记下最新出处
        hit.sourceChapter = no;
      }
    }
    // 回收：把本章的 paidOff 销到台账上
    for (const content of f.foreshadows.flatMap((x) => x.paidOff)) {
      const key = normContent(content);
      if (key === '') continue;
      const hit = byNorm.get(key);
      if (hit === undefined) {
        unmatchedPaidOff.push({ chapterNo: no, content });
        continue;
      }
      if (hit.status === 'open' || hit.status === 'overdue') {
        hit.status = 'paid';
        hit.paidChapter = no;
        paid.push(hit);
      }
    }
  }

  await atomicWrite(ledgerPath(root), JSON.stringify(ledger, null, 2) + '\n');
  return { ledger, added, paid, unmatchedPaidOff };
}

/** 读台账（不做同步）。**同时把逾期状态算出来**——逾期是「与当前进度比较」得出的，不是存出来的 */
export async function readForeshadowLedger(bookRoot: string): Promise<{ ledger: ForeshadowLedger; latestChapter: number }> {
  const root = path.resolve(bookRoot);
  const [ledger, state] = await Promise.all([readLedger(root), readState({ bookRoot: root })]);
  const latestChapter = state.chapters.reduce((m, c) => Math.max(m, c.chapterNo), 0);

  // 逾期是**派生**的：每次读时按当前进度重算。
  // 存进文件的话，「写到第 61 章」这个事件没地方触发重算——台账会停在旧结论上。
  for (const it of ledger.items) {
    if (it.status !== 'open' && it.status !== 'overdue') continue;
    const overdue = it.targetChapter !== undefined && it.targetChapter > 0 && latestChapter > it.targetChapter;
    it.status = overdue ? 'overdue' : 'open';
  }
  return { ledger, latestChapter };
}

export class ForeshadowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForeshadowError';
  }
}

/** 人工修正：改等级 / 设计划回收章 / 放弃。**这些字段不可推导，只能人来定** */
export async function updateForeshadow(
  bookRoot: string,
  id: string,
  patch: { level?: ForeshadowLevel; targetChapter?: number; abandon?: boolean; reopen?: boolean },
): Promise<ForeshadowItem> {
  const root = path.resolve(bookRoot);
  const ledger = await readLedger(root);
  const it = ledger.items.find((x) => x.id === id);
  if (it === undefined) {
    throw new ForeshadowError(
      `没有伏笔 ${id}。现有：${ledger.items.map((x) => x.id).join('、') || '（空，先跑 novel foreshadow sync）'}`,
    );
  }
  if (patch.level !== undefined) {
    if (!LEVELS.has(patch.level)) throw new ForeshadowError(`level 只能是 minor / major / core，收到「${patch.level}」`);
    it.level = patch.level;
    it.levelPinned = true; // 钉住：同步不再覆盖
  }
  if (patch.targetChapter !== undefined) it.targetChapter = patch.targetChapter;
  if (patch.abandon === true) it.status = 'abandoned';
  if (patch.reopen === true) {
    it.status = 'open';
    delete it.paidChapter;
  }
  await atomicWrite(ledgerPath(root), JSON.stringify(ledger, null, 2) + '\n');
  return it;
}

export interface ForeshadowReport {
  total: number;
  open: number;
  paid: number;
  overdue: number;
  abandoned: number;
  /** core 级逾期 = 主线断了，必须交人（v0.2 §2：core 逾期 → human.needed） */
  needsHuman: ForeshadowItem[];
}

export function summarizeForeshadows(ledger: ForeshadowLedger): ForeshadowReport {
  const by = (s: ForeshadowStatus): ForeshadowItem[] => ledger.items.filter((i) => i.status === s);
  const overdue = by('overdue');
  return {
    total: ledger.items.length,
    open: by('open').length,
    paid: by('paid').length,
    overdue: overdue.length,
    abandoned: by('abandoned').length,
    needsHuman: overdue.filter((i) => i.level === 'core'),
  };
}
