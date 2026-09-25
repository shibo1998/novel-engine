import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callLLM } from './llm.js';
import { contentHash } from './hash.js';
import type { LLMResult } from './types.js';

/**
 * 逐层建书（B-10，v0.2 M8.0）：定位 → 设定 → 总纲 → 卷纲 → 细纲 → 章节。
 *
 * 纪律：
 * - 每层产物是**作者可读可改的文件**；LLM 起草只写到 state/drafts/，绝不覆盖正式文件。
 * - 「确认」= 作者对当前文件内容签字：记下 contentHash。之后文件被改 → 该层回到「待确认」。
 * - 上层在下层之后被重新确认 → 下层标「待复核」（stale），不自动重写。
 * - 闸门只对**有 .soloent/plan.json 的书**生效：旧书（没走过逐层流程）不被连坐。
 */

export type LayerKind = 'position' | 'setting' | 'outline' | 'volume' | 'detail';

export interface LayerConfirm {
  file: string;          // 相对 bookRoot
  hash: string;
  confirmedAt: string;
}

export interface PlanVolume {
  no: number;
  fromChapter: number;
  toChapter: number;
}

export interface PlanFile {
  schemaVersion: 1;
  /** key：position / setting / outline / volume-N / detail-N */
  layers: Record<string, LayerConfirm>;
  volumes: PlanVolume[];
}

export type LayerStatus = 'missing' | 'placeholder' | 'unconfirmed' | 'confirmed' | 'stale';

export interface LayerReport {
  key: string;
  kind: LayerKind;
  file: string;
  status: LayerStatus;
  /** stale 时说明是哪个上游层在本层确认之后被重新确认 */
  staleBecause?: string;
}

export const LAYER_ORDER: LayerKind[] = ['position', 'setting', 'outline', 'volume', 'detail'];

