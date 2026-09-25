import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readState } from './state.js';
import { assembleLongContext, CONTEXT_CHAR_CAP } from './summaries.js';
import { checkChapterReadiness } from './readiness.js';
import type { BuildPromptOptions, GateFinding, PromptBundle, RuleRefs } from './types.js';

/** 声明了但磁盘上不存在的规则文件——显式报错，绝不静默跳过（「没生效」和「没写」不能长得一样） */
export class RuleFileMissing extends Error {
  constructor(public readonly relPath: string) {
    super(`规则文件不存在: ${relPath}`);
    this.name = 'RuleFileMissing';
  }
}

/**
 * rules 分组加载：book.json 显式声明启用集，不扫目录、不递归。
 * 路径相对 .soloent/；author 先拼、plugin 后拼（手写规则优先级高于插件规则）。
 * 子目录文件（如 rules/active-plugin-rules/x.md）必须在清单里显式写全路径才会加载。
 */
export async function loadRules(
  bookRoot: string,
  decl: { author?: string[]; plugin?: string[] },
): Promise<{ text: string[]; refs: RuleRefs }> {
  const base = path.join(bookRoot, '.soloent');
  const load = async (list: string[] | undefined): Promise<string[]> => {
    const out: string[] = [];
    for (const rel of list ?? []) {
      const abs = path.join(base, rel);
      let content: string;
      try {
        content = await readFile(abs, 'utf-8');
      } catch {
        throw new RuleFileMissing(rel);
      }
      out.push(content);
    }
    return out;
  };
  const [a, p] = [await load(decl.author), await load(decl.plugin)];
  return {
    text: [...a, ...p],
    refs: { author: decl.author ?? [], plugin: decl.plugin ?? [] },
  };
}

export interface RuleAudit {
  /** book.json 里声明的路径（原样，相对 .soloent/） */
  declared: string[];
  /** .soloent/rules/ 下实际存在的 .md（相对 .soloent/rules/，已按目录排序） */
  onDisk: string[];
  /** 文件在磁盘上、但没被任何声明覆盖 —— 等于没加载。**已排除 forbid（有意不启用）** */
  undeclared: string[];
  /** 声明了但磁盘上不存在 —— 会在 loadRules 抛 RuleFileMissing */
  missing: string[];
  /** 在 forbid 清单里 —— **有意不启用**，不是漏声明 */
  forbidden: string[];
}

/**
 * 规则「文件在但没声明」审计。
 *
 * 治的是这类隐性故障：rules/active-plugin-rules/ 下躺着一批 .md，
 * 但 book.json 的 rules.author / rules.plugin 里没列它们，
 * loadRules 不扫目录也不递归 → 这些文件**一个都不生效**，
 * 而 buildPrompt 照常成功、闸门照常全绿，你只会觉得「改了 prompt 怎么没效果」。
 *
 * **必须认识 `rules.forbid`**：那是作者显式表达「这文件我看过、判定不适用本书」的地方
 * （如 rhythm-paragraph-length.md 被判为与 story-style.md 的段落观冲突）。
 * 不认 forbid 会把它一路报成「漏声明」——4 条永久噪音，真问题就被淹没了。
 * 信噪比比覆盖率重要：宁可少报，不可常报。
 *
 * 只读不写，不抛错：此函数的存在意义就是把「静默」变成「可见」，
 * 它自己不许再成为新的静默点。
 */
