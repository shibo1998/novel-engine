import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callLLM, type CallLLMOptions } from './llm.js';
import { readState } from './state.js';
import { contentHash } from './hash.js';
import type { LLMError } from './types.js';

/**
 * Extractor（B-20 / v0.2 M5）：每章抽事实，供长期记忆用。
 *
 * 治的是什么：`now.md` 状态卡（B-01）是**作者手写**的短期过渡方案，
 * 它只能表达「此刻」——想回答「第 20 章时林青的伤好了没」只能翻正文。
 * Extractor 把每章的事实抽出来存成结构化记录，于是这类问题变成一次查询。
 *
 * ★三条纪律（前两条是 B-11 判据层同一套，第三条是本模块独有的）：
 *
 * 1. **每条事实必须带原文引句，且引句要能在本章正文里逐字命中**。
 *    命不中 → **整条丢弃并计入 `dropped`**，不是降级保留。
 *    为什么比 Judge 更严（那里是降 `unsure`）：Judge 的结论是给人看的意见，
 *    而这里抽出的事实会**喂给后续章节的 prompt**。一条编造的事实会像真的一样
 *    被引用、被传播，而且再也查不出源头。**长期记忆里宁可少一条，不可多一条假的。**
 *
 * 2. **事实带 `sourceChapter`**。这是「按章撤回重抽」能成立的前提——
 *    没有来源标记，改了一章就只能全量重抽。
 *
 * 3. **按章覆盖，不按章追加**。`state/facts.json` 以章文件为键，
 *    重抽某一章 = 整体替换该章的记录。追加式会让同一事实在库里堆成多份，
 *    而「哪一份是当前有效的」没人说得清。
 *
 * 指纹绑定与 gateStatus 同款：记 `contentHash`，正文一改该章记录即作废——
 * 过期的记忆不如没有（它会以「事实」的口吻说旧话）。
 */

export interface ExtractedCharacter {
  name: string;
  /** 截至本章的状态快照（B-21 的 history 直接由这些快照组成） */
  state: {
    realm: string;
    location: string;
    /** 本章新知道的（信息边界） */
    knows: string[];
    /** 本章明确不该知道的（悬念来源） */
    ignores: string[];
    relations: { to: string; kind: string }[];
    alive: boolean;
  };
  /** 造成这次变化的原因（本章里发生了什么） */
  cause: string;
  /** 原文引句（已核对逐字命中） */
  evidence: string;
}

export interface ExtractedForeshadow {
  /** 伏笔内容描述。**id 由引擎分配（B-23），抽取层不自造** */
  content: string;
  level: 'minor' | 'major' | 'core';
  /** 埋设章；本章回收的伏笔不在这里，在 paidOff */
  plantedChapter: number;
  /** 本章回收了哪些伏笔（按内容描述指认，B-23 有台账后可换成 id） */
  paidOff: string[];
  evidence: string;
}

export interface ExtractedTimelineEvent {
  /** 故事内时间（正文怎么写就怎么记，不做归一） */
  storyTime: string;
  event: string;
  participants: string[];
  /** 不可逆事件（死亡、身份暴露…）：后续章节不得与之矛盾 */
  irreversible: boolean;
  evidence: string;
}

export interface ChapterFacts {
  /** 抽取时刻 */
  extractedAt: string;
  /** 抽取时该章正文的内容指纹；与当前不符即作废 */
  contentHash: string;
  model: string;
  characters: ExtractedCharacter[];
  foreshadows: ExtractedForeshadow[];
  timeline: ExtractedTimelineEvent[];
  /** 因引句核对不通过而丢弃的条目数（**丢的东西必须可见**） */
  dropped: number;
  /** 模型输出形状不符、被跳过的原始条目（前若干条，供排查） */
  malformed: string[];
}

export interface FactsStore {
  schemaVersion: 1;
  bookRoot: string;
  /** key = 章文件名（与 ChapterIndexEntry.file 同口径） */
  chapters: Record<string, ChapterFacts>;
}

const FACTS_REL = 'state/facts.json';