export const LAYER_LABEL: Record<LayerKind, string> = {
  position: '定位',
  setting: '设定',
  outline: '总纲',
  volume: '卷纲',
  detail: '细纲',
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 各层正式文件（相对 bookRoot）。setting 沿用现有 canon.md，不另起文件 */
export function layerFile(kind: LayerKind, volume?: number): string {
  switch (kind) {
    case 'position': return 'book/premise.md';
    case 'setting': return '.soloent/canon.md';
    case 'outline': return 'outline/总纲.md';
    case 'volume': return `outline/vol-${pad2(volume ?? 1)}.md`;
    case 'detail': return `outline/vol-${pad2(volume ?? 1)}-细纲.md`;
  }
}

export function layerKey(kind: LayerKind, volume?: number): string {
  return kind === 'volume' || kind === 'detail' ? `${kind}-${volume ?? 1}` : kind;
}

/** 定位层问答题目（v0.2 M8.0 第 1 层）。id 即 premise.md 的小节键 */
export const POSITION_QUESTIONS: { id: string; question: string; hint: string }[] = [
  { id: 'genre', question: '题材/类型', hint: '如：玄幻-高武、都市-系统、历史-穿越' },
  { id: 'platform', question: '目标平台', hint: '番茄 / 起点 / 七猫 …' },
  { id: 'reader', question: '目标读者', hint: '男频/女频、年龄段、偏爽文还是偏剧情' },
  { id: 'logline', question: '一句话故事', hint: '谁 + 想要什么 + 阻碍是什么' },
  { id: 'protagonist', question: '主角设定', hint: '出身、性格、核心缺陷、成长方向' },
  { id: 'cheat', question: '金手指/核心设定', hint: '主角的独特优势及其限制；没有就写「无」' },
  { id: 'tone', question: '基调与文风', hint: '轻松/热血/压抑/幽默；叙述视角；句子长短' },
  { id: 'selling', question: '核心卖点/爽点方向', hint: '读者为什么追：打脸、升级、智斗、经营…' },
  { id: 'scale', question: '篇幅规划', hint: '总字数、预计卷数、每章字数' },
  { id: 'ending', question: '结局方向', hint: '大致终点，可粗略' },
  { id: 'benchmark', question: '对标书（可选）', hint: '想接近的作品及学它哪一点' },
  { id: 'redline', question: '禁区（可选）', hint: '不写什么：题材红线、个人雷点' },
];

const PLACEHOLDER = /[（(]待填[）)]/;

function stripBom(t: string): string {
  return t.replace(/^﻿/, '');
}

export function hashText(text: string): string {
  return contentHash(text);
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

const planPath = (root: string): string => path.join(root, '.soloent', 'plan.json');

/** 没有 plan.json → null（旧书，不参与逐层闸门） */
export async function readPlan(bookRoot: string): Promise<PlanFile | null> {
  const raw = await readFile(planPath(path.resolve(bookRoot)), 'utf-8').catch(() => null);
  if (raw === null) return null;
  const parsed = JSON.parse(stripBom(raw)) as PlanFile;
  if (parsed.schemaVersion !== 1) throw new Error(`plan.json schemaVersion 不支持：${String(parsed.schemaVersion)}`);
  return parsed;
}

async function writePlan(bookRoot: string, plan: PlanFile): Promise<void> {
  await atomicWrite(planPath(path.resolve(bookRoot)), JSON.stringify(plan, null, 2) + '\n');
}

/** 开启逐层流程：建空 plan.json（已存在则原样返回） */
export async function initPlan(bookRoot: string): Promise<PlanFile> {
  const existing = await readPlan(bookRoot);
  if (existing !== null) return existing;
  const plan: PlanFile = { schemaVersion: 1, layers: {}, volumes: [] };
  await writePlan(bookRoot, plan);
  return plan;
}

/**
 * 定位问答 → `book.json` 的 `book` 段（B-58）。
 *
 * 为什么必须同步：v0.2 M8.0 的表格写明定位层的产物是
 * **`book.json` 的 book 段 + `book/premise.md`** 两样。只写 premise.md 的话，
 * 「题材/平台/目标读者」这些被问过一遍的东西仍要作者手改 book.json——
 * 问答的意义（一次问全、只填一处）就没了，而且两处会漂移。
 *
 * 值取「题目 id → book 段键名」。**不认识的 id 不写**（问答表以后加题不会误塞进 book 段）。
 */
const POSITION_TO_BOOK_META: Record<string, string> = {
  genre: 'genre',
  platform: 'platform',
  reader: 'audience',
  tone: 'tone',
  selling: 'sellingPoint',
  scale: 'scale',
  ending: 'ending',
};

/**
 * 把定位答案同步进 book.json 的 book 段。
 * 保留原有键与 BOM；文件不存在/坏 → 跳过（premise.md 已落盘，不该因为 book.json 坏就整体失败）。
 * 返回写进去的键名，供 CLI 如实报告。
 */
async function syncBookMeta(root: string, answers: Record<string, string>): Promise<string[]> {
  const cfgPath = path.join(root, '.soloent', 'book.json');
  const raw = await readFile(cfgPath, 'utf-8').catch(() => null);
  if (raw === null) return [];
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(stripBom(raw)) as Record<string, unknown>;
  } catch {
    return [];
  }
  const hadBom = raw.startsWith('\uFEFF');
  const book = { ...((cfg['book'] ?? {}) as Record<string, unknown>) };
  const written: string[] = [];
  for (const [id, key] of Object.entries(POSITION_TO_BOOK_META)) {
    const v = (answers[id] ?? '').trim();
    if (v === '') continue;
    book[key] = v;
    written.push(key);
  }
  if (written.length === 0) return [];
  cfg['book'] = book;
  await atomicWrite(cfgPath, (hadBom ? '\uFEFF' : '') + JSON.stringify(cfg, null, 2) + '\n');
  return written;
}

/** 把定位问答写成 premise.md（正式文件；由问答直接产生，不经 LLM），并同步 book.json 的 book 段 */
export async function writePosition(bookRoot: string, answers: Record<string, string>): Promise<string> {
  const root = path.resolve(bookRoot);
  const missing = POSITION_QUESTIONS
    .filter((q) => !q.question.includes('可选'))
    .filter((q) => (answers[q.id] ?? '').trim() === '')
    .map((q) => q.question);
  if (missing.length > 0) throw new Error(`定位问答缺必答项：${missing.join('、')}`);
  const lines = ['# 故事定位', ''];
  for (const q of POSITION_QUESTIONS) {
    lines.push(`## ${q.question}`, '', (answers[q.id] ?? '').trim() || '（无）', '');
  }
  const rel = layerFile('position');
  await atomicWrite(path.join(root, rel), lines.join('\n'));
  // 先落 premise.md 再同步 book 段：premise.md 是**真相源**，
  // book 段是它的投影。反过来的话，book.json 坏掉会连 premise.md 都写不出来。
  await syncBookMeta(root, answers);
  return rel;
}

function upstreamKeys(kind: LayerKind, volume?: number): string[] {
  switch (kind) {
    case 'position': return [];
    case 'setting': return ['position'];
    case 'outline': return ['position', 'setting'];
    case 'volume': return ['position', 'setting', 'outline'];
    case 'detail': return ['position', 'setting', 'outline', layerKey('volume', volume)];
  }
}

async function inspect(root: string, plan: PlanFile, kind: LayerKind, volume?: number): Promise<LayerReport> {
  const key = layerKey(kind, volume);
  const file = layerFile(kind, volume);
  const text = await readFile(path.join(root, file), 'utf-8').catch(() => null);
  const base = { key, kind, file };
  if (text === null || stripBom(text).trim() === '') return { ...base, status: 'missing' };
  if (PLACEHOLDER.test(text)) return { ...base, status: 'placeholder' };
  const c = plan.layers[key];
  if (c === undefined || c.hash !== hashText(text)) return { ...base, status: 'unconfirmed' };
  for (const up of upstreamKeys(kind, volume)) {
    const u = plan.layers[up];
    if (u !== undefined && u.confirmedAt > c.confirmedAt) return { ...base, status: 'stale', staleBecause: up };
  }
  return { ...base, status: 'confirmed' };
}

/** 全部层的状态。卷纲/细纲按 plan.volumes 列出；一卷都没登记时列出第 1 卷 */
export async function planStatus(bookRoot: string): Promise<{ enabled: boolean; layers: LayerReport[]; next: string | null }> {
  const root = path.resolve(bookRoot);
  const plan = await readPlan(root);
  if (plan === null) return { enabled: false, layers: [], next: null };
  const vols = plan.volumes.length > 0 ? plan.volumes.map((v) => v.no) : [1];
  const layers: LayerReport[] = [];
  for (const kind of ['position', 'setting', 'outline'] as LayerKind[]) layers.push(await inspect(root, plan, kind));
  for (const v of vols) {
    layers.push(await inspect(root, plan, 'volume', v));
    layers.push(await inspect(root, plan, 'detail', v));
  }
  const pending = layers.find((l) => l.status !== 'confirmed');
  return { enabled: true, layers, next: pending === undefined ? null : pending.key };
}

export class PlanLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanLayerError';
  }
}

