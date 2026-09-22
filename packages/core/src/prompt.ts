import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readState } from './state.js';
import type { BuildPromptOptions, GateFinding, PromptBundle } from './types.js';

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
  // rules 目录可能不存在：兜空数组；只收顶层 .md（子目录如 active-plugin-rules/ 暂不展开）
  const ruleNames = await readdir(path.join(dir, 'rules'))
    .then((names) => names.filter((n) => n.endsWith('.md')).sort())
    .catch(() => [] as string[]);
  const rules = await Promise.all(
    ruleNames.map((n) => readFile(path.join(dir, 'rules', n), 'utf-8').catch(() => '')),
  );

  const entry = state.chapters.find((c) => c.chapterNo === o.chapterNo);
  const prev = state.chapters.find((c) => c.chapterNo === o.chapterNo - 1);
  const prevTail = prev !== undefined ? await readPrevTail(root, prev.file) : '';

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

  return { system, user, ruleRefs: ruleNames };
}
