import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { callLLM, type CallLLMOptions } from './llm.js';
import { readState } from './state.js';
import { cfgSection, readBookConfig } from './bookcfg.js';
import type { GateFinding, LLMError } from './types.js';

/**
 * 定点修订（B-12）：按 `quote` 局部重写，而不是让模型整章重写。
 *
 * 为什么要有这一步：整章重写是**不可控**的——模型会把没问题的段落一起改写，
 * 上一轮刚过闸的地方可能被改坏，于是「改一处、坏两处」，收敛循环空转。
 * 定点修订把改动限制在**已有引句定位的那几句**上，其它段落一个字符都不动。
 *
 * ★三条守卫（都对应一类真实翻车）：
 * 1. **引句必须能在正文里定位到**，定位不到 → 跳过并报出来（复用 B-11 的防幻觉纪律）。
 * 2. **替换文本为空 → 跳过**。模型返回空串的意图可能是「删掉这句」，
 *    而静默删正文是不可逆的破坏；要删得由人来做。
 * 3. **改动量有上限**（条数 + 字符占比）。超了就整批放弃并如实报告——
 *    那已经不是「定点」而是「重写」，该走整章重写那条路，而不是伪装成定点。
 */

export interface QuotePatch {
  quote: string;
  replacement: string;
  reason: string;
}

export interface SkippedPatch extends QuotePatch {
  /** 跳过原因（人类可读） */
  why: string;
}

export interface ReviseByQuoteResult {
  ok: true;
  /** 修订后的全文 */
  text: string;
  applied: QuotePatch[];
  skipped: SkippedPatch[];
  /** 因超过改动量上限而整批放弃时给出原因；正常为 null */
  rejected: string | null;
}

export interface ReviseByQuoteOptions {
  bookRoot: string;
  chapterNo: number;
  /** 待修问题。只有带 `detail`（引句）的才可能被定点修 */
  findings: GateFinding[];
  /**
   * 作者在收敛过程中投递的指令（B-71）。
   *
   * ★与 findings 的区别：findings 是**检查发现的问题**（有引句、可定位）；
   * 这里是**作者的意图**（"把这段写得更冷"），没有引句，模型得自己找落点。
   * 所以它们只作为**提示**进 prompt，不做定位校验——引句守卫仍然兜底
   * （模型编出来的引句会被跳过），不会因此改坏正文。
   *
   * 为什么默认没有：steer 是 B-71 才接上的能力，老调用方不该被要求传新参数。
   */
  authorInstructions?: string[];
  /** 单次最多接受多少条补丁 */
  maxPatches?: number;
  /** 被替换字符数占全文的比例上限 */
  maxReplacedRatio?: number;
  llm?: CallLLMOptions;
  signal?: AbortSignal;
}

const DEFAULT_MAX_PATCHES = 12;
const DEFAULT_MAX_REPLACED_RATIO = 0.5;

export interface ReviseConfig {
  maxPatches?: number;
  maxReplacedRatio?: number;
}

/**
 * 从 `book.json` 的 `revise` 段读改动量上限（B-68）。
 *
 * 为什么可配：上限本身是**作者的口味**——有人愿意让模型一次多改几句，
 * 有人宁可多跑几轮。写死在代码里，作者唯一的办法是改源码重编译。
 *
 * 为什么默认值仍然保守（12 条 / 50%）：超了就不是「定点」而是「重写」，
 * 该走整章重写那条路。**没给真书数据之前不猜阈值**——先按默认跑，
 * 拿 B-64 的标定结果再决定默认值要不要动。
 *
 * 非法值（负数/NaN/非数字）一律当「没配」，回退默认；不抛错——
 * 一个手滑的配置不该让整章生成失败。
 */
