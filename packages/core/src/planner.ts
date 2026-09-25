import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callLLM, type CallLLMOptions } from './llm.js';
import { readState } from './state.js';
import { readSummaries } from './summaries.js';
import { readFacts } from './extract.js';
import { readPlan, layerFile, hashText } from './plan.js';
import { readBookConfig } from './bookcfg.js';
import type { LLMError } from './types.js';

/**
 * Planner 滚动展开（B-40 / v0.2 M8.3、M8.6）。
 *
 * 治的是什么：一次性把 10 卷的卷纲都「展开」出来，模型只能凭空编——
 * 第 8 卷的卷纲在第 1 卷还没写的时候定，等于**空壳蓝图**：
 * 它看起来像规划，实际是想象，而且后面的章节会被它牵着走。
 *
 * ★三条纪律：
 *
 * 1. **一次只展下一卷**（M8.3）：远卷只留一行标题。
 *    这不是省 token，是**防止把想象当规划**——写着写着故事会变，
 *    三卷之后再展开才是有依据的。
 *
 * 2. **顺序不可反**（M8.6）：先 `reviseCompass`（基于**已写档案**），再 `expandVolume`。
 *    指南针反映的是「实际写成什么样了」，卷纲要基于它展开。
 *    ★这条用**形状**强制，不靠文档提醒：`expandNextVolume` 会检查
 *    「总纲是否在本卷已写内容之后重新校准过」，没校准就拒绝。
 *    靠文档提醒「记得先改指南针」是不够的——忘了不会有任何红灯。
 *
 * 3. **起草只写 `state/drafts/`**，绝不覆盖正式文件（与 `draftLayer` 同一条纪律）。
 *    作者审阅后才改入正式文件并 `confirm`。
 */

const PLANNER_REL = 'state/planner.json';

interface PlannerState {
  schemaVersion: 1;
  bookRoot: string;
  /** 总纲上一次「基于已写档案重新校准」时，已写到第几章 */
  compassRevisedUpToChapter: number;
  compassRevisedAt: string;
}

function plannerPath(root: string): string {
  return path.join(root, PLANNER_REL);
}

async function readPlannerState(root: string): Promise<PlannerState> {
  const empty: PlannerState = {
    schemaVersion: 1, bookRoot: root, compassRevisedUpToChapter: 0, compassRevisedAt: '',
  };
  const raw = await readFile(plannerPath(root), 'utf-8').catch(() => null);
  if (raw === null) return empty;
  try {
    const p = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<PlannerState>;
    if (p.schemaVersion !== 1 || p.bookRoot !== root) return empty;
    return { ...empty, ...p };
  } catch {
    return empty;
  }
}

async function writePlannerState(root: string, st: PlannerState): Promise<void> {
  const target = plannerPath(root);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(st, null, 2) + '\n', 'utf-8');
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

export class PlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerError';
  }
}

/** 已写到的最大章号 */
async function latestWrittenChapter(bookRoot: string): Promise<number> {
  const state = await readState({ bookRoot });
  return state.chapters.reduce((m, c) => Math.max(m, c.chapterNo), 0);
}

export interface NextVolumeInfo {
  /** 下一卷卷号（已登记卷的最大号 + 1；一卷都没登记时为 1） */
  volume: number;
  /** 已登记的卷 */
  knownVolumes: number[];
  /** 已写到的章号 */
  latestWrittenChapter: number;
  /** 展开前是否必须先 reviseCompass */
  needsCompassRevision: boolean;
  why: string;
}

/**
 * 下一卷是哪一卷，以及**能不能直接展开**。
 * 只读——`novel planner next` 用它，`expandNextVolume` 也用它做前置检查。
 */
export async function nextVolume(bookRoot: string): Promise<NextVolumeInfo> {
  const root = path.resolve(bookRoot);
  const [plan, planner, latest] = await Promise.all([
    readPlan(root),
    readPlannerState(root),
    latestWrittenChapter(root),
  ]);
  if (plan === null) {
    throw new PlannerError('本书未开启逐层流程：先运行 novel plan init');
  }
  const known = plan.volumes.map((v) => v.no).sort((a, b) => a - b);
  const volume = known.length === 0 ? 1 : (known.at(-1) as number) + 1;
  const needs = latest > planner.compassRevisedUpToChapter;
  return {
    volume,
    knownVolumes: known,
    latestWrittenChapter: latest,
    needsCompassRevision: needs,
    why: needs
      ? `已写到第 ${latest} 章，而总纲上次校准只到第 ${planner.compassRevisedUpToChapter} 章`
        + '——先 reviseCompass（指南针要反映实际写成什么样了），再展开下一卷。'
      : `总纲已校准到第 ${planner.compassRevisedUpToChapter} 章，覆盖当前进度（第 ${latest} 章）。`,
  };
}

