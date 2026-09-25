import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callLLM, type CallLLMOptions } from './llm.js';
import { readState } from './state.js';
import { checkChapterReadiness } from './readiness.js';
import { readHookSpecs } from './hooks.js';
import { contentHash } from './hash.js';
import type { GateFinding, GateSeverity, LLMError } from './types.js';

/**
 * 语义判据层 Judge（B-11，v0.2 M11 / docs/24 P0-1）。
 *
 * 治的是什么：机械判据（词面锚词、阈值、正则）到顶之后只能降级为只读线索——
 * 真书《高武》上 `hooks` 是 `checked 19 / failed 16`，多数是「细纲标意图、正文写变体」
 * 的假红（docs/23 §2）。门禁因此保证了「绿不是伪造的」，但「绿」本身不代表写得好。
 * Judge 用 LLM 按**意图**判，补上这一层。
 *
 * ★三条纪律（写死在这里，改之前先想清楚）：
 *
 * 1. **证据引句必须能在输入里逐字命中，命不中 → 该条降为 `unsure`**（防幻觉）。
 *    没有这条，LLM 可以随口说「第 5 段与设定冲突」而根本不存在那段——
 *    那比没有判据更坏：它把「编的结论」写进了看起来可信的报告。
 *    命中范围由判据自己的 `quoteScope` 决定：`chapter` = 只认正文；
 *    `any` = 正文或参考材料都算（「细纲要点没写到」这类**缺席断言**没有正文句子可引，
 *    只能引细纲里那句要求——若连细纲里都没有，照样降 unsure）。
 *
 * 2. **`unsure` 既不算通过、也不算拦截**，单独进 `manual` 人工清单。
 *    「判不出来」和「判了没问题」必须形状不同（本项目已为此吃过三次同源亏）。
 *
 * 3. **未声明任何判据 → 显式报错，绝不静默通过**。
 *    判据定义在 `.soloent/judges/<id>.md`（作者可改），book.json 的 `judges.enabled`
 *    显式声明启用哪些——沿用 rules 的「不扫目录、不递归」纪律。
 *    一个「没声明 = 0 条 finding = 看起来全绿」的实现，正是本项目反复在治的静默失效。
 */

export type JudgeVerdict = 'pass' | 'fail' | 'unsure';

/** 引句核对结果。`not-found` 是**降级原因**，必须留在结果里，不能只体现在 verdict 上 */
export type JudgeEvidence = 'ok' | 'not-found' | 'empty';

export interface JudgeCriterionResult {
  /** 判据 id，与声明里的 id 一致 */
  id: string;
  verdict: JudgeVerdict;
  /** 原文引句（LLM 给的，未经改写） */
  quote: string;
  reason: string;
  evidence: JudgeEvidence;
  /** 判据原始判定（降级前）。evidence 不为 ok 时与 verdict 不同，供人工核对 */
  rawVerdict: JudgeVerdict;
}

export interface JudgeDef {
  id: string;
  title: string;
  /** 引句的合法来源；见文件头纪律 1 */
  quoteScope: 'chapter' | 'any';
}