export async function readReviseConfig(bookRoot: string): Promise<ReviseConfig> {
  const c = await readBookConfig(bookRoot);
  if (c === null) return {};
  const sec = cfgSection(c.cfg, 'revise');
  const num = (k: string): number | undefined => {
    const v = sec[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const maxPatches = num('maxPatches');
  const maxReplacedRatio = num('maxReplacedRatio');
  return {
    ...(maxPatches !== undefined ? { maxPatches } : {}),
    ...(maxReplacedRatio !== undefined ? { maxReplacedRatio } : {}),
  };
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/**
 * 在正文里定位引句。先逐字找；失败再去空白回映射（容忍模型复述时改换行/缩进）。
 * 返回**正文里的真实区间**——替换必须作用在真实区间上，不能用模型给的那串字面量，
 * 否则去空白匹配成功后无从下手。
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (q === '') return null;
  const exact = text.indexOf(q);
  if (exact !== -1) return { start: exact, end: exact + q.length };

  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i] as string)) positions.push(i);
  }
  const flat = text.replace(/\s/g, '');
  const flatQuote = q.replace(/\s/g, '');
  if (flatQuote === '') return null;
  const at = flat.indexOf(flatQuote);
  if (at === -1) return null;
  const start = positions[at];
  const end = positions[at + flatQuote.length - 1];
  if (start === undefined || end === undefined) return null;
  return { start, end: end + 1 };
}

/** 从模型输出里抠 JSON 数组：容忍 ```json 围栏与前后废话 */
function extractPatches(text: string): QuotePatch[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (parsed as { patches?: unknown }).patches;
  if (!Array.isArray(list)) return null;
  const out: QuotePatch[] = [];
  for (const raw of list) {
    const o = raw as Record<string, unknown>;
    if (typeof o['quote'] !== 'string' || typeof o['replacement'] !== 'string') continue;
    out.push({
      quote: o['quote'],
      replacement: o['replacement'],
      reason: typeof o['reason'] === 'string' ? o['reason'] : '',
    });
  }
  return out;
}

/**
 * 纯函数：把补丁应用到正文上。可脱离模型测试。
 *
 * 逐条定位 → 跳过不可用项 → 从后往前替换（保偏移不失效）→ 校验改动量上限。
 */
export function applyPatches(
  text: string,
  patches: QuotePatch[],
  opts: { maxPatches?: number; maxReplacedRatio?: number } = {},
): { text: string; applied: QuotePatch[]; skipped: SkippedPatch[]; rejected: string | null } {
  const maxPatches = opts.maxPatches ?? DEFAULT_MAX_PATCHES;
  const maxRatio = opts.maxReplacedRatio ?? DEFAULT_MAX_REPLACED_RATIO;

  if (patches.length > maxPatches) {
    return {
      text,
      applied: [],
      skipped: [],
      rejected: `模型给了 ${patches.length} 条补丁，超过单次上限 ${maxPatches}——已整批放弃（这已是重写而非定点修订）`,
    };
  }

  const located: { start: number; end: number; p: QuotePatch }[] = [];
  const skipped: SkippedPatch[] = [];
  for (const p of patches) {
    if (p.replacement.trim() === '') {
      skipped.push({ ...p, why: '替换文本为空（疑似想删句）——静默删正文不可逆，交人工处理' });
      continue;
    }
    const span = locateQuote(text, p.quote);
    if (span === null) {
      skipped.push({ ...p, why: '引句未能在正文中定位（疑幻觉）' });
      continue;
    }
    located.push({ ...span, p });
  }

  // 重叠区间只保留先出现的那条，避免两次替换互相破坏
  located.sort((a, b) => a.start - b.start);
  const kept: typeof located = [];
  let lastEnd = -1;
  for (const l of located) {
    if (l.start < lastEnd) {
      skipped.push({ ...l.p, why: '与另一条补丁的区间重叠，本次跳过' });
      continue;
    }
    kept.push(l);
    lastEnd = l.end;
  }

  const replacedChars = kept.reduce((sum, l) => sum + (l.end - l.start), 0);
  const ratio = text.length === 0 ? 0 : replacedChars / text.length;
  if (ratio > maxRatio) {
    return {
      text,
      applied: [],
      skipped,
      rejected: `本次要替换 ${replacedChars} 字（占全文 ${(ratio * 100).toFixed(0)}%），超过上限 ${(maxRatio * 100).toFixed(0)}%`
        + '——已整批放弃（这已是重写而非定点修订）',
    };
  }

  // 从后往前替换：偏移不会失效
  let out = text;
  for (let i = kept.length - 1; i >= 0; i--) {
    const l = kept[i] as (typeof kept)[number];
    out = out.slice(0, l.start) + l.p.replacement + out.slice(l.end);
  }
  return { text: out, applied: kept.map((l) => l.p), skipped, rejected: null };
}

/**
 * 调 LLM 产出补丁并应用。LLM 失败 → 原样返回失败 union，**不写任何文件**。
 * JSON 解析失败 → 重试 1 次（v0.2 M7.5）；仍败返回 parse 失败。
 */
export async function reviseByQuote(o: ReviseByQuoteOptions): Promise<ReviseByQuoteResult | LLMError> {
  const root = path.resolve(o.bookRoot);
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((c) => c.chapterNo === o.chapterNo);
  if (entry === undefined) throw new Error(`reviseByQuote：第 ${o.chapterNo} 章不在索引中`);
  const text = stripBom(await readFile(path.join(root, 'chapters', entry.file), 'utf-8'));

  // 只有带引句的发现才可能被定点修；没引句的（整章级）只能走整章重写
  const fixable = o.findings.filter((f) => f.detail.trim() !== '');
  const system = [
    '你是中文网络小说的修订助手。**只做定点修订**：只改被指出的那几句，其余一字不动。',
    '',
    '输出格式（只输出 JSON，不要任何解释文字、不要 markdown 围栏）：',
    '{"patches":[{"quote":"正文里的原句","replacement":"改写后的句子","reason":"一句话理由"}]}',
    '',
    '纪律：',
    '- `quote` 必须是**正文里逐字存在**的原句，不要改写、不要拼接、不要自己造句；',
    '- `replacement` 只替换 `quote` 那一段，保持前后文衔接自然；',
    '- **不要**顺手改没被指出的地方；不要改人名、地名、数值；',
    '- 一句改不好就**不要给这条补丁**，宁缺毋滥；',
    '- 没有可改的就回 {"patches":[]}。',
  ].join('\n');

  const problems = fixable.length > 0
    ? fixable.map((f, i) => `${i + 1}. ${f.check}\n   引句：${f.detail}`).join('\n')
    : '（本次没有带引句的问题）';

  const user = [
    `# 正文（第 ${o.chapterNo} 章，${entry.file}）`,
    text.trim(),
    '',
    '# 待修问题（只改这些问题指出的地方）',
    problems,
  ].join('\n');
  // 作者指令（B-71）：有才加这一段，**不加空标题**——
  // 空的「作者指令」段会让模型以为漏看了什么，反而诱发改别处
  const authorBlock = (o.authorInstructions ?? []).filter((x) => x.trim() !== '');
  const userFinal = authorBlock.length > 0
    ? `${user}\n\n# 作者指令（收敛途中由作者投递；与本轮发现冲突时**优先执行**，落点由你判断）\n${authorBlock.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
    : user;

  const bundle = { system, user: userFinal, ruleRefs: { author: [], plugin: [] } };
  const callOpts: CallLLMOptions = { temperature: 0.2, ...o.llm, ...(o.signal !== undefined ? { signal: o.signal } : {}) };

  let r = await callLLM(bundle, callOpts);
  if (!r.ok) return r;
  let patches = extractPatches(r.text);
  if (patches === null) {
    r = await callLLM(bundle, callOpts);
    if (!r.ok) return r;
    patches = extractPatches(r.text);
    if (patches === null) {
      return { ok: false, kind: 'parse', detail: `定点修订输出不是可解析的 JSON（原文前 300 字）：${r.text.slice(0, 300)}` };
    }
  }

  const applied = applyPatches(text, patches, {
    ...(o.maxPatches !== undefined ? { maxPatches: o.maxPatches } : {}),
    ...(o.maxReplacedRatio !== undefined ? { maxReplacedRatio: o.maxReplacedRatio } : {}),
  });
  return { ok: true, ...applied };
}

// ── 按指令定点改（B-41：设定变更后顺序重写旧章）──────────────────────────────

export interface ReviseByInstructionOptions {
  bookRoot: string;
  chapterNo: number;
  /** 变更说明，如「林青的境界从炼气三层改为筑基初期」 */
  instruction: string;
  maxPatches?: number;
  maxReplacedRatio?: number;
  llm?: CallLLMOptions;
  signal?: AbortSignal;
}

/**
 * 按**变更说明**定点改一章（B-41 用）。
 *
 * 与 `reviseByQuote` 的区别：那边是「这几句有问题，改它们」（finding 带引句）；
 * 这边是「设定变了，你去找出受影响的地方」（没有现成引句）。
 *
 * ★**三条守卫一个不少**（复用 `applyPatches`）：引句定位不到 → 跳过；
 * 空替换 → 跳过；改动量超限 → 整批放弃。为什么这里更要紧：
 * 「设定变了」是个**开放式指令**，模型很容易顺手把整章重写一遍——
 * 那正是定点修订要避免的事（上一轮刚过闸的段落被改坏）。
 */
export async function reviseByInstruction(
  o: ReviseByInstructionOptions,
): Promise<ReviseByQuoteResult | LLMError> {
  const root = path.resolve(o.bookRoot);
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((c) => c.chapterNo === o.chapterNo);
  if (entry === undefined) throw new Error(`reviseByInstruction：第 ${o.chapterNo} 章不在索引中`);
  const text = stripBom(await readFile(path.join(root, 'chapters', entry.file), 'utf-8'));

  const system = [
    '你是中文网络小说的修订助手。**只做定点修订**：只改受「设定变更」影响的那几句，其余一字不动。',
    '',
    '输出格式（只输出 JSON，不要任何解释文字、不要 markdown 围栏）：',
    '{"patches":[{"quote":"正文里的原句","replacement":"改写后的句子","reason":"一句话理由"}]}',
    '',
    '纪律：',
    '- `quote` 必须是**正文里逐字存在**的原句，不要改写、不要拼接、不要自己造句；',
    '- 只改**确实受这次设定变更影响**的地方；不要顺手改别处；',
    '- 没有受影响的地方就回 {"patches":[]} —— **宁缺毋滥**；',
    '- `replacement` 保持前后文衔接自然，不要改动未被影响的人名、数值。',
  ].join('\n');

  const user = [
    `# 设定变更`,
    o.instruction.trim(),
    '',
    `# 正文（第 ${o.chapterNo} 章，${entry.file}）`,
    text.trim(),
  ].join('\n');

  const bundle = { system, user, ruleRefs: { author: [], plugin: [] } };
  const callOpts: CallLLMOptions = { temperature: 0.2, ...o.llm, ...(o.signal !== undefined ? { signal: o.signal } : {}) };

  let r = await callLLM(bundle, callOpts);
  if (!r.ok) return r;
  let patches = extractPatches(r.text);
  if (patches === null) {
    r = await callLLM(bundle, callOpts);
    if (!r.ok) return r;
    patches = extractPatches(r.text);
    if (patches === null) {
      return { ok: false, kind: 'parse', detail: `按指令修订输出不是可解析的 JSON（原文前 300 字）：${r.text.slice(0, 300)}` };
    }
  }

  const applied = applyPatches(text, patches, {
    ...(o.maxPatches !== undefined ? { maxPatches: o.maxPatches } : {}),
    ...(o.maxReplacedRatio !== undefined ? { maxReplacedRatio: o.maxReplacedRatio } : {}),
  });
  return { ok: true, ...applied };
}
