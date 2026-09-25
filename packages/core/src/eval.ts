import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { judgeChapter } from './judges.js';
import { DEFAULT_JUDGE_DEFS } from './judges.js';
import type { CallLLMOptions } from './llm.js';

/**
 * 评测集（B-31 / v0.2 X7、附 A）：度量 Judge 的**检出率与假红率**。
 *
 * 治的是什么：Judge（B-11）建好之后，「它判得准不准」一直是个**没有数字的问题**。
 * B-64 要求「对真书跑一遍、人工抽查、假红率 < 20%」——那需要一个**可重复的仪器**，
 * 而不是每次手工拼章节、手工比对。
 *
 * ★评测集的结构（作者提供内容，本模块只提供仪器）：
 * ```
 * <bookRoot>/evals/<caseName>/
 *   chapter.md     待审正文
 *   outline.md     本章细纲/蓝图（可选；缺了 J1 会判 unsure）
 *   expect.json    {"verdict":"fail","criterion":"j3-continuity","note":"..."}
 *                  verdict: pass（人工好稿，不该被误报）| fail（故意植入的问题，应检出）
 * ```
 *
 * ★三条口径纪律（与 B-11 的 `unsure` 语义一致）：
 *
 * 1. **`unsure` 既不算检出、也不算通过**，单独一列报出来。
 *    把它算进「检出」会虚高检出率，算进「通过」会虚低假红率——两个方向都会骗自己。
 *
 * 2. **分母是「该类用例数」，不是「全部用例数」**。
 *    检出率的分母是 fail 用例，假红率的分母是 pass 用例。
 *    用总数当分母会让「fail 用例很少」时的检出率看起来莫名其妙地低。
 *
 * 3. **用例数为 0 时是 `null` 不是 0**——「没测过」与「测了 0%」必须形状不同。
 *
 * ★**评测集在 `evals/` 里，不参与正式流程**：它不写 state、不改章节、
 * 不进 gateStatus。跑评测只在临时目录里造书。
 */

export interface EvalCase {
  name: string;
  /** 待审正文 */
  chapterText: string;
  /** 本章细纲/蓝图（可选） */
  outlineText: string;
  /** 期望 */
  expect: {
    verdict: 'pass' | 'fail';
    /** 期望命中/放过的判据 id（如 j3-continuity）；不填则看「任意判据」 */
    criterion?: string;
    note: string;
  };
}

export interface EvalCaseResult {
  name: string;
  expect: EvalCase['expect'];
  /** 实际判定：该判据（或任一判据）的 verdict */
  actual: 'pass' | 'fail' | 'unsure' | 'missing';
  /** 判据原始输出（含引句与理由），供人工核对 */
  detail: { id: string; verdict: string; evidence: string; reason: string }[];
  /** 结论：hit（fail 用例被检出）/ miss（fail 用例漏了）/ false-alarm（pass 用例被误报）/ ok（pass 用例被放过）/ unsure */
  outcome: 'hit' | 'miss' | 'false-alarm' | 'ok' | 'unsure' | 'no-judges';
}

export interface EvalReport {
  setDir: string;
  cases: EvalCaseResult[];
  /** 检出率：分母 = fail 用例数。0 个时 null */
  detectionRate: number | null;
  /** 假红率：分母 = pass 用例数。0 个时 null */
  falseAlarmRate: number | null;
  /** unsure 占比：分母 = 全部用例数。0 个时 null */
  unsureRate: number | null;
  counts: { total: number; fail: number; pass: number; hit: number; miss: number; falseAlarm: number; unsure: number };
}

export class EvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

const EVALS_REL = 'evals';