/** 插件内置的三条首批判据（v0.2 M11 的 J1/J2/J3）。`novel judge --scaffold` 用它落盘。 */
export const DEFAULT_JUDGE_DEFS: ReadonlyArray<JudgeDef & { body: string }> = [
  {
    id: 'j1-blueprint',
    title: 'J1 蓝图契约',
    quoteScope: 'any',
    body: [
      '判「本章是否兑现了细纲对它的要求」。',
      '',
      '要看的：本章目标是否达成；细纲列出的要点是否写到；细纲要求埋的伏笔是否埋下。',
      '',
      '判定要点：',
      '- 只判细纲**明确要求**的项，不要按自己的审美补充要求；',
      '- 细纲没写到的，不要当成「未达成」；',
      '- 「未写到」是合法判定，此时 quote 引**细纲里那句要求**（缺席断言没有正文句子可引）；',
      '- 若细纲缺失或只有卷级背景，判 `unsure` 并说明原因，不要硬判。',
    ].join('\n'),
  },
  {
    id: 'j2-hook',
    title: 'J2 章末钩子',
    quoteScope: 'chapter',
    body: [
      '判「本章是否按细纲标明的钩子类型收尾」。',
      '',
      '要看的：章末最后两三段是否形成了细纲所标类型的钩子',
      '（悬念／危机／反转／揭示／期待／情绪／承诺）。',
      '',
      '判定要点：',
      '- **按意图判，不比字面**：细纲写「悬念」而正文用一段留白收尾，算兑现；',
      '- 细纲没标钩子类型 → 只判「章末是否留有牵引读者继续读的东西」，不苛求类型；',
      '- 平铺直叙地收束（把本章的事讲完、无事可期）判 `fail`；',
      '- quote 必须引**正文里实际收尾的那句**，不是细纲里的话。',
    ].join('\n'),
  },
  {
    id: 'j3-continuity',
    title: 'J3 连续性',
    quoteScope: 'chapter',
    body: [
      '判「本章是否与已发生的事实冲突」。',
      '',
      '要看的：伤势、境界/等级、生死、所在位置、人物关系、信息边界（角色不该知道的事他知道了）。',
      '以「当前状态卡」「上一章摘要」为准，不要以你对该类题材的常识为准。',
      '',
      '判定要点：',
      '- 参考材料里没有的事实，**不要**判冲突（缺依据 ≠ 冲突）；',
      '- 人物主动隐瞒、说谎、误会**不是**冲突；',
      '- 合理的伤势好转/境界提升不算冲突，除非与参考材料给出的进度明显矛盾；',
      '- quote 必须引**正文里与之冲突的那句**。',
    ].join('\n'),
  },
];

/** 声明了但磁盘上不存在判据文件——显式报错，绝不静默跳过（与 RuleFileMissing 同款纪律） */
export class JudgeDefMissing extends Error {
  constructor(public readonly id: string, public readonly relPath: string) {
    super(`判据定义不存在: ${relPath}（book.json 的 judges.enabled 声明了「${id}」）`);
    this.name = 'JudgeDefMissing';
  }
}

