import path from 'node:path';
import { readFacts } from './extract.js';
import { readForeshadowLedger, summarizeForeshadows } from './foreshadow.js';
import { readState } from './state.js';
import { collectStats } from './stats.js';

/**
 * 完本流程（B-42 / v0.2 L2）：收尾前把「还没结的事」摆出来。
 *
 * 治的是什么：一本写到 200 万字，作者自己也不知道「还有哪些伏笔没收」。
 * 到完本时才发现，就只能硬补一段或者假装没埋过——两种都伤读者。
 *
 * ★三条纪律：
 *
 * 1. **所有比率都必须带「分母可信吗」**。伏笔回收率的分母是「已登记的伏笔」，
 *    而登记来自抽取——**抽取覆盖不满时，回收率是个不可信的结论**。
 *    所以报告里一律带 `coverage`，并把它作为 `blockers` 的一部分。
 *    本项目已经为「零输入被读成零发现」吃过太多次亏。
 *
 * 2. **`core` 级伏笔未回收 = 必须处理**（主线断了），`minor` 只提示。
 *    一律当严重 → 噪音；一律当提示 → 主线断了也没人知道。
 *
 * 3. **只报事实，不评好坏**。「这一卷节奏偏慢」这类判断没有可靠判据，
 *    硬报就是编。报告只回答「有哪些还没结的事」。
 */

export interface CharacterArc {
  name: string;
  firstChapter: number;
  lastChapter: number;
  /** 状态被记录过几次（每次出场算一次） */
  appearances: number;
  /** 境界变化序列（按出现顺序去重后的原始串） */
  realms: string[];
  alive: boolean;
  issues: string[];
}

export interface WrapUpReport {
  bookRoot: string;
  chapters: number;
  words: number;
  foreshadow: {
    total: number;
    paid: number;
    open: number;
    overdue: number;
    abandoned: number;
    /** 回收率 = paid / (total - abandoned)。分母为 0 时 null，不是 0 */
    paidRate: number | null;
    /** 未回收的 core 级伏笔（必须处理） */
    openCore: { id: string; content: string; plantedChapter: number; targetChapter?: number }[];
  };
  characters: CharacterArc[];
  timeline: { events: number; irreversible: number; lastStoryTime: string };
  /** 抽取覆盖率。**所有比率的可信度都取决于它** */
  coverage: { extracted: number; total: number };
  /** 必须处理（不处理就别说完本） */
  blockers: string[];
  /** 提示级（看一下，未必是问题） */
  warnings: string[];
}

