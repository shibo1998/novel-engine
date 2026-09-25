import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cfgString, readBookConfig } from './bookcfg.js';
import { chapterFileCandidates, resolveExistingFile } from './naming.js';

/** 细纲注入上限（字符）。卷纲动辄 15–20KB，整段塞进 user 既烧 token 又冲淡任务描述。 */
export const OUTLINE_CHAR_CAP = 4000;

export type OutlineScope = 'chapter' | 'volume';

export interface ChapterReadiness {
  chapterNo: number;
  /** 实际用到的细纲文件（相对书根）；一个都没找到时为空串 */
  outlineFile: string;
  /** 用于注入的细纲文本；无可用细纲时为 null */
  outlineText: string | null;
  /** chapter=按章细纲文件；volume=从卷纲里抠出的本章段或卷级背景 */
  outlineScope: OutlineScope;
  /** volume 且抠不到本章段时为 true（此时 outlineText 是卷级背景，不是本章细纲） */
  outlineChapterSectionMissing: boolean;
  /** 尚可用作起稿依据的软提醒 */
  warnings: string[];
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/**
 * 从卷纲里抠出「本章那一段」：从行首为本章号的行起，到下一个行首为别的章号或下一个标题为止。
 *
 * 为什么必须抠而不能整卷注入：真书《高武》第一卷细纲 16KB、覆盖第 1–60 章。
 * 整段注入等于把第 1–20 章的内容当成第 35 章的细纲喂给模型——**比不注入更坏**，
 * 因为模型会照着错的章去写，而且看不出错。
 *
 * 抓不到就返回空串，由调用方退回「卷级背景」并显式说明（不假装有本章细纲）。
 */
export function extractChapterSection(text: string, chapterNo: number): string {
  const lines = text.split(/\r?\n/);
  const numStart = new RegExp(`^\\s*${chapterNo}\\s*[、.．:：\\s]`);
  const anyChapterLine = /^\s*\d+\s*[、.．:：\s]/;
  const anyHeading = /^#{1,4}\s/;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (numStart.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';

  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i > start && (anyChapterLine.test(line) || anyHeading.test(line))) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * 卷纲头部：取「标题块」——第一个二级及以下标题、或第一个章号行之前的内容
 * （卷主题/卷任务/矛盾网/钩子约定等全局约束）。
 *
 * 为什么必须在二级标题处截断：真书卷纲里 `## 第一幕（1–10 章）` 就排在第一个章号行之前，
 * 只按「章号行」截断会把它一起带出来，于是第 35 章会看到「## 第一幕（1–10 章）」紧贴自己——
 * 模型据此判断自己在第一幕，比不给背景更坏。
 */
function volumeHead(text: string, cap: number): string {
  const lines = text.split(/\r?\n/);
  const anyChapterLine = /^\s*\d+\s*[、.．:：\s]/;
  const anySubHeading = /^#{2,}\s/;
  const head: string[] = [];
  for (const line of lines) {
    if (anyChapterLine.test(line) || anySubHeading.test(line)) break;
    head.push(line);
  }
  return head.join('\n').trim().slice(0, cap);
}

/**
 * 本章所属「幕/阶段」的标题：扫所有二级及以下标题，取**声明的章号范围确实覆盖本章**的最后一个。
 * 范围读不出来、或没有标题覆盖本章，一律返回空串——给错幕比不给幕更坏。
 */
export function enclosingStageHeading(text: string, chapterNo: number): string {
  const range = /（\s*(\d+)\s*[–—\-~至]\s*(\d+)\s*章\s*）|\(\s*(\d+)\s*[–—\-~至]\s*(\d+)\s*章\s*\)/;
  let found = '';
  for (const line of text.split(/\r?\n/)) {
    if (!/^#{2,}\s/.test(line)) continue;
    const m = range.exec(line);
    if (m === null) continue;
    const lo = Number(m[1] ?? m[3]);
    const hi = Number(m[2] ?? m[4]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && chapterNo >= lo && chapterNo <= hi) found = line.trim();
  }
  return found;
}

/**
 * 读 book.json 的 paths.outline —— 书自己声明的「本阶段/本卷细纲」文件。
 *
 * 导出给 `novel hooks` 用：钩子锚词也要从同一份细纲里解析。**不要另写一份读取器**——
 * 「同一份配置两处读、两处解释」正是本仓反复在治的漂移源。
 */
export async function declaredOutlinePath(root: string): Promise<string> {
  const c = await readBookConfig(root);
  return c === null ? '' : cfgString(c.cfg, 'paths', 'outline');
}

/**
 * 写前预检。
 *
 * 细纲来源按「从具体到笼统」三级回落：
 *   ① 按章文件 outline/ch-NN.md（最具体，优先）
 *   ② book.json 的 paths.outline（书自己声明的卷纲）→ 抠出本章段
 *   ③ 同一文件的卷级头部（卷主题/任务/钩子约定），并显式标注「本章段未定位到」
 * 三级都没有才算缺细纲。
 *
 * ★为什么要读 paths.outline：该键在真书 book.json 里**早就写着**
 * （"outline/第一卷-垫底-细纲.md"），而旧实现只找 outline/ch-NN.md，
 * 于是 34 章全书没有一章有按章文件 → 每章都报「缺少本章细纲」。
 * 一个永远无法消除的告警，与「配置写了没人读」是同一类病：信噪比被永久拉低。
 */
export async function checkChapterReadiness(bookRoot: string, chapterNo: number): Promise<ChapterReadiness> {
  if (!Number.isInteger(chapterNo) || chapterNo <= 0) {
    throw new Error('checkChapterReadiness：chapterNo 必须是正整数');
  }

  const root = path.resolve(bookRoot);
  // 按章细纲：兼容四位（新命名）与两位（存量书）——B-52。
  // 只认一种宽度的话，存量书会以「未找到细纲」的形式暴露，离真正的原因（宽度不匹配）很远。
  const outlineDir = path.join(root, 'outline');
  const perChapterFile = await resolveExistingFile(outlineDir, chapterFileCandidates(chapterNo))
    .then((name) => (name === null ? `outline/${chapterFileCandidates(chapterNo)[0]}` : `outline/${name}`));
  const declared = await declaredOutlinePath(root);
  const [canonRaw, perChapterRaw, volumeRaw] = await Promise.all([
    readFile(path.join(root, '.soloent', 'canon.md'), 'utf-8').catch(() => ''),
    readFile(path.join(root, perChapterFile), 'utf-8').catch(() => ''),
    declared === '' ? Promise.resolve('') : readFile(path.join(root, declared), 'utf-8').catch(() => ''),
  ]);
  const canon = stripBom(canonRaw).trim();
  const perChapter = stripBom(perChapterRaw).trim();
  const volume = stripBom(volumeRaw).trim();
  const warnings: string[] = [];

  if (canon === '' || /(?:^|\n)\s*[（(]待填[）)]\s*(?:\n|$)/.test(canon)) {
    warnings.push('正典速查表为空或仍有待填项；请核对本章涉及的人物、设定与关键事实。');
  }

  // ① 按章文件优先
  if (perChapter !== '') {
    return {
      chapterNo,
      outlineFile: perChapterFile,
      outlineText: perChapter.slice(0, OUTLINE_CHAR_CAP),
      outlineScope: 'chapter',
      outlineChapterSectionMissing: false,
      warnings,
    };
  }

  // ② 卷纲里抠本章段
  if (volume !== '') {
    const section = extractChapterSection(volume, chapterNo);
    if (section !== '') {
      // 卷头（全局约束）→ 本章所属幕标题（只在范围确实覆盖本章时才给）→ 本章段
      const stage = enclosingStageHeading(volume, chapterNo);
      const head = volumeHead(volume, Math.max(0, OUTLINE_CHAR_CAP - section.length));
      const text = [head, stage, section].filter((s) => s !== '').join('\n\n').slice(0, OUTLINE_CHAR_CAP);
      return {
        chapterNo,
        outlineFile: declared,
        outlineText: text,
        outlineScope: 'volume',
        outlineChapterSectionMissing: false,
        warnings,
      };
    }
    // ③ 抠不到本章段 → 退化到卷级背景，并说清楚这不是本章细纲
    const head = volumeHead(volume, OUTLINE_CHAR_CAP);
    if (head !== '') {
      warnings.push(
        `卷纲 ${declared} 里没能定位到第 ${chapterNo} 章的段落；本次按卷级背景起稿，`
          + '请人工核对本章要写什么。',
      );
      return {
        chapterNo,
        outlineFile: declared,
        outlineText: head,
        outlineScope: 'volume',
        outlineChapterSectionMissing: true,
        warnings,
      };
    }
  }

  const hint = declared === ''
    ? '（book.json 的 paths.outline 也未声明，无法回落到卷纲）'
    : `（已尝试 ${perChapterFile} 与 paths.outline=${declared}）`;
  warnings.push(`缺少本章细纲；本次仍可起稿，但模型将主要依据正典与上下文续写。${hint}`);
  return {
    chapterNo,
    outlineFile: '',
    outlineText: null,
    outlineScope: 'chapter',
    outlineChapterSectionMissing: false,
    warnings,
  };
}
