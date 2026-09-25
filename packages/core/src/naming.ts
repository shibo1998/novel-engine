import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * 章号命名（B-52 / v0.2 §3.1）：新书用**四位**编号，**读取时兼容旧名**。
 *
 * 为什么要有这个模块：章号宽度散在 5 处各写一遍（readiness 的按章细纲、
 * generate 的章文件名与交接清单、feedback 的候选名、plan 的卷号），
 * 每处都是 `padStart(2,'0')`。要把「两位 → 四位」这件事做对，
 * 必须**只有一个地方知道宽度怎么算**，否则改一处漏四处，
 * 而漏掉的那处表现为「某个文件找不到了」——最不好查的一类故障。
 *
 * ★「兼容旧名」是硬要求，不是顺手做的：存量书（高武 31 章、仙侠 2 章）
 * 的章文件就是两位的。只认四位会让它们**一个文件都读不到**，
 * 而那会以「未找到任何章节」的形式暴露——离真正的原因（宽度不匹配）很远。
 */

/** 四位（新书默认） */
export const WIDTH_4 = 4;
/** 两位（存量书） */
export const WIDTH_2 = 2;

/** 按宽度算文件名。`ch-0001.md` / `ch-01.md` / `ch-1.md` */
export function chapterFileName(chapterNo: number, width: number = WIDTH_4): string {
  return `ch-${String(chapterNo).padStart(width, '0')}.md`;
}

/**
 * 同一章号的所有可接受文件名，**四位在前**（新命名优先）。
 * 读取时按序尝试——这就是「兼容旧名」的全部实现。
 */
export function chapterFileCandidates(chapterNo: number): string[] {
  return [
    chapterFileName(chapterNo, WIDTH_4),
    chapterFileName(chapterNo, WIDTH_2),
    `ch-${chapterNo}.md`,
  ];
}

/**
 * 在给定目录里找第一个真实存在的候选，返回**文件名**；都不在 → null。
 *
 * ★不猜、不静默兜底：找不到就是找不到，由调用方决定「缺」意味着什么。
 * 按章细纲与章文件用的是同一套文件名（`ch-0001.md`），所以候选可以共用。
 */
export async function resolveExistingFile(dir: string, candidates: string[]): Promise<string | null> {
  const files = new Set(await readdir(dir).catch(() => [] as string[]));
  for (const name of candidates) {
    if (files.has(name)) return name;
  }
  return null;
}

export interface NumberingPlanEntry {
  from: string;
  to: string;
  kind: 'chapter' | 'outline';
}

export interface NumberingPlan {
  entries: NumberingPlanEntry[];
  /** 已是四位的文件数（不需要动） */
  alreadyFour: number;
}

/**
 * 扫描需要重命名的文件（`ch-01.md` → `ch-0001.md`）。
 *
 * **只生成计划，不动文件**——重命名章文件会影响 git 历史与作者的习惯，
 * 是作者的决定，不是工具自作主张的事。
 */
export async function planNumberingMigration(bookRoot: string): Promise<NumberingPlan> {
  const root = path.resolve(bookRoot);
  const entries: NumberingPlanEntry[] = [];
  let alreadyFour = 0;

  const scan = async (dir: string, kind: NumberingPlanEntry['kind']): Promise<void> => {
    const files = await readdir(path.join(root, dir)).catch(() => [] as string[]);
    for (const fn of files) {
      const m = /^ch-(\d+)\.md$/.exec(fn);
      if (m === null) continue;
      const no = Number(m[1]);
      const target = chapterFileName(no, WIDTH_4);
      if (fn === target) {
        alreadyFour += 1;
        continue;
      }
      entries.push({ from: `${dir}/${fn}`, to: `${dir}/${target}`, kind });
    }
  };

  await scan('chapters', 'chapter');
  await scan('outline', 'outline');
  entries.sort((a, b) => a.from.localeCompare(b.from));
  return { entries, alreadyFour };
}