export async function buildWrapUpReport(bookRoot: string): Promise<WrapUpReport> {
  const root = path.resolve(bookRoot);
  const [facts, state, ledgerRead, stats] = await Promise.all([
    readFacts(root),
    readState({ bookRoot: root }),
    readForeshadowLedger(root),
    collectStats(root),
  ]);
  const latestChapter = state.chapters.reduce((m, c) => Math.max(m, c.chapterNo), 0);
  const coverage = { extracted: Object.keys(facts.chapters).length, total: state.chapters.length };

  // ── 伏笔 ──
  const fsum = summarizeForeshadows(ledgerRead.ledger);
  const denominator = fsum.total - fsum.abandoned;
  const openCore = ledgerRead.ledger.items
    .filter((i) => i.level === 'core' && (i.status === 'open' || i.status === 'overdue'))
    .map((i) => ({
      id: i.id, content: i.content, plantedChapter: i.plantedChapter,
      ...(i.targetChapter !== undefined ? { targetChapter: i.targetChapter } : {}),
    }));

  // ── 人物成长线 ──
  const order = new Map(state.chapters.map((c) => [c.file, c.chapterNo]));
  const byName = new Map<string, { chapters: number[]; realms: string[]; alive: boolean }>();
  for (const [file, f] of Object.entries(facts.chapters)) {
    const no = order.get(file) ?? 0;
    if (no === 0) continue;
    for (const c of f.characters) {
      const cur = byName.get(c.name) ?? { chapters: [], realms: [], alive: true };
      cur.chapters.push(no);
      if (c.state.realm !== '' && cur.realms.at(-1) !== c.state.realm) cur.realms.push(c.state.realm);
      cur.alive = c.state.alive;
      byName.set(c.name, cur);
    }
  }

  const characters: CharacterArc[] = [...byName.entries()].map(([name, v]) => {
    const sorted = [...v.chapters].sort((a, b) => a - b);
    const first = sorted[0] ?? 0;
    const last = sorted.at(-1) ?? 0;
    const issues: string[] = [];
    // 「断线」= 最后一次出场离末章很远。阈值 20 章：比一整卷短，又不至于每章都报
    if (latestChapter - last >= 20) {
      issues.push(`最后一次出场在第 ${last} 章，离末章（第 ${latestChapter} 章）已 ${latestChapter - last} 章——成长线可能断了`);
    }
    if (!v.alive && last < latestChapter) {
      issues.push(`已被记为死亡（第 ${last} 章），但不在末章——若这是主角/重要角色需确认结局已交代`);
    }
    if (v.realms.length === 1 && sorted.length >= 3) {
      issues.push(`出场 ${sorted.length} 次但境界始终是「${v.realms[0]}」——成长线可能没推进`);
    }
    return {
      name, firstChapter: first, lastChapter: last,
      appearances: sorted.length, realms: v.realms, alive: v.alive, issues,
    };
  }).sort((a, b) => b.appearances - a.appearances);

  // ── 时间线 ──
  let events = 0;
  let irreversible = 0;
  let lastStoryTime = '';
  for (const [file, f] of Object.entries(facts.chapters)) {
    const no = order.get(file) ?? 0;
    if (no === 0) continue;
    for (const t of f.timeline) {
      events += 1;
      if (t.irreversible) irreversible += 1;
      if (t.storyTime !== '') lastStoryTime = t.storyTime;
    }
  }

  // ── 结论 ──
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (coverage.total > 0 && coverage.extracted < coverage.total) {
    blockers.push(
      `抽取只覆盖 ${coverage.extracted}/${coverage.total} 章——**下面所有比率都不可信**。`
        + '先补齐：novel extract --from 1 --to <末章>',
    );
  }
  if (openCore.length > 0) {
    blockers.push(`${openCore.length} 条 **core 级伏笔未回收**（主线断了）：${openCore.map((i) => i.id).join('、')}`);
  }
  // 逾期里排除掉已进 blocker 的 core 条——同一个事实报两遍会让报告变吵
  const overdueNonCore = ledgerRead.ledger.items.filter((i) => i.status === 'overdue' && i.level !== 'core');
  if (overdueNonCore.length > 0) {
    warnings.push(`${overdueNonCore.length} 条非 core 级伏笔已逾期（可放着，但完本前值得看一眼）`);
  }
  const brokenArcs = characters.filter((c) => c.issues.length > 0);
  if (brokenArcs.length > 0) {
    warnings.push(`${brokenArcs.length} 个角色的成长线有疑点（见 characters[].issues）`);
  }
  if (stats.human.feedbackEntries === 0) {
    warnings.push('没有任何人工改稿记录——北极星指标没有数据（不是 0）');
  }

  return {
    bookRoot: root,
    chapters: state.chapters.length,
    words: stats.words,
    foreshadow: {
      total: fsum.total,
      paid: fsum.paid,
      open: fsum.open,
      overdue: fsum.overdue,
      abandoned: fsum.abandoned,
      // ★分母为 0 → null（「一条都没登记」与「回收率 0%」必须形状不同）
      paidRate: denominator <= 0 ? null : Number((fsum.paid / denominator).toFixed(3)),
      openCore,
    },
    characters,
    timeline: { events, irreversible, lastStoryTime },
    coverage,
    blockers,
    warnings,
  };
}