/**
 * 作者确认某层。前置：上游层全部 confirmed；本层文件存在且无「待填」。
 * 卷纲确认必须给章节范围（登记进 plan.volumes，闸门据此判定某章属于哪卷）。
 * 细纲确认后把 book.json 的 paths.outline 指向该卷细纲（readiness 由此读到细纲）。
 */
export async function confirmLayer(
  bookRoot: string,
  kind: LayerKind,
  opts: { volume?: number; chapters?: { from: number; to: number } } = {},
): Promise<LayerReport & { hash: string }> {
  const root = path.resolve(bookRoot);
  const plan = await readPlan(root);
  if (plan === null) throw new PlanLayerError('本书未开启逐层流程：先运行 novel plan init');
  const volume = opts.volume ?? 1;
  for (const up of upstreamKeys(kind, volume)) {
    const [k, v] = up.split('-') as [LayerKind, string | undefined];
    const r = await inspect(root, plan, k, v === undefined ? undefined : Number(v));
    if (r.status !== 'confirmed') {
      throw new PlanLayerError(`上游层「${up}」状态为 ${r.status}，须先确认（${r.file}）`);
    }
  }
  const file = layerFile(kind, volume);
  const text = await readFile(path.join(root, file), 'utf-8').catch(() => null);
  if (text === null || stripBom(text).trim() === '') throw new PlanLayerError(`文件不存在或为空：${file}`);
  if (PLACEHOLDER.test(text)) throw new PlanLayerError(`文件仍含「（待填）」：${file}`);

  if (kind === 'volume') {
    const ch = opts.chapters;
    if (ch === undefined || !(ch.from >= 1 && ch.to >= ch.from)) {
      throw new PlanLayerError('确认卷纲须给出本卷章节范围，如 --chapters 1-60');
    }
    const clash = plan.volumes.find((v) => v.no !== volume && !(ch.to < v.fromChapter || ch.from > v.toChapter));
    if (clash !== undefined) throw new PlanLayerError(`章节范围与第 ${clash.no} 卷重叠`);
    plan.volumes = [...plan.volumes.filter((v) => v.no !== volume), { no: volume, fromChapter: ch.from, toChapter: ch.to }]
      .sort((a, b) => a.no - b.no);
  }

  const key = layerKey(kind, volume);
  plan.layers[key] = { file, hash: hashText(text), confirmedAt: new Date().toISOString() };
  await writePlan(root, plan);

  if (kind === 'detail') {
    const cfgPath = path.join(root, '.soloent', 'book.json');
    const raw = await readFile(cfgPath, 'utf-8');
    const hadBom = raw.startsWith('\uFEFF');
    const cfg = JSON.parse(stripBom(raw)) as { paths?: Record<string, unknown> };
    cfg.paths = { ...(cfg.paths ?? {}), outline: file };
    await atomicWrite(cfgPath, (hadBom ? '\uFEFF' : '') + JSON.stringify(cfg, null, 2) + '\n');
  }
  // 回传本次签下的指纹：确认动作的**凭据**就是它，作者据此核对「我签的是不是这一版」
  const report = await inspect(root, plan, kind, volume);
  return { ...report, hash: plan.layers[key]?.hash ?? '' };
}

