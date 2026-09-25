import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callLLM, type CallLLMOptions } from './llm.js';
import type { LLMError } from './types.js';

/**
 * Arbiter：四类封闭裁定（B-43 / v0.2 M13）。
 *
 * 治的是什么：写作过程中有几类**二选一/多选一**的决定（走哪条线、这一招的波及面、
 * 怎么脱身、这个爽点派给谁），模型直接替作者定了，而作者事后才发现——
 * 那时候已经写了好几章。
 *
 * ★五条纪律，每一条都是为了「不让模型悄悄替人做决定」：
 *
 * 1. **封闭题型，候选集由 Engine 给全**（13.1）。模型只能**从中选一个**，
 *    不能自己造。返回不在候选集里的值 → **判无效**（失败关闭），不猜它想说什么。
 *    为什么：开放题让模型自由发挥，等于把「决定」变成了「创作」——
 *    而这一步的定位是**裁定**，不是写。
 *
 * 2. **默认人工**（13.2）。四类都默认交人：`auto` 不开就**直接返回 `human-needed`，
 *    连模型都不调**。为什么默认关：这些决定影响几十章，而「自动」一旦是默认，
 *    作者会在不知情的情况下被替做决定。
 *
 * 3. **自洽采样 3 次，不一致 → 交人**（13.3）。**不用模型自报的置信度**——
 *    自报置信度是没有校准的数字，而「同一题问三次答案一样吗」是可验证的事实。
 *    三次一致才采信；不一致说明这题本身有歧义，那正是人该介入的地方。
 *
 * 4. **只选不写**（13.4）。输出里**没有正文**，只有「选了哪个 + 一句理由」。
 *    裁定层碰正文，就会从「选择」滑向「创作」。
 *
 * 5. **落盘 `state/decisions/d-XXXX.json`**（13.5）。决定要能回溯——
 *    「第 30 章为什么走了这条路」半年后必须答得出来。
 */

export type ArbiterKind = 'pick-strategy' | 'blast-radius' | 'escape-route' | 'assign-payoff';

export const ARBITER_KINDS: ReadonlyArray<{ kind: ArbiterKind; label: string; desc: string }> = [
  { kind: 'pick-strategy', label: '走哪条线', desc: '多条可行路线里选一条（候选由调用方给全）' },
  { kind: 'blast-radius', label: '波及面', desc: '这一手影响到谁、影响到什么程度' },
  { kind: 'escape-route', label: '怎么脱身', desc: '困境的解法（候选由调用方给全）' },
  { kind: 'assign-payoff', label: '爽点派给谁', desc: '这次兑现由哪个角色承担' },
];

export interface ArbiterQuestion {
  kind: ArbiterKind;
  /** 问题描述（给人看的那句话） */
  prompt: string;
  /** ★候选集，**由 Engine 给全**。模型只能从中选一个 */
  candidates: string[];
  /** 上下文（可选）。只放**已发生的事实**，不要放「你希望它选哪个」 */
  context?: string;
}

export interface ArbiterDecision {
  /** `d-0001` */
  id: string;
  at: string;
  question: ArbiterQuestion;
  /** 谁做的决定 */
  by: 'human' | 'llm' | 'human-needed';
  /** 选中的候选（by = human / llm 时才有） */
  choice?: string;
  /** 自洽采样的三次原始结果（by = llm 时才有；不一致时也留着供排查） */
  samples?: string[];
  reason: string;
}

const DECISIONS_DIR = 'state/decisions';
/** 自洽采样次数（13.3 明文 3 次） */
export const ARBITER_SAMPLES = 3;

