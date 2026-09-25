import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appendFile } from 'node:fs/promises';
import { cfgStringArray, readBookConfig, writeBookConfig } from './bookcfg.js';

/**
 * 规则候选的采纳（B-28 / docs/24 P3-1）。
 *
 * 治的是什么：`recordFeedback` 一直在产出 `.soloent/rules/_candidates/<日期>-ch-NN.md`，
 * 但**没有任何「采纳进生效规则」的命令**——于是那条链路是断的：
 * 候选越积越多，作者要手工复制文件、手工改 book.json 的 `rules.author`、
 * 手工记账「这条规则从哪来」。三步手工，必然只做前两步。
 *
 * ★采纳**不是**把候选文件原样搬进 `rules/`：
 * 候选是**行级 diff 报告**（「原文 / 改后」），不是规则条文。
 * 把它当规则声明进去，等于每章都往 prompt 里塞一份 diff 报告——
 * 那是**静默的质量退化**：prompt 变长、内容却不是规则，而且没有任何红灯。
 * 所以本模块的第一条守卫就是：**检测到仍是未改写的机械 diff 就拒绝采纳**，
 * 并明确告诉你该做什么。`--force` 留给「我确实要这样」的罕见情况。
 */

/** 候选文件里由 recordFeedback 写下的固定标记。作者改写后这些标记应消失。 */
const RAW_DIFF_MARKERS = ['由 recordFeedback 机械生成', '**原文**', '**改后**'];

export interface RuleCandidate {
  /** 采纳时用的 id（文件名去扩展名） */
  id: string;
  /** 相对书根的路径 */
  relPath: string;
  date: string;
  chapterNo: number;
  /** 文件里 `## 候选 N` 的条数 */
  count: number;
  /** true = 仍是未改写的机械 diff 报告；直接采纳会把 diff 喂进 prompt */
  rawDiff: boolean;
}

export const CANDIDATE_DIR_REL = '.soloent/rules/_candidates';

function candidatesDir(root: string): string {
  return path.join(root, CANDIDATE_DIR_REL);
}

/** 列出候选。按文件名排序（日期前缀 → 天然按时间） */
export async function listRuleCandidates(bookRoot: string): Promise<RuleCandidate[]> {
  const root = path.resolve(bookRoot);
  const dir = candidatesDir(root);
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: RuleCandidate[] = [];
  for (const fn of files.filter((f) => f.toLowerCase().endsWith('.md')).sort()) {
    const raw = await readFile(path.join(dir, fn), 'utf-8').catch(() => null);
    if (raw === null) continue;
    const id = fn.replace(/\.md$/i, '');
    const m = /^(\d{4}-\d{2}-\d{2})-ch-(\d+)$/.exec(id);
    out.push({
      id,
      relPath: `${CANDIDATE_DIR_REL}/${fn}`,
      date: m?.[1] ?? '',
      chapterNo: m?.[2] !== undefined ? Number(m[2]) : 0,
      count: (raw.match(/^## 候选 /gm) ?? []).length,
      rawDiff: RAW_DIFF_MARKERS.some((k) => raw.includes(k)),
    });
  }
  return out;
}

/** 候选不存在 / 目标已存在 / 未改写——三类失败各自给可执行的下一步 */
export class RuleAdoptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleAdoptError';
  }
}

export interface AdoptOptions {
  bookRoot: string;
  id: string;
  /** 声明进哪一组，默认 author（手写规则优先于 plugin） */
  group?: 'author' | 'plugin';
  /** 目标文件名（相对 `.soloent/rules/`），默认 `<id>.md` */
  name?: string;
  /** 明知仍是机械 diff 也要采纳（罕见；默认拒绝） */
  force?: boolean;
}

export interface AdoptResult {
  from: string;
  to: string;
  /** 写进 book.json 的那条声明（相对 .soloent/） */
  declared: string;
  group: 'author' | 'plugin';
  /** 采纳时该候选是否仍是未改写的机械 diff */
  forced: boolean;
}

