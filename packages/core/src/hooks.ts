import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 章末钩子锚词校验。
 *
 * ## 它治什么
 * buildPrompt 的 draft 分支只有一句自然语言「章末留钩子」，没有任何机器核对，
 * 写手回应个意思就过去了。本模块把「说了但没做」变成机器能看见的**线索**。
 *
 * ## 它治不了什么（**务必先读这段，否则一定会误用**）
 * 实测对真书 34 章做过人工对账，结论是：**细纲标的是「意图」，正文写的是「变体」**。
 *   - 细纲 ch11：「这台仪器前天刚校准。除非……它读的压根不是你现在这个数」
 *     正文 ch11：「这台仪器前天刚由省局技术处做过深度校准…除非……它今天读出来的，压根就不是你现在真正的数」
 *     钩子留得比细纲还好，词面却对不上——实例化必然改写措辞。
 *   - 细纲 ch17 的对白是原话，正文把后半段整段重写了。
 * 因此在「对白有没有被改写」这个粒度上，**词面匹配本质上不可靠**，做再多的松紧调参也无法收敛。
 *
 * 所以本模块只报一种信号：**锚词片段一个都没出现在末尾窗口**。
 * 那是「这一章的钩子跟细纲标的完全不是一件事」的线索，值得人去看一眼；
 * 它**绝不等价于「没留钩子」**，更不是质量分。
 *
 * 使用纪律：
 *   - 红灯只当**人工复核的入口**，不当结论。看到红灯先自己读末段再判断。
 *   - 别把红灯接进 CI 硬失败，那会把「作者有意改写」误杀成「质量缺陷」。
 *   - 真要「钩子留没留」的可靠判定，只有两条路：人工读，或让 LLM 做语义比对
 *     （LLM 判定可加，但那是另一个模块，不要伪装成词面校验）。
 */
export interface HookSpec {
  /** 章号 */
  chapterNo: number;
  /** 锚词，任一命中即算有钩（OR 关系）。空数组 = 该章没标锚词，跳过校验 */
  anchors: string[];
  /** 末尾窗口长度（码点），默认 120 */
  tailChars: number;
}

/** 默认末尾窗口：码点 */
export const DEFAULT_HOOK_TAIL_CHARS = 120;

/**
 * 锚词判定的最短长度。短于此的片段（如单个「碗」）词面噪音太大，
 * 容易在任何句子里偶然命中——那还不如不判。
 */
const MIN_ANCHOR_LEN = 4;

export interface HookCheckResult {
  ok: boolean;
  /** 是否因为没标锚词而跳过（ok 为 true 但 checked 为 false，两者不可混淆） */
  checked: boolean;
  /** 实际取出参与比对的末段（供人眼复核，别只给个 true/false） */
  tail: string;
  /** 逐锚词命中情况 */
  hits: Record<string, boolean>;
}

/**
 * 从长锚词里切出可判定的片段。
 *
 * 为什么不做整串全等：实测过，写手把「都给我留一份」写成「都得给我留一份」、
 * 「我要是进了正赛」写成「我要是真打进了正赛」，钩子明明留了，全等匹配却报红灯。
 * 那种假红比不校验更坏——会让人不再信这个校验器。
 *
 * 切法：按标点断成子句，取长度 >= MIN_ANCHOR_LEN 的子句；若一个都没有（锚词本身很短），
 * 则退化为「滑窗取 4 字片段」。宁可松一点、只抓「整段钩子根本没写」，
 * 也不要天天误报、最后被无视。
 */