function decisionsDir(root: string): string {
  return path.join(root, DECISIONS_DIR);
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

async function nextSeq(root: string): Promise<number> {
  const files = await readdir(decisionsDir(root)).catch(() => [] as string[]);
  const max = files
    .filter((f) => /^d-\d+\.json$/.test(f))
    .reduce((m, f) => Math.max(m, Number(f.replace(/^d-|\.json$/g, '')) || 0), 0);
  return max + 1;
}

async function save(root: string, d: ArbiterDecision): Promise<void> {
  await atomicWrite(path.join(decisionsDir(root), `${d.id}.json`), JSON.stringify(d, null, 2) + '\n');
}

export async function listDecisions(bookRoot: string): Promise<ArbiterDecision[]> {
  const root = path.resolve(bookRoot);
  const files = await readdir(decisionsDir(root)).catch(() => [] as string[]);
  const out: ArbiterDecision[] = [];
  for (const f of files.filter((x) => /^d-\d+\.json$/.test(x)).sort()) {
    const raw = await readFile(path.join(decisionsDir(root), f), 'utf-8').catch(() => null);
    if (raw === null) continue;
    try {
      out.push(JSON.parse(raw.replace(/^\uFEFF/, '')) as ArbiterDecision);
    } catch {
      // 残文件：跳过（不因为一个坏文件让整份清单读不出来）
    }
  }
  return out;
}

export class ArbiterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArbiterError';
  }
}

/** 校验题型与候选集。**候选集为空 = 无从裁定**，直接拒绝（不交给模型自由发挥） */
export function assertQuestion(q: ArbiterQuestion): void {
  if (!ARBITER_KINDS.some((k) => k.kind === q.kind)) {
    throw new ArbiterError(`未知题型「${q.kind}」；可用：${ARBITER_KINDS.map((k) => k.kind).join(' / ')}`);
  }
  if (q.candidates.length < 2) {
    throw new ArbiterError(
      `题型 ${q.kind} 的候选集少于 2 项（实得 ${q.candidates.length}）——`
        + '没有可选的东西就不是裁定。**候选集必须由调用方给全**，不接受模型自己造。',
    );
  }
  const dup = q.candidates.filter((c, i) => q.candidates.indexOf(c) !== i);
  if (dup.length > 0) throw new ArbiterError(`候选集有重复项：${[...new Set(dup)].join('、')}（会污染「三次一致」的判定）`);
}

/** 从模型输出里抠出它选的那一项。**只认候选集里的字面值**，模糊匹配一律判无效 */
export function parseChoice(text: string, candidates: string[]): string | null {
  const t = text.trim();
  // 先试整段就是一个候选
  const exact = candidates.find((c) => c === t);
  if (exact !== undefined) return exact;
  // 再试 JSON 的 {"choice": "..."}
  const m = /"choice"\s*:\s*"([^"]*)"/.exec(t);
  if (m !== null) {
    const hit = candidates.find((c) => c === m[1]);
    if (hit !== undefined) return hit;
  }
  // 最后试「输出里出现了且只出现了一个候选」（模型爱加解释）
  const mentioned = candidates.filter((c) => t.includes(c));
  return mentioned.length === 1 ? (mentioned[0] as string) : null;
}

export interface AskArbiterOptions {
  /**
   * 是否允许自动裁定。**默认 false**（13.2）——不开就直接交人，连模型都不调。
   * 为什么默认关：这些决定影响几十章，而「自动」一旦是默认，
   * 作者会在不知情的情况下被替做决定。
   */
  auto?: boolean;
  llm?: CallLLMOptions;
}

/**
 * 提请裁定。
 *
 * - `auto` 不开（默认）→ **不调模型**，直接落一条 `by: 'human-needed'`。
 * - `auto` 开 → 自洽采样 3 次；三次一致才采信，否则交人。
 *
 * 返回的 `ArbiterDecision` 里**没有正文**——裁定层只选不写（13.4）。
 */