export interface PlanGateReport {
  enabled: boolean;
  ready: boolean;
  volume: number | null;
  blocking: string[];
}

/** 写第 N 章前的逐层闸门。未开启逐层流程的书恒为 ready（不连坐旧书） */
export async function checkPlanGate(bookRoot: string, chapterNo: number): Promise<PlanGateReport> {
  const root = path.resolve(bookRoot);
  const plan = await readPlan(root);
  if (plan === null) return { enabled: false, ready: true, volume: null, blocking: [] };
  const vol = plan.volumes.find((v) => chapterNo >= v.fromChapter && chapterNo <= v.toChapter);
  const blocking: string[] = [];
  for (const kind of ['position', 'setting', 'outline'] as LayerKind[]) {
    const r = await inspect(root, plan, kind);
    if (r.status !== 'confirmed') blocking.push(`${LAYER_LABEL[kind]}（${r.file}）：${r.status}`);
  }
  if (vol === undefined) {
    blocking.push(`第 ${chapterNo} 章不属于任何已确认的卷：先写并确认该卷卷纲（novel plan confirm --layer volume --chapters a-b）`);
  } else {
    for (const kind of ['volume', 'detail'] as LayerKind[]) {
      const r = await inspect(root, plan, kind, vol.no);
      if (r.status !== 'confirmed') blocking.push(`第 ${vol.no} 卷${LAYER_LABEL[kind]}（${r.file}）：${r.status}`);
    }
  }
  return { enabled: true, ready: blocking.length === 0, volume: vol?.no ?? null, blocking };
}

/**
 * 逐层蓝图未就绪：**故意**不继承普通 Error 的语义——调用方据此区分
 * 「蓝图还没确认」（作者该去做的事）与「程序出错」（该排查的事）。
 */
export class PlanNotReadyError extends Error {
  constructor(readonly report: PlanGateReport) {
    super(
      '逐层蓝图未就绪，已拒绝开始生成。\n'
        + report.blocking.map((b) => `  · ${b}`).join('\n')
        + '\n  逐层递进：每层经作者确认后才解锁下一层。查看现状与下一层：\n'
        + '    novel plan status --book <书目录>\n'
        + '  确认某层（改完正式文件再确认，确认即对当前内容签字）：\n'
        + '    novel plan confirm --book <书目录> --layer position\n'
        + '  卷纲确认须给章节范围：--layer volume --volume 1 --chapters 1-60',
    );
    this.name = 'PlanNotReadyError';
  }
}

/**
 * 断言逐层蓝图就绪；未就绪抛 PlanNotReadyError。
 *
 * 用途：所有**会产生新正文**的入口在动手之前调用它（与 assertStyleReady 同一位置、同一理由）。
 * 为什么必须有这道门：逐层流程的意义就是「上层没定就不许往下写」；没有这道门，
 * plan.json 就只是一份谁都不看的记录，与「有守卫」和「没守卫」在行为上完全一样
 * ——本项目已多次吃过「守卫在但不生效」的亏。
 *
 * ★不连坐旧书：没有 .soloent/plan.json 的书恒为就绪（enabled=false）。
 */