function toFragments(anchor: string): string[] {
  const parts = anchor
    .split(/[。！？；，、,;!?…「」“”"'（）()【】\[\]\s]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_ANCHOR_LEN);
  if (parts.length > 0) return parts;
  // 退化：锚词太短，取前 4 个码点当片段（仍比整串全等松，但至少有区分度）
  const cps = [...anchor];
  return cps.length >= MIN_ANCHOR_LEN ? [cps.slice(0, MIN_ANCHOR_LEN).join('')] : [];
}

/**
 * 词面校验。字数口径必须与 state.ts 的 countWords 一致：
 * 剥空白后按**码点**算，不用 str.length（emoji 会按 UTF-16 算成两个）。
 */
export function checkHookAnchor(
  text: string,
  anchors: string[],
  tailChars = DEFAULT_HOOK_TAIL_CHARS,
): HookCheckResult {
  const stripped = text.replace(/\s/g, '');
  const tail = [...stripped].slice(-tailChars).join('');
  if (anchors.length === 0) {
    // 没标锚词 ≠ 通过。checked: false 让调用方能把它和「真检过」区分开
    return { ok: true, checked: false, tail, hits: {} };
  }
  const hits: Record<string, boolean> = {};
  for (const a of anchors) {
    hits[a] = toFragments(a).some((frag) => tail.includes(frag));
  }
  return { ok: Object.values(hits).some(Boolean), checked: true, tail, hits };
}

/**
 * 从细纲解析每章的钩子锚词。
 *
 * 兼容真书既有标注格式（不逼人重写 60 章细纲）：
 *   1 榜尾王座：……｜钩子·对白炸弹：「再信你一次」
 *   - 章号是行首的裸数字，标题接中文冒号
 *   - 钩子段以全角竖线 ｜ 分隔，形如「钩子·<型>：<内容>」
 * 锚词自动提炼（取内容里最长的 2–4 个中文片段），也可在行内显式写
 *   `hookAnchors: ["碗","碎"]` 覆盖自动提炼。
 *
 * 解析失败的行静默跳过——细纲是人工文档，格式不会永远规整，
 * 这里宁少报不误报（误报会让人不信校验器，比不校验更糟）。
 */
export function parseHookSpecs(outlineText: string): HookSpec[] {
  const specs: HookSpec[] = [];
  for (const rawLine of outlineText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    // 章号 + 标题：形如 "5 被盯上：许昂察觉异样…"
    const head = /^(\d+)\s+\S/.exec(line);
    if (head === null) continue;
    const chapterNo = Number.parseInt(head[1]!, 10);

    // 显式锚词优先
    const explicit = /hookAnchors\s*:\s*\[([^\]]*)\]/.exec(line);
    if (explicit !== null) {
      const anchors = [...explicit[1]!.matchAll(/["'“”]([^"'“”]+)["'“”]/g)].map((m) => m[1]!);
      specs.push({ chapterNo, anchors, tailChars: DEFAULT_HOOK_TAIL_CHARS });
      continue;
    }

    // 既有标注：｜钩子·<型>：<内容>
    const hook = /｜\s*钩子·[^：:]*[：:]\s*(.+)$/.exec(line);
    if (hook === null) continue;
    specs.push({ chapterNo, anchors: extractAnchors(hook[1]!), tailChars: DEFAULT_HOOK_TAIL_CHARS });
  }
  return specs;
}

/**
 * 锚词提炼：从细纲的钩子描述里挑「正文里最可能原样出现」的片段。
 *
 * 设计原则是**只挑高置信度的**，宁可少标不可乱标：
 * 锚词一旦提错（比如把人名当锚词），红灯就是噪音，整个校验器会被无视。
 * 实测踩过的坑：从 ch26「点名点到「林小满」时她顿了一下」提出锚词「林小满」——
 * 人名在正文里必然出现，这类锚词毫无区分度。
 *
 * 取法：
 *  1. 只取引号内的内容（细纲已用「」/"" 标出最终对白与画面，那是作者的显式承诺）
 *  2. 丢掉疑似人名（2–4 字且是纯中文姓名形，无标点、无实义词）
 *  3. 丢掉过短的（< MIN_ANCHOR_LEN 码点，词面噪音太大）
 *  4. 最多取 3 条；一条都取不到就返回空 → 该章 checked=false，不参与判定
 */
function extractAnchors(desc: string): string[] {
  const out: string[] = [];
  for (const m of desc.matchAll(/[「“"]([^」”"]{2,40})[」”"]/g)) {
    const s = m[1]!.trim();
    if ([...s].length < MIN_ANCHOR_LEN) continue;   // 太短，易偶然命中
    if (looksLikeName(s)) continue;                 // 人名，没有区分度
    out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 粗判人名：2–3 个中文汉字、无标点、且不在常见实义词里。
 * 这是启发式，不追求全准——漏掉一个人名只是多一条弱锚词，
 * 误杀一个正常短语会让该章漏检（checked=false），那才是更坏的错。
 * 所以判定刻意收窄：只认「纯 2–3 汉字」且不是常见词的那种。
 */
function looksLikeName(s: string): boolean {
  const cps = [...s];
  if (cps.length < 2 || cps.length > 3) return false;
  if (!cps.every((c) => /\p{Script=Han}/u.test(c))) return false;
  // 含常见实义字（动词/名词性）的，基本不是人名
  const meaningful = /[一二三四五六七八九十百千万的了是在有不没这那人我你他她它们说走看想做吃跑打来去上下大小多少新旧]/u;
  return !meaningful.test(s);
}

/** 读细纲文件并解析；文件不存在返回空数组（不是每本书都有细纲） */
export async function readHookSpecs(bookRoot: string, outlineRel: string): Promise<HookSpec[]> {
  const raw = await readFile(path.join(bookRoot, outlineRel), 'utf-8').catch(() => null);
  return raw === null ? [] : parseHookSpecs(raw);
}

export interface HookAuditEntry extends HookCheckResult {
  chapterNo: number;
  file: string;
  anchors: string[];
}

/**
 * 对整本书跑钩子校验。返回清单（含跳过项），由调用方决定怎么报。
 * 无锚词的章 checked=false，**不计入失败**——那是「没标」，不是「没勾」。
 */
export async function auditHooks(
  bookRoot: string,
  chapters: { chapterNo: number; file: string }[],
  specs: HookSpec[],
): Promise<HookAuditEntry[]> {
  const specMap = new Map(specs.map((s) => [s.chapterNo, s]));
  const out: HookAuditEntry[] = [];
  for (const ch of chapters) {
    const spec = specMap.get(ch.chapterNo);
    if (spec === undefined) continue;
    const text = await readFile(path.join(bookRoot, 'chapters', ch.file), 'utf-8').catch(() => null);
    if (text === null) continue;
    const r = checkHookAnchor(text, spec.anchors, spec.tailChars);
    out.push({ ...r, chapterNo: ch.chapterNo, file: ch.file, anchors: spec.anchors });
  }
  return out;
}
