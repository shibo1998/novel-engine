import path from 'node:path';
import { readFacts, type ExtractedCharacter, type FactsStore } from './extract.js';
import { readState } from './state.js';

/**
 * 结构化反查（B-22 / v0.2 M6.3）：按角色/时间线查历史。
 *
 * 治的是什么：写第 61 章时想问「慕容雪上次出场是哪一章、当时她什么状态」。
 * 没有反查就只能全文搜索人名，然后一篇篇读——**这正是长篇创作里最费时间的动作**。
 *
 * ★为什么先做结构化反查、不直接上向量检索（v0.2 M6.3 的原话）：
 * 结构化数据（B-20 抽出来的事实）已经能回答绝大多数问题，而且是**确定的**
 * ——同样的问题问两次得到同一个答案。向量检索给的是「相似」，
 * 在「第 20 章她左臂有没有伤」这种**事实性**问题上，「相似」没有意义。
 * 效果不够再上向量，不是反过来。
 *
 * ★本模块**只读**：所有查询都不写文件。写是 B-20（extract）的事。
 */

export interface CharacterAppearance {
  chapterNo: number;
  /** 该章里这个角色的状态快照 */
  state: ExtractedCharacter['state'];
  /** 造成这次变化的原因 */
  cause: string;
  /** 原文引句（已核对逐字命中本章正文） */
  evidence: string;
}

export interface CharacterLookup {
  name: string;
  /** 出场过的章号（升序）。**只统计「抽过」的章**——没抽过的不算缺席 */
  appearances: number[];
  /** 按章升序的状态变化史（B-21 的 history 字段就是它） */
  history: CharacterAppearance[];
  /** 最近一次出场 */
  lastSeen: CharacterAppearance | null;
  /**
   * 抽取覆盖率。**必须报出来**：`appearances` 只在抽过的章里统计，
   * 覆盖率不满时「他只在第 3 章出场过」是个**不可信的结论**。
   */
  coverage: { extracted: number; total: number };
}

/** 把「文件 → 章号」的映射抽出来，避免每个查询各写一遍 */
function chapterOrder(states: { file: string; chapterNo: number }[]): Map<string, number> {
  return new Map(states.map((s) => [s.file, s.chapterNo]));
}

/**
 * 某角色的出场史（B-21 的 `history` 字段）。
 *
 * ★**纯函数**，接收已读好的 store 与章号表——便于测试，也避免每次查询重读盘。
 */
export function characterHistory(
  store: FactsStore,
  name: string,
  states: { file: string; chapterNo: number }[],
): CharacterAppearance[] {
  const order = chapterOrder(states);
  return Object.entries(store.chapters)
    .map(([file, facts]) => ({ file, facts, no: order.get(file) ?? 0 }))
    .filter((e) => e.no > 0)
    .sort((a, b) => a.no - b.no)
    .flatMap(({ facts, no }) =>
      facts.characters
        .filter((c) => c.name === name)
        .map((c) => ({ chapterNo: no, state: c.state, cause: c.cause, evidence: c.evidence })),
    );
}

export async function lookupCharacter(bookRoot: string, name: string): Promise<CharacterLookup> {
  const root = path.resolve(bookRoot);
  const [store, state] = await Promise.all([readFacts(root), readState({ bookRoot: root })]);
  const history = characterHistory(store, name, state.chapters);
  return {
    name,
    appearances: history.map((h) => h.chapterNo),
    history,
    lastSeen: history.at(-1) ?? null,
    coverage: { extracted: Object.keys(store.chapters).length, total: state.chapters.length },
  };
}

/** 事实库里出现过的所有角色名（用于「查无此人」时列出候选） */
export async function listKnownCharacters(bookRoot: string): Promise<string[]> {
  const root = path.resolve(bookRoot);
  const store = await readFacts(root);
  const names = new Set<string>();
  for (const facts of Object.values(store.chapters)) {
    for (const c of facts.characters) names.add(c.name);
  }
  return [...names].sort();
}

export interface TimelineLookup {
  events: { chapterNo: number; storyTime: string; event: string; participants: string[]; irreversible: boolean; evidence: string }[];
  coverage: { extracted: number; total: number };
}

/** 时间线（可按章号区间与参与人过滤） */
export async function lookupTimeline(
  bookRoot: string,
  opts: { from?: number; to?: number; participant?: string } = {},
): Promise<TimelineLookup> {
  const root = path.resolve(bookRoot);
  const [store, state] = await Promise.all([readFacts(root), readState({ bookRoot: root })]);
  const order = chapterOrder(state.chapters);
  const events = Object.entries(store.chapters)
    .map(([file, facts]) => ({ facts, no: order.get(file) ?? 0 }))
    .filter((e) => e.no > 0)
    .sort((a, b) => a.no - b.no)
    .flatMap(({ facts, no }) => facts.timeline.map((t) => ({ chapterNo: no, ...t })))
    .filter((e) => (opts.from === undefined || e.chapterNo >= opts.from)
      && (opts.to === undefined || e.chapterNo <= opts.to)
      && (opts.participant === undefined || e.participants.includes(opts.participant)));
  return { events, coverage: { extracted: Object.keys(store.chapters).length, total: state.chapters.length } };
}

export interface ConflictHint {
  kind: 'character-died-then-appears' | 'irreversible-event-then-contradicted';
  chapterNo: number;
  detail: string;
}

/**
 * 与已发生事实的**机械冲突**提示（B-22 的顺带产出）。
 *
 * ★只报**能机械判定**的两类：
 *   ① 某人被标 `alive:false` 之后，又在更后面的章里出现；
 *   ② 不可逆事件之后，同一事件被描述成没发生（当前只报①的同类：角色复活）。
 *
 * ★**不做**语义矛盾判定——那是 Judge J3 的活（它能看到正文）。
 * 这里只从**结构化事实**里找自相矛盾，找得到的就一定是真的矛盾，不猜。
 * 两类判据不查同一件事，是刻意的分工。
 */
export function findFactConflicts(
  store: FactsStore,
  states: { file: string; chapterNo: number }[],
): ConflictHint[] {
  const order = chapterOrder(states);
  const entries = Object.entries(store.chapters)
    .map(([file, facts]) => ({ facts, no: order.get(file) ?? 0 }))
    .filter((e) => e.no > 0)
    .sort((a, b) => a.no - b.no);

  const deathAt = new Map<string, number>();
  const out: ConflictHint[] = [];
  for (const { facts, no } of entries) {
    for (const c of facts.characters) {
      const died = deathAt.get(c.name);
      if (died !== undefined && died < no) {
        out.push({
          kind: 'character-died-then-appears',
          chapterNo: no,
          detail: `「${c.name}」在第 ${died} 章被记为已死亡，但第 ${no} 章又出现（引句：${c.evidence}）`,
        });
      }
      if (!c.state.alive) deathAt.set(c.name, no);
    }
  }
  return out;
}