/** 一个判据都没声明——显式报错。**不许**退化成「0 条 finding = 通过」 */
export class JudgesNotDeclared extends Error {
  constructor(public readonly bookRoot: string) {
    super(
      '本书未声明任何语义判据（book.json 的 judges.enabled 为空或缺失），本次未做任何判定。\n'
        + '  这不是「审稿通过」，是「没审」——两者必须形状不同。\n'
        + '  落默认判据：novel judge --book <书目录> --scaffold\n'
        + '  再在 book.json 写： "judges": { "enabled": ["j1-blueprint", "j2-hook", "j3-continuity"] }',
    );
    this.name = 'JudgesNotDeclared';
  }
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/** 判据文件（相对书根） */
export function judgeFile(id: string): string {
  return `.soloent/judges/${id}.md`;
}

/** 读 book.json 的 judges.enabled（字符串数组）。读不到/坏 → 空数组（调用方据此报「未声明」） */
export async function readJudgeDecl(bookRoot: string): Promise<string[]> {
  const raw = await readFile(path.join(path.resolve(bookRoot), '.soloent', 'book.json'), 'utf-8').catch(() => null);
  if (raw === null) return [];
  try {
    const cfg = JSON.parse(stripBom(raw)) as { judges?: { enabled?: unknown } };
    const list = cfg.judges?.enabled;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 判据文件正文里可选的一行声明：`引句来源: chapter|any`。缺省按 j2/j3 同款从严（chapter）。 */
function parseQuoteScope(body: string): 'chapter' | 'any' {
  const m = /^引句来源[:：]\s*(chapter|any)\s*$/m.exec(body);
  return m?.[1] === 'any' ? 'any' : 'chapter';
}

/** 标题取首个 H1；无则用 id */
function parseTitle(body: string, id: string): string {
  const m = /^#\s+(.+)$/m.exec(body);
  return m?.[1]?.trim() ?? id;
}

export interface LoadedJudge extends JudgeDef {
  /** 判据正文（不含 H1 与元数据行） */
  body: string;
  relPath: string;
}

/**
 * 加载已声明的判据。顺序 = book.json 里的声明顺序（作者的意图顺序，不重排）。
 * 文件缺失 → JudgeDefMissing（显式，不跳过）。
 */
export async function loadJudges(bookRoot: string): Promise<LoadedJudge[]> {
  const root = path.resolve(bookRoot);
  const ids = await readJudgeDecl(root);
  if (ids.length === 0) throw new JudgesNotDeclared(root);
  const out: LoadedJudge[] = [];
  for (const id of ids) {
    const relPath = judgeFile(id);
    const raw = await readFile(path.join(root, relPath), 'utf-8').catch(() => null);
    if (raw === null) throw new JudgeDefMissing(id, relPath);
    const text = stripBom(raw);
    const body = text
      .replace(/^#\s+.+$/m, '')
      .replace(/^引句来源[:：].*$/m, '')
      .trim();
    out.push({ id, title: parseTitle(text, id), quoteScope: parseQuoteScope(text), body, relPath });
  }
  return out;
}

/** 落默认判据文件（幂等：已存在的**不覆盖**——作者改过的判据不许被冲掉） */
export async function scaffoldJudges(bookRoot: string): Promise<{ written: string[]; kept: string[] }> {
  const root = path.resolve(bookRoot);
  const dir = path.join(root, '.soloent', 'judges');
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  const kept: string[] = [];
  for (const def of DEFAULT_JUDGE_DEFS) {
    const rel = judgeFile(def.id);
    const abs = path.join(root, rel);
    const exists = await stat(abs).catch(() => null);
    if (exists !== null) {
      kept.push(rel);
      continue;
    }
    const text = `# ${def.title}\n引句来源: ${def.quoteScope}\n\n${def.body}\n`;
    await writeFile(abs, text, 'utf-8');
    written.push(rel);
  }
  return { written, kept };
}

// ── 证据引句核对（防幻觉的唯一一道门）─────────────────────────────────────────

/** 去全部空白：LLM 复述引句时常改换行/缩进，那不是幻觉，不该判 not-found */
function squash(text: string): string {
  return text.replace(/\s/g, '');
}

/**
 * 引句是否能在给定文本里命中。
 * 先逐字 `includes`；失败再去空白比对（容忍换行/缩进差异）。
 * 两关都过不了 → not-found，调用方把该条降为 unsure。
 */
export function evidenceFound(quote: string, haystack: string): boolean {
  const q = quote.trim();
  if (q === '') return false;
  if (haystack.includes(q)) return true;
  return squash(haystack).includes(squash(q));
}

// ── LLM 输出解析 ──────────────────────────────────────────────────────────

export interface ParsedJudgeItem {
  id: string;
  verdict: JudgeVerdict;
  quote: string;
  reason: string;
}

/** 从模型输出里抠 JSON：容忍 ```json 围栏与前后废话；找不到则 null */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const VERDICTS = new Set<JudgeVerdict>(['pass', 'fail', 'unsure']);

/**
 * 解析模型输出。形状不符的条目**丢弃并记入 dropped**——
 * 丢的东西必须报出来，否则「模型少回了一条」会静默变成「这条没问题」。
 */
export function parseJudgeOutput(text: string): { items: ParsedJudgeItem[]; dropped: string[] } {
  const json = extractJson(text);
  const rawList = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(rawList)) return { items: [], dropped: ['整体输出不是含 results 数组的 JSON'] };
  const items: ParsedJudgeItem[] = [];
  const dropped: string[] = [];
  for (const raw of rawList) {
    const o = raw as Record<string, unknown>;
    const id = typeof o['criterion'] === 'string' ? o['criterion'] : (typeof o['id'] === 'string' ? o['id'] : '');
    const verdict = o['verdict'];
    if (id === '' || typeof verdict !== 'string' || !VERDICTS.has(verdict as JudgeVerdict)) {
      dropped.push(JSON.stringify(raw).slice(0, 200));
      continue;
    }
    items.push({
      id,
      verdict: verdict as JudgeVerdict,
      quote: typeof o['quote'] === 'string' ? o['quote'] : (typeof o['evidence'] === 'string' ? o['evidence'] : ''),
      reason: typeof o['reason'] === 'string' ? o['reason'] : '',
    });
  }
  return { items, dropped };
}

// ── 结果与落盘 ────────────────────────────────────────────────────────────

export interface JudgeResult {
  ok: true;
  bookRoot: string;
  chapterNo: number;
  file: string;
  /** 本次实际跑的判据 id（= 声明顺序） */
  judges: string[];
  results: JudgeCriterionResult[];
  /** fail 转成的 findings，形状与机械 gates 一致（同 severity 口径） */
  findings: GateFinding[];
  /** unsure（含被降级的）——人工清单。不计通过、不计拦截 */
  manual: JudgeCriterionResult[];
  counts: Partial<Record<GateSeverity, number>>;
  /** 模型输出里形状不符、被丢弃的条目（丢的东西必须可见） */
  dropped: string[];
}

export interface JudgeChapterOptions {
  bookRoot: string;
  chapterNo: number;
  /**
   * true = 全部判据降为「提示」级（只报告，不拦截）。
   * 为什么要有它：语义判据的假红率尚未标定（P0-1 的验收目标就是把它测出来）。
   * 在拿到真书数据之前就让它拦人，会重演 hook_check 那条路——16 条假红把闸门变成噪音。
   */
  advisory?: boolean;
  llm?: CallLLMOptions;
}

/** fail 的严重度：默认「中等」（拦截级）；advisory 时降为「提示」（只报告） */
const FAIL_SEVERITY: GateSeverity = '中等';
const ADVISORY_SEVERITY: GateSeverity = '提示';

/** 参考材料：只给「已经存在的事实」，缺的部分显式标注，不静默留空 */
async function buildContext(root: string, chapterNo: number): Promise<{ text: string; hasAny: boolean }> {
  const parts: string[] = [];
  let hasAny = false;

  const readiness = await checkChapterReadiness(root, chapterNo);
  if (readiness.outlineText !== null && readiness.outlineText.trim() !== '') {
    const label = readiness.outlineScope === 'chapter' ? '本章细纲' : '细纲（卷级背景，未必只覆盖本章）';
    parts.push(`# ${label}`, readiness.outlineText.trim(), '');
    hasAny = true;
  } else {
    parts.push('# 本章细纲', '（缺：本书没有可用的本章细纲）', '');
  }

  // 章末钩子的**要求**：从细纲解析出来的锚词/类型（词面判据的同一份输入）
  if (readiness.outlineFile !== '') {
    const specs = await readHookSpecs(root, readiness.outlineFile);
    const spec = specs.find((s) => s.chapterNo === chapterNo);
    if (spec !== undefined && spec.anchors.length > 0) {
      parts.push('# 本章细纲标明的章末钩子', spec.anchors.join('、'), '');
      hasAny = true;
    }
  }

  const cfgRaw = await readFile(path.join(root, '.soloent', 'book.json'), 'utf-8').catch(() => '{}');
  let nowRel = '.soloent/memory/now.md';
  try {
    const cfg = JSON.parse(stripBom(cfgRaw)) as { paths?: { now?: unknown } };
    if (typeof cfg.paths?.now === 'string' && cfg.paths.now !== '') nowRel = cfg.paths.now;
  } catch {
    // book.json 坏了：用缺省路径，读不到就当没有——下面会显式标注
  }
  const now = stripBom(await readFile(path.join(root, nowRel), 'utf-8').catch(() => '')).trim();
  if (now !== '' && !/^[（(]待填[）)]$/.test(now.replace(/^#[^\n]*\n?/, '').trim())) {
    parts.push('# 当前状态卡（已发生事实，以此为准）', now, '');
    hasAny = true;
  } else {
    parts.push('# 当前状态卡', '（缺：now.md 不存在或仍是待填占位）', '');
  }

  const state = await readState({ bookRoot: root });
  const prev = state.chapters.filter((c) => c.chapterNo < chapterNo).at(-1);
  if (prev !== undefined) {
    const summaryRaw = await readFile(path.join(root, 'state', 'summaries.json'), 'utf-8').catch(() => null);
    let summary = '';
    if (summaryRaw !== null) {
      try {
        const store = JSON.parse(stripBom(summaryRaw)) as { chapters?: Record<string, { summary?: unknown }> };
        const s = store.chapters?.[prev.file]?.summary;
        if (typeof s === 'string') summary = s;
      } catch {
        // 摘要坏了当没有；下面的「上一章末尾」仍是有效依据
      }
    }
    parts.push(
      `# 上一章（第 ${prev.chapterNo} 章）摘要`,
      summary !== '' ? summary : '（缺：尚未生成摘要）',
      '',
    );
    const prevText = stripBom(await readFile(path.join(root, 'chapters', prev.file), 'utf-8').catch(() => ''));
    if (prevText !== '') {
      parts.push('# 上一章末尾', [...prevText.trimEnd()].slice(-600).join(''), '');
      hasAny = true;
    }
  } else {
    parts.push('# 上一章', '（本章是第一章）', '');
  }

  return { text: parts.join('\n'), hasAny };
}

export interface EvaluateInput {
  judges: JudgeDef[];
  items: ParsedJudgeItem[];
  chapterText: string;
  /** 参考材料全文（J1 这类缺席断言的引句可以来自这里） */
  contextText: string;
  /** 章节文件名（findings 的 chapter 键） */
  file: string;
  /** fail 记哪一级 */
  severity: GateSeverity;
}

export interface EvaluateOutput {
  results: JudgeCriterionResult[];
  findings: GateFinding[];
  manual: JudgeCriterionResult[];
  counts: Partial<Record<GateSeverity, number>>;
}

/**
 * 判定结果的**纯函数**核心：引句核对 → 降级 → 分桶（findings / manual）。
 *
 * 抽出来单独导出，是为了让「引句命不中就降 unsure」这条防幻觉纪律**能脱离模型被测**——
 * 直接喂合成的模型输出即可断言。否则这条纪律只能靠真调 LLM 验证，等于没法回归。
 */
export function evaluateCriteria(i: EvaluateInput): EvaluateOutput {
  const byId = new Map(i.items.map((it) => [it.id, it]));
  const results: JudgeCriterionResult[] = [];
  const findings: GateFinding[] = [];
  const manual: JudgeCriterionResult[] = [];
  const counts: Partial<Record<GateSeverity, number>> = {};

  for (const judge of i.judges) {
    const got = byId.get(judge.id);
    if (got === undefined) {
      // 模型漏回一条 = 这条没判。按纪律 2，没判 ≠ 通过 → 进人工清单
      const miss: JudgeCriterionResult = {
        id: judge.id,
        verdict: 'unsure',
        quote: '',
        reason: '模型未返回该判据的判定（漏回）',
        evidence: 'empty',
        rawVerdict: 'unsure',
      };
      results.push(miss);
      manual.push(miss);
      continue;
    }

    const haystack = judge.quoteScope === 'any' ? `${i.chapterText}\n${i.contextText}` : i.chapterText;
    const found = evidenceFound(got.quote, haystack);
    const evidence: JudgeEvidence = got.quote.trim() === '' ? 'empty' : (found ? 'ok' : 'not-found');
    // ★纪律 1：引句命不中 → 降为 unsure。**只降级、不静默丢弃**——rawVerdict 留着给人工看
    const verdict: JudgeVerdict = evidence === 'ok' ? got.verdict : 'unsure';
    const reason = evidence === 'ok'
      ? got.reason
      : `${got.reason}｜⚠️ 引句未能在${judge.quoteScope === 'any' ? '材料' : '正文'}中逐字命中，已降为 unsure（疑幻觉）`;

    const item: JudgeCriterionResult = { id: judge.id, verdict, quote: got.quote, reason, evidence, rawVerdict: got.verdict };
    results.push(item);

    if (verdict === 'fail') {
      counts[i.severity] = (counts[i.severity] ?? 0) + 1;
      findings.push({
        severity: i.severity,
        chapter: i.file,
        line: 0,                       // 语义判据是整章级，无行号（不得渲染成「第 0 行」）
        check: `[${judge.title}] ${got.reason}`,
        detail: got.quote,
      });
    } else if (verdict === 'unsure') {
      manual.push(item);
    }
  }
  return { results, findings, manual, counts };
}

/**
 * 跑一章的语义判据。一次调用跑完所有已声明判据（省 token，且让模型能跨判据对照）。
 *
 * LLM 失败 → 原样返回失败 union，不写任何东西（与其余生成入口同款：失败不落盘）。
 * JSON 解析失败 → **重试 1 次**（v0.2 M7.5），仍败返回 parse 失败，不吞错。
 *
 * 返回类型用 `JudgeResult | LLMError`（不是 `LLMResult`）：后者含 `{ok:true; text}`，
 * 与 `JudgeResult` 的 `ok:true` 撞在一起会让 `!r.ok` 收窄失效——两个分支都"看起来像成功"。
 * 失败侧只取 `ok:false` 的联合，判别才是真的。
 */
export async function judgeChapter(o: JudgeChapterOptions): Promise<JudgeResult | LLMError> {
  const root = path.resolve(o.bookRoot);
  const judges = await loadJudges(root);          // 未声明 → JudgesNotDeclared（显式）
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((c) => c.chapterNo === o.chapterNo);
  if (entry === undefined) throw new Error(`judgeChapter：第 ${o.chapterNo} 章不在索引中`);
  const chapterText = stripBom(await readFile(path.join(root, 'chapters', entry.file), 'utf-8'));
  const ctx = await buildContext(root, o.chapterNo);

  const system = [
    '你是中文长篇小说的审稿裁判。只做判定，不改写、不润色、不评价文笔。',
    '对每一条给定判据给出一个判定，并**必须**给出一句原文引句作为依据。',
    '',
    '输出格式（只输出 JSON，不要任何解释文字、不要 markdown 围栏）：',
    '{"results":[{"criterion":"判据id","verdict":"pass|fail|unsure","quote":"原文引句","reason":"一句话理由"}]}',
    '',
    '纪律：',
    '- 每条判据都要回一条，criterion 用给定的判据 id；',
    '- verdict 只能取 pass / fail / unsure 三者之一；',
    '- quote 必须是从给定材料里**逐字复制**的一句，不要改写、不要拼接、不要自己造句；',
    '- 判不了就给 unsure 并说明缺什么，不要猜；',
    '- reason 一句话，说清「凭什么」。',
    '',
    '本次判据：',
    ...judges.map((j) => `## ${j.id}｜${j.title}\n${j.body}`),
  ].join('\n');

  const user = [
    `# 待审正文（第 ${o.chapterNo} 章，${entry.file}）`,
    chapterText.trim(),
    '',
    '# 参考材料',
    ctx.text,
  ].join('\n');

  const bundle = { system, user, ruleRefs: { author: [], plugin: [] } };
  const callOpts: CallLLMOptions = { temperature: 0.2, ...o.llm };

  let r = await callLLM(bundle, callOpts);
  if (!r.ok) return r;
  let parsed = parseJudgeOutput(r.text);
  if (parsed.items.length === 0) {
    // v0.2 M7.5：JSON 解析失败重试 1 次，仍败带原文报错（不吞）
    r = await callLLM(bundle, callOpts);
    if (!r.ok) return r;
    parsed = parseJudgeOutput(r.text);
    if (parsed.items.length === 0) {
      return { ok: false, kind: 'parse', detail: `判据输出不是可解析的 JSON（原文前 300 字）：${r.text.slice(0, 300)}` };
    }
  }

  const severity: GateSeverity = o.advisory === true ? ADVISORY_SEVERITY : FAIL_SEVERITY;
  const evaluated = evaluateCriteria({
    judges,
    items: parsed.items,
    chapterText,
    contextText: ctx.text,
    file: entry.file,
    severity,
  });

  return {
    ok: true,
    bookRoot: root,
    chapterNo: o.chapterNo,
    file: entry.file,
    judges: judges.map((j) => j.id),
    ...evaluated,
    dropped: parsed.dropped,
  };
}

// ── state/judge.json：判据结论的落盘（与 gateStatus 同款过期语义）──────────────

export interface JudgeChapterStatus {
  worst: GateSeverity | 'clean';
  count: number;
  /** unsure 条数——人工清单长度，与 count（拦截级 fail 数）分开记 */
  manual: number;
  checkedAt: string;
  /**
   * 判定时刻该章的内容指纹（v2 起，取代 checkedMtimeMs）。
   * 与 gateStatus 同款语义：与当前指纹不符即作废。
   * **全项目只有一种指纹**（hash.ts 的 contentHash）——两个机制必然漂移。
   */
  checkedHash: string;
  judges: string[];
}

export interface JudgeStore {
  schemaVersion: 1;
  bookRoot: string;
  chapters: Record<string, JudgeChapterStatus>;
}

const SEVERITY_WEIGHT: Record<GateSeverity, number> = { 严重: 4, 中等: 3, 轻微: 2, 提示: 1 };

function judgeStorePath(root: string): string {
  return path.join(root, 'state', 'judge.json');
}

async function readJudgeStore(root: string): Promise<JudgeStore> {
  const raw = await readFile(judgeStorePath(root), 'utf-8').catch(() => null);
  if (raw === null) return { schemaVersion: 1, bookRoot: root, chapters: {} };
  try {
    const parsed = JSON.parse(stripBom(raw)) as JudgeStore;
    if (parsed.schemaVersion !== 1 || parsed.bookRoot !== root) return { schemaVersion: 1, bookRoot: root, chapters: {} };
    return parsed;
  } catch {
    return { schemaVersion: 1, bookRoot: root, chapters: {} };
  }
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

/**
 * 把一次判据结果写入 `state/judge.json`。
 *
 * ★为什么不写进 `gateStatus`（v0.2 M11 写的是「写入 gateStatus」）：
 * `applyGateResult` 是**全量覆写**——机械 gates 每跑一次就把每一章的 gateStatus 重写一遍。
 * 判据结论若并进去，会被下一次机械 gate 跑**静默冲掉**，变成「写进去了但会丢」。
 * 且 M10.5 明说 Gates 与 Judge 不查同一项，合成一个 worst 会丢信息。
 * 所以判据结论单独落一个文件、单独带 checkedHash。
 * 两者怎么合起来判「能否提交」是 B-12 的事，那时才有真正的合并语义需求。
 * （此偏离已登记 BACKLOG，待作者裁定。）
 */
export async function writeJudgeStatus(root0: string, result: JudgeResult, hash: string): Promise<JudgeChapterStatus> {
  const root = path.resolve(root0);
  const store = await readJudgeStore(root);
  let worst: GateSeverity | 'clean' = 'clean';
  let count = 0;
  for (const f of result.findings) {
    count += 1;
    if (worst === 'clean' || SEVERITY_WEIGHT[f.severity] > SEVERITY_WEIGHT[worst]) worst = f.severity;
  }
  const status: JudgeChapterStatus = {
    worst,
    count,
    manual: result.manual.length,
    checkedAt: new Date().toISOString(),
    checkedHash: hash,
    judges: result.judges,
  };
  store.chapters[result.file] = status;
  await atomicWrite(judgeStorePath(root), JSON.stringify(store, null, 2) + '\n');
  return status;
}

/**
 * 读判据结论（含过期清扫：指纹不符即删该章条目，与 readState 同款语义）。
 *
 * v2（B-13）：按 contentHash 比对，不再按 mtime。旧格式（checkedMtimeMs）的条目
 * 一律丢弃——拿 mtime 给结论背书正是我们要废掉的做法，不能带进新格式。
 */
export async function readJudgeStatus(bookRoot: string): Promise<JudgeStore> {
  const root = path.resolve(bookRoot);
  const store = await readJudgeStore(root);
  const dir = path.join(root, 'chapters');
  const files = await readdir(dir).catch(() => [] as string[]);
  const known = new Set(files);
  for (const [file, st] of Object.entries(store.chapters)) {
    if (!known.has(file) || typeof st.checkedHash !== 'string' || st.checkedHash === '') {
      delete store.chapters[file];
      continue;
    }
    const raw = await readFile(path.join(dir, file), 'utf-8').catch(() => null);
    if (raw === null || contentHash(stripBom(raw)) !== st.checkedHash) delete store.chapters[file];
  }
  return store;
}
