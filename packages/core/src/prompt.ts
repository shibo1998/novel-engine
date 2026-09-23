import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readState } from './state.js';
import { assembleLongContext, CONTEXT_CHAR_CAP } from './summaries.js';
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
  // rules 加载：book.json 显式声明（rules.author / rules.plugin），缺键视为空声明
  const rulesDecl = (cfg['rules'] ?? {}) as { author?: string[]; plugin?: string[] };
  const { text: rules, refs: ruleRefs } = await loadRules(root, rulesDecl);

  const entry = state.chapters.find((c) => c.chapterNo === o.chapterNo);
  const prev = state.chapters.find((c) => c.chapterNo === o.chapterNo - 1);
  const prevTail = prev !== undefined ? await readPrevTail(root, prev.file) : '';

  // 4.9 长文上下文：最近 2 章摘要 + 关键词相关 2 章摘要（摘要缺失 = 显式标注「暂无」，非静默跳过）
  const longCtx = await assembleLongContext(root, o.chapterNo, prevTail);
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

  const system = [IDENTITY, canon, ...rules].filter((s) => s.trim() !== '').join('\n\n');

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
      '# 上一章结尾（仅作衔接参考，禁止复述）',
      prevTail !== '' ? prevTail : '（无上一章：本章从全新场景开场）',
      '',
      summarySection,
      '',
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
      `# 待修问题（共 ${findings.length} 条；行号 0 表示整章级问题）`,
      findings.length > 0 ? findings.map(formatFinding).join('\n') : '（空）',
      '',
      '# 本章当前正文',
      current,
    ].join('\n');
  }

  return { system, user, ruleRefs };
}