/** 读评测集目录。**读不出内容的用例直接报错**——静默跳过会让分母悄悄变小 */
export async function loadEvalSet(bookRoot: string, opts: { dir?: string } = {}): Promise<EvalCase[]> {
  const root = path.resolve(bookRoot);
  const base = opts.dir !== undefined
    ? (path.isAbsolute(opts.dir) ? opts.dir : path.join(root, opts.dir))
    : path.join(root, EVALS_REL);
  const names = (await readdir(base, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (names.length === 0) {
    throw new EvalError(
      `评测集是空的：${base}\n`
        + '  结构：<评测集>/<用例名>/{chapter.md, outline.md(可选), expect.json}\n'
        + '  expect.json 形如 {"verdict":"fail","criterion":"j3-continuity","note":"伤势矛盾"}',
    );
  }
  const out: EvalCase[] = [];
  for (const name of names) {
    const dir = path.join(base, name);
    const chapterText = await readFile(path.join(dir, 'chapter.md'), 'utf-8').catch(() => null);
    if (chapterText === null) throw new EvalError(`用例 ${name} 缺 chapter.md：${dir}`);
    const outlineText = (await readFile(path.join(dir, 'outline.md'), 'utf-8').catch(() => '')).replace(/^\uFEFF/, '');
    const rawExpect = await readFile(path.join(dir, 'expect.json'), 'utf-8').catch(() => null);
    if (rawExpect === null) throw new EvalError(`用例 ${name} 缺 expect.json：${dir}（没有期望就无从度量）`);
    let expect: EvalCase['expect'];
    try {
      const p = JSON.parse(rawExpect.replace(/^\uFEFF/, '')) as Record<string, unknown>;
      if (p['verdict'] !== 'pass' && p['verdict'] !== 'fail') {
        throw new Error(`verdict 只能是 pass / fail，收到「${String(p['verdict'])}」`);
      }
      expect = {
        verdict: p['verdict'],
        ...(typeof p['criterion'] === 'string' && p['criterion'] !== '' ? { criterion: p['criterion'] } : {}),
        note: typeof p['note'] === 'string' ? p['note'] : '',
      };
    } catch (e) {
      throw new EvalError(`用例 ${name} 的 expect.json 不合法：${e instanceof Error ? e.message : String(e)}`);
    }
    out.push({ name, chapterText: chapterText.replace(/^\uFEFF/, ''), outlineText, expect });
  }
  return out;
}

/**
 * 为一个用例造一本**临时书**并跑 Judge。
 *
 * 为什么造临时书而不是直接在真书上跑：评测集里的章节是**故意植入问题的样本**，
 * 它们不该混进真书的 `chapters/`——那会污染 state、gateStatus、摘要、事实库。
 * 评测只在 `os.tmpdir()` 里发生，跑完就删。
 */
async function judgeOneCase(
  bookRoot: string,
  c: EvalCase,
  opts: { judges: string[]; llm?: CallLLMOptions },
): Promise<EvalCaseResult> {
  const root = path.resolve(bookRoot);
  const tmp = path.join(tmpdir(), `novel-eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await mkdir(path.join(tmp, '.soloent', 'judges'), { recursive: true });
    await mkdir(path.join(tmp, 'chapters'), { recursive: true });
    await mkdir(path.join(tmp, 'outline'), { recursive: true });
    await writeFile(path.join(tmp, '.soloent', 'book.json'), JSON.stringify({
      _schema: 1,
      book: { title: '评测用例' },
      paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
      chapter: { file_regex: '^ch-(\\d+)\\.md$' },
      ledger: { columns: ['章'], chapter_column: '章' },
      judges: { enabled: opts.judges },
    }), 'utf-8');
    // 判据定义从**真书**复制过来（评测要测的是「这本书的判据」，不是内置默认）
    for (const id of opts.judges) {
      const src = await readFile(path.join(root, '.soloent', 'judges', `${id}.md`), 'utf-8').catch(() => null);
      const body = src ?? `# ${DEFAULT_JUDGE_DEFS.find((d) => d.id === id)?.title ?? id}\n`
        + `引句来源: ${DEFAULT_JUDGE_DEFS.find((d) => d.id === id)?.quoteScope ?? 'chapter'}\n\n`
        + `${DEFAULT_JUDGE_DEFS.find((d) => d.id === id)?.body ?? ''}\n`;
      await writeFile(path.join(tmp, '.soloent', 'judges', `${id}.md`), body, 'utf-8');
    }
    await writeFile(path.join(tmp, 'chapters', 'ch-01.md'), c.chapterText, 'utf-8');
    if (c.outlineText.trim() !== '') await writeFile(path.join(tmp, 'outline', 'ch-01.md'), c.outlineText, 'utf-8');

    const r = await judgeChapter({ bookRoot: tmp, chapterNo: 1, ...(opts.llm !== undefined ? { llm: opts.llm } : {}) });
    if (!r.ok) {
      // LLM 失败不该被算成「漏检」——那是仪器坏了，不是判据不准
      throw new EvalError(`用例 ${c.name} 的 Judge 调用失败 [${r.kind}] ${r.detail}`);
    }
    const detail = r.results.map((x) => ({ id: x.id, verdict: x.verdict, evidence: x.evidence, reason: x.reason }));

    // 取「该判据」或「任一判据」的判定。unsure 优先上报——它既不是检出也不是放过
    const relevant = c.expect.criterion !== undefined
      ? r.results.filter((x) => x.id === c.expect.criterion)
      : r.results;
    if (relevant.length === 0) {
      return { name: c.name, expect: c.expect, actual: 'missing', detail, outcome: 'no-judges' };
    }
    const anyFail = relevant.some((x) => x.verdict === 'fail');
    const anyPass = relevant.some((x) => x.verdict === 'pass');
    const actual: EvalCaseResult['actual'] = anyFail ? 'fail' : (anyPass ? 'pass' : 'unsure');

    let outcome: EvalCaseResult['outcome'];
    if (actual === 'unsure') outcome = 'unsure';
    else if (c.expect.verdict === 'fail') outcome = actual === 'fail' ? 'hit' : 'miss';
    else outcome = actual === 'fail' ? 'false-alarm' : 'ok';

    return { name: c.name, expect: c.expect, actual, detail, outcome };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface RunEvalOptions {
  /** 跑哪些判据；缺省读真书的 judges.enabled */
  judges?: string[];
  llm?: CallLLMOptions;
  /** 评测集目录（相对书根或绝对）；缺省 `evals/` */
  dir?: string;
}

export async function runEvalSet(bookRoot: string, opts: RunEvalOptions = {}): Promise<EvalReport> {
  const root = path.resolve(bookRoot);
  const judges = opts.judges ?? await (async (): Promise<string[]> => {
    const raw = await readFile(path.join(root, '.soloent', 'book.json'), 'utf-8').catch(() => null);
    if (raw === null) return [];
    try {
      const cfg = JSON.parse(raw.replace(/^\uFEFF/, '')) as { judges?: { enabled?: unknown } };
      const list = cfg.judges?.enabled;
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  })();
  if (judges.length === 0) {
    throw new EvalError(
      '本书未声明任何判据（book.json 的 judges.enabled 为空）——评测无从跑起。\n'
        + '  先 novel judge --book <书根> --scaffold，再在 book.json 里声明要测哪些判据。',
    );
  }

  const cases = await loadEvalSet(root, opts.dir !== undefined ? { dir: opts.dir } : {});
  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    results.push(await judgeOneCase(root, c, { judges, ...(opts.llm !== undefined ? { llm: opts.llm } : {}) }));
  }

  const failCases = results.filter((r) => r.expect.verdict === 'fail');
  const passCases = results.filter((r) => r.expect.verdict === 'pass');
  const hit = results.filter((r) => r.outcome === 'hit').length;
  const miss = results.filter((r) => r.outcome === 'miss').length;
  const falseAlarm = results.filter((r) => r.outcome === 'false-alarm').length;
  const unsure = results.filter((r) => r.outcome === 'unsure').length;

  return {
    setDir: opts.dir ?? EVALS_REL,
    cases: results,
    // ★分母是「该类用例数」；为 0 时 null（「没测过」与「测了 0%」必须形状不同）
    detectionRate: failCases.length === 0 ? null : Number((hit / failCases.length).toFixed(3)),
    falseAlarmRate: passCases.length === 0 ? null : Number((falseAlarm / passCases.length).toFixed(3)),
    unsureRate: results.length === 0 ? null : Number((unsure / results.length).toFixed(3)),
    counts: {
      total: results.length,
      fail: failCases.length,
      pass: passCases.length,
      hit, miss, falseAlarm, unsure,
    },
  };
}