export async function askArbiter(
  bookRoot: string,
  question: ArbiterQuestion,
  opts: AskArbiterOptions = {},
): Promise<ArbiterDecision | LLMError> {
  const root = path.resolve(bookRoot);
  assertQuestion(question);
  const seq = await nextSeq(root);
  const id = `d-${String(seq).padStart(4, '0')}`;
  const base = { id, at: new Date().toISOString(), question };

  if (opts.auto !== true) {
    const d: ArbiterDecision = {
      ...base,
      by: 'human-needed',
      reason: '默认人工裁定（未开 auto）。这些决定影响几十章，不替作者决定。',
    };
    await save(root, d);
    return d;
  }

  const system = [
    '你是小说创作流程里的**裁定员**。只做**选择**，不写正文、不解释剧情。',
    '',
    '输出格式（只输出 JSON，不要任何解释文字、不要 markdown 围栏）：',
    '{"choice":"<从候选里原样复制一项>","reason":"一句话理由"}',
    '',
    '纪律：',
    '- `choice` 必须与候选列表里的某一项**逐字相同**，不要改写、不要新造；',
    '- 只能从给定候选里选，**没有第五个选项**；',
    '- 不写正文，不续写情节。',
  ].join('\n');
  const user = [
    `# 题型\n${question.kind}（${ARBITER_KINDS.find((k) => k.kind === question.kind)?.label ?? ''}）`,
    '',
    `# 问题\n${question.prompt}`,
    '',
    '# 候选（只能从中选一项）',
    ...question.candidates.map((c, i) => `${i + 1}. ${c}`),
    ...(question.context !== undefined && question.context.trim() !== ''
      ? ['', '# 已发生的事实（只作依据，不要改写）', question.context.trim()]
      : []),
  ].join('\n');

  const samples: string[] = [];
  for (let i = 0; i < ARBITER_SAMPLES; i++) {
    // 温度 0.8：自洽采样要的是「同一个问题换个说法答案还一样吗」，
    // 温度太低会让三次退化成一次，采样就失去意义了
    const r = await callLLM(
      { system, user, ruleRefs: { author: [], plugin: [] } },
      { temperature: 0.8, purpose: 'judge', ...opts.llm },
    );
    if (!r.ok) return r;
    const picked = parseChoice(r.text, question.candidates);
    samples.push(picked ?? `(无效：${r.text.trim().slice(0, 80)})`);
  }

  const valid = samples.filter((s) => question.candidates.includes(s));
  const distinct = [...new Set(valid)];
  if (valid.length !== ARBITER_SAMPLES) {
    const d: ArbiterDecision = {
      ...base, by: 'human-needed', samples,
      reason: `${ARBITER_SAMPLES} 次采样里有 ${ARBITER_SAMPLES - valid.length} 次没能选出候选集里的项——交人。`,
    };
    await save(root, d);
    return d;
  }
  if (distinct.length > 1) {
    const d: ArbiterDecision = {
      ...base, by: 'human-needed', samples,
      reason: `${ARBITER_SAMPLES} 次采样结果不一致（${distinct.join(' / ')}）——这题本身有歧义，交人。`,
    };
    await save(root, d);
    return d;
  }
  const d: ArbiterDecision = {
    ...base, by: 'llm', samples, choice: distinct[0] as string,
    reason: `${ARBITER_SAMPLES} 次采样一致。`,
  };
  await save(root, d);
  return d;
}

/** 人工裁定（默认路径）。**必须给出理由**——半年后要能回答「为什么走这条路」 */
export async function recordHumanDecision(
  bookRoot: string,
  question: ArbiterQuestion,
  choice: string,
  reason: string,
): Promise<ArbiterDecision> {
  const root = path.resolve(bookRoot);
  assertQuestion(question);
  if (!question.candidates.includes(choice)) {
    throw new ArbiterError(
      `人工选定的「${choice}」不在候选集里。候选：${question.candidates.join(' / ')}\n`
        + '  （候选集是裁定的边界——要加选项，先把它加进候选集，别让决定落在边界外。）',
    );
  }
  if (reason.trim() === '') throw new ArbiterError('人工裁定必须给 --reason：半年后要能回答「为什么走这条路」');
  const seq = await nextSeq(root);
  const d: ArbiterDecision = {
    id: `d-${String(seq).padStart(4, '0')}`,
    at: new Date().toISOString(),
    question, by: 'human', choice, reason: reason.trim(),
  };
  await save(root, d);
  return d;
}