export async function auditRules(bookRoot: string): Promise<RuleAudit> {
  const base = path.join(path.resolve(bookRoot), '.soloent');
  const rulesDir = path.join(base, 'rules');

  const readList = async (key: string): Promise<string[]> => {
    const raw = await readFile(path.join(base, 'book.json'), 'utf-8').catch(() => null);
    if (raw === null) return [];
    try {
      const cfg = JSON.parse(stripBom(raw)) as { rules?: Record<string, unknown> };
      const list = cfg.rules?.[key];
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const declared = [...(await readList('author')), ...(await readList('plugin'))];
  const forbidden = await readList('forbid');

  // 递归扫 rules/ 全层（含子目录）——子目录正是最容易被漏声明的地方
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: string[] = [];
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      // _candidates/ 是 recordFeedback 产出的**待审候选**，按设计就不生效（人工提炼后才提升）。
      // 把它算进「漏声明」会把真问题淹掉，这里整目录排除。
      if (e.isDirectory()) {
        if (e.name === '_candidates') continue;
        out.push(...(await walk(abs)));
      } else if (e.name.toLowerCase().endsWith('.md')) {
        // 相对 .soloent/ 的路径，分隔符统一为 /，与 book.json 里的写法同形
        out.push(path.relative(base, abs).split(path.sep).join('/'));
      }
    }
    return out;
  };
  const onDisk = (await walk(rulesDir)).sort();

  // 声明路径归一：分隔符统一 + 去 ./ 前缀，两端才可比
  const norm = (p: string): string => p.split('\\').join('/').replace(/^\.\//, '');
  const declaredSet = new Set(declared.map(norm));
  const forbiddenSet = new Set(forbidden.map(norm));
  const onDiskSet = new Set(onDisk);

  return {
    declared,
    onDisk,
    // forbid 里的排除在外：那是有意不启用，不是漏声明
    undeclared: onDisk.filter((f) => !declaredSet.has(f) && !forbiddenSet.has(f)),
    missing: declared.map(norm).filter((f) => !onDiskSet.has(f)),
    forbidden: onDisk.filter((f) => forbiddenSet.has(f)),
  };
}

/**
 * 上一章结尾衔接段长度（码点）。
 * 注意：prevTail 只能读上一章文件——state 只存索引，正文永不入 JSON。
 */
const PREV_TAIL_CHARS = 800;
const IDENTITY = [
  '你是中文网络小说的执笔助手，为当前书籍项目撰写或修订正文章节。',
  '必须遵守 canon 与 rules 中的全部设定与禁令，不得引入与 canon 冲突的新设定。',
  '只输出章节正文本身：不要解释、不要提纲、不要「以下是正文」类前缀。',
].join('\n');

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/** 读上一章结尾 N 码点；文件不存在或读取失败返回空串（由上层决定开场方式） */
async function readPrevTail(root: string, file: string): Promise<string> {
  const text = await readFile(path.join(root, 'chapters', file), 'utf-8').catch(() => '');
  if (text === '') return '';
  const body = stripBom(text).replace(/\s+$/u, '');
  return [...body].slice(-PREV_TAIL_CHARS).join('');
}

interface BookMeta {
  title: string;
  genre: string;
  platform: string;
}

/** book.json 结构：书籍信息在 book 段；缺字段一律空串，不抛错 */
function extractBookMeta(cfg: Record<string, unknown>): BookMeta {
  const sec = (cfg['book'] ?? {}) as Record<string, unknown>;
  const pick = (k: string): string => (typeof sec[k] === 'string' ? (sec[k] as string) : '');
  return { title: pick('title'), genre: pick('genre'), platform: pick('platform') };
}

/** 当前状态卡上限（码点）：与摘要段同量级，防 now.md 越写越长把上下文吃光 */
const STATE_CARD_CHAR_CAP = 3000;
const STATE_CARD_DEFAULT_PATH = '.soloent/memory/now.md';

/**
 * 当前状态卡（B-01）：draft 追加块，读 book.json 的 paths.now（缺省 .soloent/memory/now.md）。
 * 只追加，不改动其它块。文件缺失、或仍是 init 的「（待填）」占位 → 返回空串（不注入空壳）。
 */
async function readStateCard(root: string, cfg: Record<string, unknown>): Promise<string> {
  const paths = (cfg['paths'] ?? {}) as Record<string, unknown>;
  const rel = typeof paths['now'] === 'string' && paths['now'] !== '' ? (paths['now'] as string) : STATE_CARD_DEFAULT_PATH;
  const raw = stripBom(await readFile(path.join(root, rel), 'utf-8').catch(() => '')).trim();
  const body = raw.replace(/^#[^\n]*\n?/, '').trim();
  if (body === '' || /^[（(]待填[）)]$/.test(body)) return '';
  const chars = [...raw];
  const text = chars.length <= STATE_CARD_CHAR_CAP
    ? raw
    : chars.slice(0, STATE_CARD_CHAR_CAP).join('') + '\n（……超出上限，已截断）';
  return [`# 当前状态卡（来源：${rel}；人物境界/位置/伤势/持有物、未回收伏笔以此为准）`, text].join('\n');
}

function formatFinding(f: GateFinding): string {
  const where = f.line > 0 ? `第 ${f.line} 行` : '整章';
  const detail = f.detail !== '' ? `｜原文：${f.detail}` : '';
  return `- [${f.severity}] ${where}｜${f.check}${detail}`;
}

export async function buildPrompt(o: BuildPromptOptions): Promise<PromptBundle> {
  const root = path.resolve(o.bookRoot);
  if (o.mode === 'revise' && o.findings === undefined) {
    throw new Error('buildPrompt：revise 模式必须带 findings');
  }
  const state = await readState({ bookRoot: root });
  const dir = path.join(root, '.soloent');
  const cfg = JSON.parse(stripBom(await readFile(path.join(dir, 'book.json'), 'utf-8'))) as Record<string, unknown>;
  const meta = extractBookMeta(cfg);
  const canon = await readFile(path.join(dir, 'canon.md'), 'utf-8').catch(() => '');
  const readiness = await checkChapterReadiness(root, o.chapterNo);
  // rules 加载：book.json 显式声明（rules.author / rules.plugin），缺键视为空声明
  const rulesDecl = (cfg['rules'] ?? {}) as { author?: string[]; plugin?: string[] };
  const { text: rules, refs: ruleRefs } = await loadRules(root, rulesDecl);

  const entry = state.chapters.find((c) => c.chapterNo === o.chapterNo);
  const prev = state.chapters.find((c) => c.chapterNo === o.chapterNo - 1);
  const prevTail = prev !== undefined ? await readPrevTail(root, prev.file) : '';

  // 4.9 长文上下文：最近 2 章摘要 + 关键词相关 2 章摘要（摘要缺失 = 显式标注「暂无」，非静默跳过）
  const longCtx = await assembleLongContext(root, o.chapterNo, prevTail, readiness.outlineText ?? '');
  const summarySection = ((): string => {
    const blocks: string[] = [];
    if (longCtx.recentSummaries.length > 0) {
      blocks.push('# 近期章节摘要', ...longCtx.recentSummaries.map((s) => `- 第 ${s.chapterNo} 章：${s.summary}`));
    }
    if (longCtx.relatedSummaries.length > 0) {
      blocks.push('# 相关章节摘要', ...longCtx.relatedSummaries.map((s) => `- 第 ${s.chapterNo} 章：${s.summary}`));
    }
    if (blocks.length === 0) return '# 章节摘要\n（暂无：summaries.json 尚未生成任何摘要）';
    const joined = blocks.join('\n');
    return [...joined].length <= CONTEXT_CHAR_CAP
      ? joined
      : [...joined].slice(0, CONTEXT_CHAR_CAP).join('') + '\n（……超出上下文上限，已截断）';
  })();

  // 细纲来源可能是「按章文件」，也可能是「从卷纲里抠出的本章段」——标题必须如实说明是哪一种。
  // 不说清的话，模型（和人）会把卷级背景当成本章细纲，照着错的章去写且看不出错。
  const outlineHeading = readiness.outlineText === null
    ? '# 本章细纲（未找到可用细纲）'
    : readiness.outlineScope === 'chapter'
      ? `# 本章细纲（来源：${readiness.outlineFile}）`
      : readiness.outlineChapterSectionMissing
        ? `# 卷级背景（来源：${readiness.outlineFile}；未能定位到第 ${o.chapterNo} 章段落）`
        : `# 本章细纲（来源：${readiness.outlineFile} 的第 ${o.chapterNo} 章段）`;
  const outlineSection = [
    outlineHeading,
    readiness.outlineText
      ?? '（暂无细纲；如需严格按章纲写作，请补充对应文件，或在该书 book.json 的 paths.outline 指定卷纲。）',
    '',
    '# 写前提醒（仅提示，不阻断写作）',
    ...(readiness.warnings.length > 0 ? readiness.warnings.map((warning) => `- ${warning}`) : ['- 未发现缺项。']),
  ];

  const system = [IDENTITY, canon, ...rules].filter((s) => s.trim() !== '').join('\n\n');
  const stateCard = await readStateCard(root, cfg);

  let user: string;
  if (o.mode === 'draft') {
    user = [
      `# 任务：撰写第 ${o.chapterNo} 章`,
      `书籍：${meta.title}（${meta.genre}｜${meta.platform}）`,
      entry?.title !== undefined && entry.title !== ''
        ? `本章既定标题：${entry.title}`
        : '本章标题自拟',
      '目标篇幅：2300–4000 字（去空白码点计）',
      '',
      ...outlineSection,
      '',
      '# 上一章结尾（仅作衔接参考，禁止复述）',
      prevTail !== '' ? prevTail : '（无上一章：本章从全新场景开场）',
      '',
      summarySection,
      '',
      ...(stateCard !== '' ? [stateCard, ''] : []),
      '# 要求',
      '- 直接续写上一章之后的情节，不回头复述已发生内容',
      '- 单章一个主冲突，章末留钩子',
      '- 遵守 system 中 canon 与全部 rules',
    ].join('\n');
  } else {
    if (entry === undefined) {
      throw new Error(`buildPrompt：第 ${o.chapterNo} 章不在索引中，无法 revise`);
    }
    const current = stripBom(await readFile(path.join(root, 'chapters', entry.file), 'utf-8'));
    const findings = o.findings ?? [];
    user = [
      `# 任务：修订第 ${o.chapterNo} 章（${entry.file}）`,
      '仅修复下方「待修问题」命中的位置，其余文句保持原样，不得顺手改写。',
      '',
      ...outlineSection,
      '',
      `# 待修问题（共 ${findings.length} 条；行号 0 表示整章级问题）`,
      findings.length > 0 ? findings.map(formatFinding).join('\n') : '（空）',
      '',
      '# 本章当前正文',
      current,
    ].join('\n');
  }

  return { system, user, ruleRefs };
}