/** 把已写内容的档案拼成参考材料：摘要 + 事实库里的角色/伏笔现状 */
async function buildArchive(root: string): Promise<string> {
  const [state, store, facts] = await Promise.all([
    readState({ bookRoot: root }),
    readSummaries(root),
    readFacts(root),
  ]);
  const parts: string[] = [];

  const written = state.chapters.filter((c) => store.chapters[c.file] !== undefined);
  if (written.length > 0) {
    parts.push('# 已写章节摘要');
    for (const c of written) {
      parts.push(`## 第 ${c.chapterNo} 章 ${c.title}`, (store.chapters[c.file]?.summary ?? '').trim(), '');
    }
  } else {
    parts.push('# 已写章节摘要', '（缺：还没有已生成摘要的章节——跑 novel summarize）', '');
  }

  const order = new Map(state.chapters.map((c) => [c.file, c.chapterNo]));
  const charLines: string[] = [];
  const foreshadowLines: string[] = [];
  for (const [file, f] of Object.entries(facts.chapters)) {
    const no = order.get(file) ?? 0;
    if (no === 0) continue;
    for (const c of f.characters) {
      if (c.state.realm !== '' || c.state.location !== '') {
        charLines.push(`- 第 ${no} 章｜${c.name}：境界 ${c.state.realm || '(未写)'}｜位置 ${c.state.location || '(未写)'}`);
      }
    }
    for (const fs of f.foreshadows) foreshadowLines.push(`- 第 ${no} 章埋：${fs.content}（${fs.level}）`);
  }
  parts.push('# 人物状态（截至最近一次抽取）', charLines.length > 0 ? charLines.join('\n') : '（缺：还没抽取）', '');
  parts.push('# 已埋伏笔', foreshadowLines.length > 0 ? foreshadowLines.join('\n') : '（缺：还没抽取）', '');
  return parts.join('\n');
}

export interface PlannerDraftResult {
  ok: true;
  draftFile: string;
  chars: number;
  /** reviseCompass 之后：总纲已校准到第几章 */
  compassRevisedUpToChapter?: number;
}

const COMPASS_SYSTEM = [
  '你是中文网络小说的主编。根据「已写档案」重新校准全书总纲（markdown）。',
  '必须包含：主线与终局、分卷规划（每卷目标/核心冲突/卷末高潮/大致章数）、贯穿全书的长线伏笔、主角成长节点。',
  '纪律：',
  '- **以已写档案为准**：档案里已经发生的事不要推翻，要把总纲调整成「与已写内容一致」；',
  '- 已写章节里偏离了原总纲的地方，**按已写的来**——那不是错误，是故事自己长出来的；',
  '- 只规划到卷级，不写单章；',
  '- 不确定处写「（待填）」交作者决定。',
].join('\n');

/**
 * 基于**已写档案**重新校准总纲（M8.6 的第一步）。
 *
 * 与 `draftLayer('outline')` 的区别：那个是**初次**起草（只有定位与设定）；
 * 这个是**滚动校准**（有几十章实际写出来的东西可依）。
 * 两者不可互替——初次起草时没有档案，滚动校准时不该从零重想。
 */
export async function reviseCompass(
  bookRoot: string,
  opts: { llm?: CallLLMOptions } = {},
): Promise<PlannerDraftResult | LLMError> {
  const root = path.resolve(bookRoot);
  const plan = await readPlan(root);
  if (plan === null) throw new PlannerError('本书未开启逐层流程：先运行 novel plan init');

  const cfg = await readBookConfig(root);
  const current = cfg === null
    ? ''
    : (await readFile(path.join(root, layerFile('outline')), 'utf-8').catch(() => ''));

  const r = await callLLM(
    {
      system: COMPASS_SYSTEM,
      user: [
        current.trim() !== '' ? `# 当前总纲（${layerFile('outline')}）` : '# 当前总纲\n（缺：还没有总纲文件）',
        current.trim(),
        '',
        '# 已写档案',
        await buildArchive(root),
      ].join('\n'),
      ruleRefs: { author: [], plugin: [] },
    },
    { temperature: 0.3, purpose: 'plan', ...opts.llm },
  );
  if (!r.ok) return r;

  const rel = 'state/drafts/compass.md';
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), r.text.trim() + '\n', 'utf-8');

  const latest = await latestWrittenChapter(root);
  const st = await readPlannerState(root);
  await writePlannerState(root, { ...st, compassRevisedUpToChapter: latest, compassRevisedAt: new Date().toISOString() });

  return { ok: true, draftFile: rel, chars: r.text.length, compassRevisedUpToChapter: latest };
}