export async function assertPlanReady(bookRoot: string, chapterNo: number): Promise<PlanGateReport> {
  const report = await checkPlanGate(bookRoot, chapterNo);
  if (report.enabled && !report.ready) throw new PlanNotReadyError(report);
  return report;
}

const DRAFT_SYSTEM: Record<Exclude<LayerKind, 'position'>, string> = {
  setting: [
    '你是中文网络小说的设定策划。根据「故事定位」起草本书的正典速查表（markdown）。',
    '必须包含：世界观与时代背景、力量/能力体系（等级与代价）、主要势力、核心人物表（姓名/身份/性格/目标/与主角关系）、关键数值与专有名词。',
    '只写定位里能推出或必要的设定，不堆砌；不确定处写「（待填）」交作者决定。',
  ].join('\n'),
  outline: [
    '你是中文网络小说的主编。根据「故事定位」与「正典」起草全书总纲（markdown）。',
    '必须包含：主线与终局、分卷规划（每卷目标、核心冲突、卷末高潮、大致章数）、贯穿全书的长线伏笔、主角成长节点。',
    '只规划到卷级，不写单章。',
  ].join('\n'),
  volume: [
    '你是中文网络小说的主编。根据定位、正典、总纲，只展开**指定这一卷**的卷纲（markdown）。',
    '必须包含：本卷目标与主冲突、阶段划分（每阶段章数范围与推进点）、爽点分布、本卷埋设与回收的伏笔、卷末钩子。',
    '不要展开其他卷。',
  ].join('\n'),
  detail: [
    '你是中文网络小说的细纲作者。根据卷纲为本卷**逐章**写细纲（markdown）。',
    '每章单独一行，行首是阿拉伯数字章号加空格（现有读取器按此定位本章），格式：',
    '`N 标题：本章目标；主要冲突；爽点 ｜钩子·类型：钩子内容`',
    '钩子类型取：悬念/危机/反转/揭示/期待/情绪/承诺；相邻章节钩子类型避免重复。章号与给定范围一致，不得跳号。',
  ].join('\n'),
};

/**
 * LLM 起草某层，写到 state/drafts/<key>.md（派生物，可随时丢弃）。
 * **不写正式文件**：作者审阅后自行复制/修改到正式文件，再 confirm。
 */
export async function draftLayer(
  bookRoot: string,
  kind: Exclude<LayerKind, 'position'>,
  opts: { volume?: number; note?: string } = {},
): Promise<LLMResult & { draftFile?: string }> {
  const root = path.resolve(bookRoot);
  const plan = await readPlan(root);
  if (plan === null) throw new PlanLayerError('本书未开启逐层流程：先运行 novel plan init');
  const volume = opts.volume ?? 1;
  for (const up of upstreamKeys(kind, volume)) {
    const [k, v] = up.split('-') as [LayerKind, string | undefined];
    const r = await inspect(root, plan, k, v === undefined ? undefined : Number(v));
    if (r.status !== 'confirmed') throw new PlanLayerError(`上游层「${up}」未确认，不能起草「${layerKey(kind, volume)}」`);
  }
  const read = async (rel: string): Promise<string> => stripBom(await readFile(path.join(root, rel), 'utf-8').catch(() => ''));
  const parts: string[] = [];
  const add = (title: string, body: string): void => {
    if (body.trim() !== '') parts.push(`# ${title}`, body.trim(), '');
  };
  add('故事定位', await read(layerFile('position')));
  if (kind !== 'setting') add('正典', await read(layerFile('setting')));
  if (kind === 'volume' || kind === 'detail') add('总纲', await read(layerFile('outline')));
  if (kind === 'detail') {
    add(`第 ${volume} 卷卷纲`, await read(layerFile('volume', volume)));
    const v = plan.volumes.find((x) => x.no === volume);
    if (v !== undefined) parts.push(`本卷章节范围：第 ${v.fromChapter}–${v.toChapter} 章`, '');
  }
  if (kind === 'volume') parts.push(`# 任务\n只展开第 ${volume} 卷。`, '');
  if (opts.note !== undefined && opts.note.trim() !== '') add('作者补充要求', opts.note);

  const r = await callLLM({ system: DRAFT_SYSTEM[kind], user: parts.join('\n'), ruleRefs: { author: [], plugin: [] } });
  if (!r.ok) return r;
  const rel = `state/drafts/${layerKey(kind, volume)}.md`;
  await atomicWrite(path.join(root, rel), r.text.trim() + '\n');
  return { ...r, draftFile: rel };
}