function factsPath(root: string): string {
  return path.join(root, FACTS_REL);
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
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

async function readStore(root: string): Promise<FactsStore> {
  const raw = await readFile(factsPath(root), 'utf-8').catch(() => null);
  const empty: FactsStore = { schemaVersion: 1, bookRoot: root, chapters: {} };
  if (raw === null) return empty;
  try {
    const parsed = JSON.parse(stripBom(raw)) as FactsStore;
    if (parsed.schemaVersion !== 1 || parsed.bookRoot !== root) return empty;
    return parsed;
  } catch {
    return empty;
  }
}

/**
 * 读事实库，并**清扫过期条目**（指纹不符 / 文件已不在 → 删）。
 * 与 readState 的 gateStatus 清扫同一套语义：内容变了，记忆就该失效。
 */
export async function readFacts(bookRoot: string): Promise<FactsStore> {
  const root = path.resolve(bookRoot);
  const store = await readStore(root);
  for (const [file, facts] of Object.entries(store.chapters)) {
    const raw = await readFile(path.join(root, 'chapters', file), 'utf-8').catch(() => null);
    if (raw === null || contentHash(stripBom(raw)) !== facts.contentHash) delete store.chapters[file];
  }
  return store;
}

/** 引句是否能在正文里逐字命中（去空白兜底一次，容忍模型复述时改换行缩进） */
export function evidenceFound(quote: string, chapterText: string): boolean {
  const q = quote.trim();
  if (q === '') return false;
  if (chapterText.includes(q)) return true;
  return chapterText.replace(/\s/g, '').includes(q.replace(/\s/g, ''));
}

const LEVELS = new Set(['minor', 'major', 'core']);

/** 从模型输出里抠 JSON；容忍围栏与前后废话 */
function extractJson(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export interface ParseFactsResult {
  characters: ExtractedCharacter[];
  foreshadows: ExtractedForeshadow[];
  timeline: ExtractedTimelineEvent[];
  dropped: number;
  malformed: string[];
}

/**
 * 解析并**逐条核对引句**。纯函数，可脱离模型测试——这是本模块最要紧的一段逻辑。
 *
 * 引句命不中 → 整条丢弃（不降级保留）。理由见文件头纪律 1。
 */
export function parseFacts(text: string, chapterText: string, chapterNo: number): ParseFactsResult {
  const json = extractJson(text);
  const out: ParseFactsResult = { characters: [], foreshadows: [], timeline: [], dropped: 0, malformed: [] };
  if (json === null) {
    out.malformed.push('整体输出不是可解析的 JSON');
    return out;
  }

  for (const raw of Array.isArray(json['characters']) ? (json['characters'] as unknown[]) : []) {
    const o = raw as Record<string, unknown>;
    const name = str(o['name']);
    const evidence = str(o['evidence']);
    if (name === '' || !evidenceFound(evidence, chapterText)) {
      out.dropped += 1;
      out.malformed.push(`角色「${name || '(无名)'}」：${name === '' ? '缺 name' : '引句未命中正文'}`);
      continue;
    }
    const st = (typeof o['state'] === 'object' && o['state'] !== null ? o['state'] : {}) as Record<string, unknown>;
    const rel = Array.isArray(st['relations']) ? (st['relations'] as unknown[]) : [];
    out.characters.push({
      name,
      state: {
        realm: str(st['realm']),
        location: str(st['location']),
        knows: strArray(st['knows']),
        ignores: strArray(st['ignores']),
        relations: rel
          .map((r) => r as Record<string, unknown>)
          .filter((r) => str(r['to']) !== '')
          .map((r) => ({ to: str(r['to']), kind: str(r['kind']) })),
        // 缺省 true：**「没写死」不等于「死了」**。默认 false 会让每个没提到的角色都被判死
        alive: typeof st['alive'] === 'boolean' ? st['alive'] : true,
      },
      cause: str(o['cause']),
      evidence,
    });
  }

  for (const raw of Array.isArray(json['foreshadows']) ? (json['foreshadows'] as unknown[]) : []) {
    const o = raw as Record<string, unknown>;
    const content = str(o['content']);
    const evidence = str(o['evidence']);
    if (content === '' || !evidenceFound(evidence, chapterText)) {
      out.dropped += 1;
      out.malformed.push(`伏笔「${content || '(空)'}」：${content === '' ? '缺 content' : '引句未命中正文'}`);
      continue;
    }
    const lv = str(o['level'], 'minor');
    out.foreshadows.push({
      content,
      level: LEVELS.has(lv) ? (lv as ExtractedForeshadow['level']) : 'minor',
      plantedChapter: typeof o['plantedChapter'] === 'number' ? o['plantedChapter'] : chapterNo,
      paidOff: strArray(o['paidOff']),
      evidence,
    });
  }

  for (const raw of Array.isArray(json['timeline']) ? (json['timeline'] as unknown[]) : []) {
    const o = raw as Record<string, unknown>;
    const event = str(o['event']);
    const evidence = str(o['evidence']);
    if (event === '' || !evidenceFound(evidence, chapterText)) {
      out.dropped += 1;
      out.malformed.push(`时间线「${event || '(空)'}」：${event === '' ? '缺 event' : '引句未命中正文'}`);
      continue;
    }
    out.timeline.push({
      storyTime: str(o['storyTime']),
      event,
      participants: strArray(o['participants']),
      irreversible: o['irreversible'] === true,
      evidence,
    });
  }

  return out;
}

const SYSTEM = [
  '你是中文长篇小说的事实抽取员。**只记录正文明确写了的东西**，不做推测、不做总结、不评价。',
  '',
  '输出格式（只输出 JSON，不要任何解释文字、不要 markdown 围栏）：',
  '{"characters":[{"name":"","state":{"realm":"","location":"","knows":[],"ignores":[],"relations":[{"to":"","kind":""}],"alive":true},"cause":"","evidence":""}],',
  ' "foreshadows":[{"content":"","level":"minor|major|core","plantedChapter":0,"paidOff":[],"evidence":""}],',
  ' "timeline":[{"storyTime":"","event":"","participants":[],"irreversible":false,"evidence":""}]}',
  '',
  '纪律：',
  '- `evidence` 必须是从本章正文里**逐字复制**的一句，不要改写、不要拼接、不要自己造句；',
  '- 正文没写的一律不填：不知道就留空串或空数组，**不要推测**；',
  '- `state` 记的是**截至本章结束时**的状态（境界/位置/生死/关系/信息边界）；',
  '- `ignores` 记「本章明确显示他还不知道」的事——这是悬念的来源，值得记；',
  '- `alive` 缺省 true；只有正文写了死亡才填 false；',
  '- 本章没有的角色不要出现；没有伏笔/时间线就给空数组。',
].join('\n');

export interface ExtractOptions {
  bookRoot: string;
  chapterNo: number;
  llm?: CallLLMOptions;
}

/**
 * 抽取结果。**成功侧显式包一层 `{ok:true, facts}`**，而不是直接返回 ChapterFacts：
 * `ChapterFacts | LLMError` 判别不了——`LLMError` 有 `ok:false`，而 ChapterFacts 压根
 * 没有 `ok` 字段，`'ok' in r` 对成功是 false、对失败是 true，读代码的人很容易写反
 * （本模块第一版测试就是这么写错的）。与 `judgeChapter` 用同一套形状。
 */
export type ExtractResult = { ok: true; facts: ChapterFacts } | LLMError;

/**
 * 抽一章的事实并落盘（覆盖该章的旧记录 = 按章撤回重抽）。
 * LLM 失败 → 原样返回失败 union，**不写任何文件**。
 */
export async function extractChapter(o: ExtractOptions): Promise<ExtractResult> {
  const root = path.resolve(o.bookRoot);
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((c) => c.chapterNo === o.chapterNo);
  if (entry === undefined) throw new Error(`extractChapter：第 ${o.chapterNo} 章不在索引中`);
  const text = stripBom(await readFile(path.join(root, 'chapters', entry.file), 'utf-8'));

  const r = await callLLM({
    system: SYSTEM,
    user: [`# 待抽取正文（第 ${o.chapterNo} 章，${entry.file}）`, text.trim()].join('\n'),
    ruleRefs: { author: [], plugin: [] },
  }, { temperature: 0.2, ...o.llm });
  if (!r.ok) return r;

  const parsed = parseFacts(r.text, text, o.chapterNo);
  const facts: ChapterFacts = {
    extractedAt: new Date().toISOString(),
    contentHash: contentHash(text),
    model: process.env['LLM_MODEL'] ?? '(未知)',
    ...parsed,
  };

  const store = await readStore(root);
  store.chapters[entry.file] = facts;
  await atomicWrite(factsPath(root), JSON.stringify(store, null, 2) + '\n');
  return { ok: true, facts };
}

/**
 * 撤回某一章的事实（B-20 的「按章撤回」）。
 * 返回被撤回的那条（没有则 null）。**不重抽**——重抽是调用方的事，
 * 这样「撤回」在模型不可用时也能用（改设定时常常要先撤回再批量重抽）。
 */
export async function rollbackChapterFacts(bookRoot: string, chapterNo: number): Promise<ChapterFacts | null> {
  const root = path.resolve(bookRoot);
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((c) => c.chapterNo === chapterNo);
  if (entry === undefined) throw new Error(`rollbackChapterFacts：第 ${chapterNo} 章不在索引中`);
  const store = await readStore(root);
  const prev = store.chapters[entry.file] ?? null;
  if (prev === null) return null;
  delete store.chapters[entry.file];
  await atomicWrite(factsPath(root), JSON.stringify(store, null, 2) + '\n');
  return prev;
}

/**
 * 「截至第 N 章」的人物状态（B-20 的产出，B-21 的基础）。
 *
 * 合并规则：**按章号从小到大取每人的最新快照**。
 * 这不是「完整历史」——完整历史是 B-21 的 history 字段；
 * 这里只回答「写到第 N 章为止，某人是什么状态」，用于重写旧章。
 */
export function characterStateUpTo(
  store: FactsStore,
  chapterNo: number,
  states: { file: string; chapterNo: number }[],
): Map<string, { state: ExtractedCharacter['state']; cause: string; atChapter: number }> {
  const order = new Map(states.map((s) => [s.file, s.chapterNo]));
  const entries = Object.entries(store.chapters)
    .map(([file, facts]) => ({ file, facts, no: order.get(file) ?? 0 }))
    .filter((e) => e.no > 0 && e.no <= chapterNo)
    .sort((a, b) => a.no - b.no);

  const out = new Map<string, { state: ExtractedCharacter['state']; cause: string; atChapter: number }>();
  for (const { facts, no } of entries) {
    for (const c of facts.characters) out.set(c.name, { state: c.state, cause: c.cause, atChapter: no });
  }
  return out;
}