const VOLUME_SYSTEM = [
  '你是中文网络小说的主编。根据定位、正典、**已校准的总纲**与**已写档案**，只展开**指定这一卷**的卷纲（markdown）。',
  '必须包含：本卷目标与主冲突、阶段划分（每阶段章数范围与推进点）、爽点分布、本卷埋设与回收的伏笔、卷末钩子。',
  '纪律：',
  '- **只展开这一卷**：不要写其他卷的卷纲（那是空壳蓝图——写着写着故事会变，三卷之后再展开才有依据）；',
  '- 以已写档案为准：主角现在什么境界、在哪、和谁是什么关系，都要与档案一致；',
  '- 不要重复档案里已经发生的情节。',
].join('\n');

/**
 * 展开**下一卷**（M8.3：一次只展一卷）。
 *
 * ★`enforceOrder`（默认 true）：总纲没在本卷已写内容之后重新校准过 → **拒绝**。
 * 这是 M8.6「顺序不可反」的强制点。`false` 只给「我知道自己在干什么」的场景用，
 * 且会在返回值里留痕。
 */
export async function expandNextVolume(
  bookRoot: string,
  opts: { llm?: CallLLMOptions; enforceOrder?: boolean } = {},
): Promise<PlannerDraftResult & { volume: number; orderEnforced: boolean } | LLMError> {
  const root = path.resolve(bookRoot);
  const info = await nextVolume(root);
  const enforce = opts.enforceOrder ?? true;
  if (enforce && info.needsCompassRevision) {
    throw new PlannerError(
      `拒绝展开第 ${info.volume} 卷：${info.why}\n`
        + '  先跑：novel planner compass --book <同一本书>\n'
        + '  （M8.6：先 reviseCompass 再 expandVolume，顺序不可反——'
        + '指南针反映的是「实际写成什么样了」，卷纲要基于它展开。）\n'
        + '  确实要先展开（罕见）：加 --no-enforce-order。',
    );
  }

  const cfg = await readBookConfig(root);
  const read = async (rel: string): Promise<string> =>
    (await readFile(path.join(root, rel), 'utf-8').catch(() => '')).replace(/^\uFEFF/, '');
  const parts: string[] = [];
  const add = (title: string, body: string): void => {
    if (body.trim() !== '') parts.push(`# ${title}`, body.trim(), '');
  };
  add('故事定位', await read(layerFile('position')));
  add('正典', await read(layerFile('setting')));
  add('已校准的总纲', await read(layerFile('outline')));
  if (cfg !== null) {
    // 已确认的卷只给**一行标题**（M8.3：远卷不展开，也不重复喂）
    const plan = await readPlan(root);
    const known = plan?.volumes.map((v) => v.no).sort((a, b) => a - b) ?? [];
    if (known.length > 0) {
      parts.push('# 已展开的卷（只列标题，不要重写）', known.map((n) => `- 第 ${n} 卷：${layerFile('volume', n)}`).join('\n'), '');
    }
  }
  parts.push(`# 任务\n只展开第 ${info.volume} 卷。`, '');
  add('已写档案', await buildArchive(root));

  const r = await callLLM(
    { system: VOLUME_SYSTEM, user: parts.join('\n'), ruleRefs: { author: [], plugin: [] } },
    { temperature: 0.3, purpose: 'plan', ...opts.llm },
  );
  if (!r.ok) return r;

  const rel = `state/drafts/volume-${String(info.volume).padStart(2, '0')}.md`;
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), r.text.trim() + '\n', 'utf-8');
  return { ok: true, draftFile: rel, chars: r.text.length, volume: info.volume, orderEnforced: enforce };
}

/** 某个层是否已确认（`expandNextVolume` 之后要提示作者去确认哪一层） */
export async function layerConfirmed(
  bookRoot: string,
  kind: 'outline' | 'volume',
  volume?: number,
): Promise<boolean> {
  const root = path.resolve(bookRoot);
  const plan = await readPlan(root);
  if (plan === null) return false;
  const key = kind === 'volume' ? `volume-${volume ?? 1}` : kind;
  const rec = plan.layers[key];
  if (rec === undefined) return false;
  const rel = kind === 'volume' ? layerFile('volume', volume ?? 1) : layerFile('outline');
  const text = await readFile(path.join(root, rel), 'utf-8').catch(() => null);
  if (text === null) return false;
  return rec.hash === hashText(text);
}