/**
 * 采纳一个候选：移到 `rules/` → 声明进 book.json → 在 feedback.jsonl 追加采纳记录。
 *
 * 三步的顺序：**先移文件、再声明、最后记账**。
 * 声明必须在文件就位之后——反过来会出现「声明了但文件不在」的中间态，
 * 那个状态下 `loadRules` 会抛 `RuleFileMissing`，整本书写不了。
 */
export async function adoptRuleCandidate(o: AdoptOptions): Promise<AdoptResult> {
  const root = path.resolve(o.bookRoot);
  const group = o.group ?? 'author';
  const srcRel = `${CANDIDATE_DIR_REL}/${o.id}.md`;
  const srcAbs = path.join(root, srcRel);
  const src = await stat(srcAbs).catch(() => null);
  if (src === null) {
    const all = await listRuleCandidates(root);
    throw new RuleAdoptError(
      `候选不存在：${srcRel}\n`
        + (all.length === 0
          ? '  当前没有任何候选。候选由 novel feedback add 产出。'
          : '  现有候选：\n' + all.map((c) => `    ${c.id}（${c.count} 条${c.rawDiff ? '，未改写' : ''}）`).join('\n')),
    );
  }

  const fileName = o.name ?? `${o.id}.md`;
  const destRel = `rules/${fileName}`;
  const destAbs = path.join(root, '.soloent', destRel);
  if ((await stat(destAbs).catch(() => null)) !== null) {
    throw new RuleAdoptError(
      `目标已存在，拒绝覆盖：.soloent/${destRel}\n`
        + '  换一个 --name，或先把现有文件处理掉。**不静默覆盖**是刻意的：\n'
        + '  规则文件是 prompt 的一部分，覆盖掉就再也找不回来了（rules/ 没有版本控制）。',
    );
  }

  const text = await readFile(srcAbs, 'utf-8');
  const rawDiff = RAW_DIFF_MARKERS.some((k) => text.includes(k));
  if (rawDiff && o.force !== true) {
    throw new RuleAdoptError(
      `拒绝采纳：${srcRel} 仍是 recordFeedback 机械生成的行级 diff（「原文 / 改后」），不是规则条文。\n`
        + '  直接采纳 = 每章往 prompt 里塞一份 diff 报告：prompt 变长、内容却不是规则，且没有任何红灯。\n'
        + '  正确的做法：\n'
        + `    1. 打开 .soloent/${srcRel}\n`
        + '    2. 把每条候选**提炼成一句规则**（如「不用『他知道』这类裁判腔，改用行为暴露想法」）\n'
        + '    3. 删掉机械生成的那几行标记与「原文/改后」引用块，只留规则条文\n'
        + `    4. 重跑本命令\n`
        + '  确实要原样采纳（罕见）：加 --force。',
    );
  }

  // ① 移文件（同盘 rename；跨盘会 EXDEV，这里始终同盘）
  await mkdir(path.dirname(destAbs), { recursive: true });
  await rename(srcAbs, destAbs);

  // ② 声明进 book.json（先移后声明，避免「声明了但文件不在」的中间态）
  const loaded = await readBookConfig(root);
  if (loaded === null) {
    throw new RuleAdoptError(
      `book.json 读不了或不存在，无法声明规则：${path.join(root, '.soloent', 'book.json')}\n`
        + `  文件已移到 .soloent/${destRel}，但**没有声明**——不声明等于没生效（rules 不扫目录）。\n`
        + `  修好 book.json 后在 rules.${group} 里加上 "${destRel}"。`,
    );
  }
  const declared = cfgStringArray(loaded.cfg, 'rules', group);
  if (!declared.includes(destRel)) {
    await writeBookConfig(root, {
      ...loaded.cfg,
      rules: { ...(loaded.cfg['rules'] as Record<string, unknown> ?? {}), [group]: [...declared, destRel] },
    }, loaded.hadBom);
  }

  // ③ 记账（feedback.jsonl 追加，不整份替换）
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await appendFile(
    path.join(root, '.soloent', 'feedback.jsonl'),
    JSON.stringify({
      kind: 'adopt',
      at: new Date().toISOString(),
      candidate: o.id,
      from: srcRel,
      to: destRel,
      group,
      forced: rawDiff,
    }) + '\n',
    'utf-8',
  );

  return { from: srcRel, to: destRel, declared: destRel, group, forced: rawDiff };
}
