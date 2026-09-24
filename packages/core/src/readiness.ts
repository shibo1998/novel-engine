import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ChapterReadiness {
  chapterNo: number;
  outlineFile: string;
  outlineText: string | null;
  warnings: string[];
}

export async function checkChapterReadiness(bookRoot: string, chapterNo: number): Promise<ChapterReadiness> {
  if (!Number.isInteger(chapterNo) || chapterNo <= 0) {
    throw new Error('checkChapterReadiness：chapterNo 必须是正整数');
  }

  const root = path.resolve(bookRoot);
  const outlineFile = `outline/ch-${String(chapterNo).padStart(2, '0')}.md`;
  const [canonRaw, outlineRaw] = await Promise.all([
    readFile(path.join(root, '.soloent', 'canon.md'), 'utf-8').catch(() => ''),
    readFile(path.join(root, outlineFile), 'utf-8').catch(() => ''),
  ]);
  const canon = canonRaw.replace(/^\uFEFF/, '').trim();
  const outlineText = outlineRaw.replace(/^\uFEFF/, '').trim();
  const warnings: string[] = [];

  if (canon === '' || /(?:^|\n)\s*[（(]待填[）)]\s*(?:\n|$)/.test(canon)) {
    warnings.push('正典速查表为空或仍有待填项；请核对本章涉及的人物、设定与关键事实。');
  }
  if (outlineText === '') {
    warnings.push(`缺少本章细纲 ${outlineFile}；本次仍可起稿，但模型将主要依据正典与上下文续写。`);
  }

  return {
    chapterNo,
    outlineFile,
    outlineText: outlineText === '' ? null : outlineText,
    warnings,
  };
}
