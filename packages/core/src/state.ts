import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GateFailureError } from './gates.js';
import { contentHash } from './hash.js';
import type { ChapterIndexEntry, GateResult, GateSeverity, GateStatus, StoryState } from './types.js';

/**
 * 落盘格式版本。
 *
 * v1 → v2（B-13）改了什么：`gateStatus` 的指纹从**文件 mtime** 换成**内容指纹**，
 * 并给章加 `needsReview` / `reviseCount` / `rewriteCount` / `generatedBy`。
 *
 * 为什么要换指纹：mtime 两个方向都会骗人。
 *   · **假过期**：git checkout、复制文件都会刷新 mtime，内容明明没变却让结论作废
 *     （v1 的注释自己把这条记为「已知弱点」）。
 *   · **假绿**（更危险）：同一时间粒度内的改动可能让 mtime 不变，
 *     于是「内容变了但结论还挂着」——那正是过期清扫要防的东西。
 */
export const SCHEMA_VERSION = 2;

/**
 * 默认章节命名正则——与 Python 侧 kit.py:298 的默认值逐字一致。
 * 两边默认值一旦漂移，readState 建出的索引和 gate 报的 chapter 就对不上键，
 * 且只在配置缺失的书上暴露，最难查。改它必须两边同步。
 */
const DEFAULT_FILE_REGEX = '^ch-(\\d+)\\.md$';

/** 严重度权重：取该章最大值当 worst */
const SEVERITY_WEIGHT: Record<GateSeverity, number> = { 严重: 4, 中等: 3, 轻微: 2, 提示: 1 };

/**
 * 哪些严重度算「拦截」。**提示不算**——它与 gates/consistency_check.py 的 draft_free 声明
 * 必须一致：那里把风格类发现降为「提示」，理由写得很清楚「只报告，不计入拦截」。
 *
 * ★这条判据只允许一个来源。三处消费它：检查器按它降级、收敛循环按它决定是否继续改写、
 *   批量跑按它决定是否停下写下一章。各写各的就会出现自相矛盾——
 *   实测踩到过：检查器说「只是提示」，收敛循环却为它烧满三轮改写仍拿不到 clean，
 *   于是每一章都停在 max-rounds，「跑完一本」根本走不完。
 */
export const BLOCKING_SEVERITIES: ReadonlySet<GateSeverity> = new Set<GateSeverity>(['严重', '中等', '轻微']);

/**
 * 该章是否算「过闸」。**失败关闭**：只有明确是 clean、或明确只剩提示级，才算过；
 * 不认识的取值（拼错的严重度、上游新加的等级、undefined 变成的字符串）一律算**没过**。
 * 写成白名单而不是「不在拦截集合里就算过」，就是为了避免「没见过的值默认放行」——
 * 那是「查不到 = 没问题」的又一种变体。
 */
export function isPassingWorst(worst: string): boolean {
  return worst === 'clean' || worst === '提示';
}

export interface ReadStateOptions {
  bookRoot: string;
  /** 强制走重建分支（CLI --rebuild 的入口）；契约两条分支不变，此开关只是绕过缓存 */
  force?: boolean;
  /**
   * 跳过「过期清扫」这一步（F16）。**只给「马上要把每一章的 gateStatus 整体覆写」
   * 的调用方用**——那种场景下清扫结果必然被丢弃，纯属白跑一轮全量 stat。
   * 默认必须为 false：清扫是「假绿」防线的一环，
   * 任何「只是想读一下 state」的调用方都不该关掉它。
   */
  skipStaleSweep?: boolean;
}

/** 读章节正文/状态文件前的统一预处理：strip 首行 BOM */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}

/** 标题提取：取首个非空行，须为 H1；剥「第NNN章」前缀（兼容阿拉伯/汉字数字、零填充）。无 H1 → 空串，不抛错 */
function extractTitle(text: string): string {
  const firstNonEmpty = text.split(/\r?\n/).find((l) => l.trim() !== '');
  if (firstNonEmpty === undefined) return '';
  const line = firstNonEmpty.trimStart();
  if (!/^#\s/.test(line)) return '';
  return line.replace(/^#+\s*/, '').replace(/^第[0-9零一二三四五六七八九十百千两]+章\s*/, '').trim();
}

/**
 * 字数口径（全项目唯一口径，Python 工具与 Web 端照抄，不得再发明第二个）：
 * 整个文件去掉全部空白字符后的码点数。
 * 跨语言一致性已核实：JS 的 \s 与 Python re 的 \s 在 Unicode 模式下都吃全角空格 \u3000；
 * [...s].length 与 len(s) 同为码点计数（不用 str.length，避免 emoji 按 UTF-16 码元算成两个）。
 */
function countWords(text: string): number {
  return [...text.replace(/\s/g, '')].length;
}

/** 章节命名正则：优先每书配置 .soloent/book.json 的 chapter.file_regex，缺失/不可读回退默认字面量 */
async function loadFileRegex(bookRoot: string): Promise<RegExp> {
  try {
    const raw = await readFile(path.join(bookRoot, '.soloent', 'book.json'), 'utf-8');
    const cfg = JSON.parse(stripBom(raw)) as { chapter?: { file_regex?: string } };
    return new RegExp(cfg.chapter?.file_regex ?? DEFAULT_FILE_REGEX);
  } catch {
    return new RegExp(DEFAULT_FILE_REGEX);
  }
}

/** 扫 chapters/ 重建索引（纯内存操作，不写盘） */
async function rebuildState(bookRoot: string): Promise<StoryState> {
  const fileRegex = await loadFileRegex(bookRoot);
  const chaptersDir = path.join(bookRoot, 'chapters');
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  const chapters: ChapterIndexEntry[] = [];
  for (const fn of files) {
    const m = fileRegex.exec(fn);
    const group = m?.[1];
    if (group === undefined) continue;
    const raw = await readFile(path.join(chaptersDir, fn), 'utf-8');
    const text = stripBom(raw);
    chapters.push({
      chapterNo: Number.parseInt(group, 10),
      file: fn,
      title: extractTitle(text),
      wordCount: countWords(text),
      contentHash: contentHash(text),
      gateStatus: null,
      needsReview: false,
      reviseCount: 0,
      rewriteCount: 0,
    });
  }
  chapters.sort((a, b) => a.chapterNo - b.chapterNo);
  return { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), bookRoot, chapters };
}

/**
 * 刷新指纹并清扫过期结论（v2）。
 *
 * 为什么把「刷新指纹」和「清扫」合成一步：`contentHash` 是索引里唯一的「内容是什么」，
 * 它一旦陈旧，索引就在说谎。分两步做（只对带 gateStatus 的章刷新）会留下
 * 「gateStatus 是对的，但 contentHash 是旧的」这种半真状态——比全错更难查。
 * 所以一次读盘，两件事一起办：先更新指纹，再拿新指纹判 gateStatus 该不该留。
 *
 * 文件消失：指纹置空串（与任何 checkedHash 都不等，必然判过期），gateStatus 置 null。
 */
async function refreshHashesAndSweep(root: string, chapters: ChapterIndexEntry[]): Promise<void> {
  await Promise.all(
    chapters.map(async (ch) => {
      const raw = await readFile(path.join(root, 'chapters', ch.file), 'utf-8').catch(() => null);
      if (raw === null) {
        ch.contentHash = '';
        ch.gateStatus = null;
        return;
      }
      const h = contentHash(stripBom(raw));
      ch.contentHash = h;
      if (ch.gateStatus !== null && ch.gateStatus.checkedHash !== h) ch.gateStatus = null;
    }),
  );
}

/**
 * v1 → v2 迁移（B-13）。
 *
 * ★**一律丢弃 gateStatus**，不做「mtime 还对得上就保留」的聪明事。
 * 理由：v1 的绿是用 mtime 判的，而 mtime 正是我们要废掉的信号——
 * 拿它来给 v2 的绿背书，等于把「不可靠」原样带进新格式，只是换了个字段名。
 * 丢掉的代价是每本书重跑一次 `novel gates --write`；留下的代价是一个可能假的绿。
 * 本项目的取舍一贯是后者不可接受（「过期的摘要不如没有」）。
 *
 * 其它字段照常保留：章节顺序、标题、字数、修订计数都还在。
 * 迁移是**只读**的——真正落盘要等下一次 writeState。
 */
function migrateV1ToV2(raw: Record<string, unknown>, root: string): { state: StoryState; dropped: number } {
  const oldChapters = Array.isArray(raw['chapters']) ? (raw['chapters'] as Record<string, unknown>[]) : [];
  let dropped = 0;
  const chapters: ChapterIndexEntry[] = oldChapters.map((c) => {
    if (c['gateStatus'] !== null && c['gateStatus'] !== undefined) dropped += 1;
    return {
      chapterNo: typeof c['chapterNo'] === 'number' ? c['chapterNo'] : 0,
      file: typeof c['file'] === 'string' ? c['file'] : '',
      title: typeof c['title'] === 'string' ? c['title'] : '',
      wordCount: typeof c['wordCount'] === 'number' ? c['wordCount'] : 0,
      // v1 没存指纹；留空串 → 与任何真实指纹都不等，gateStatus 必然为 null（失败关闭）
      contentHash: '',
      gateStatus: null,
      needsReview: false,
      reviseCount: 0,
      rewriteCount: 0,
    };
  }).filter((c) => c.file !== '');
  chapters.sort((a, b) => a.chapterNo - b.chapterNo);
  return {
    state: { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), bookRoot: root, chapters },
    dropped,
  };
}

/**
 * 读状态。行为：
 *  1. <bookRoot>/state/story.json 存在、schemaVersion 匹配、与书配对 → 解析返回
 *  2. schemaVersion === 1 → 走 `migrateV1ToV2`（**丢弃全部 gateStatus**，见该函数注释）
 *  3. 不存在 / 版本不认识 / 与书不配对 / JSON 损坏 → 扫 chapters/ 重建（内存返回，不写盘）
 *  4. bookRoot 不是目录 → throw
 *  返回前一律刷新指纹并清扫过期结论（重建分支产出全 null，刷新为空操作）；
 *  skipStaleSweep=true 时跳过，仅见 ReadStateOptions 里的使用约束。
 */
export async function readState(opts: ReadStateOptions): Promise<StoryState> {
  // 归一：绝对化 + 分隔符统一为平台形式。所有拼 state 路径、bookRoot 比较、落盘一律用 root。
  // 不归一大小写（d:/ vs D:/ 仍不等，实践中无人混敲）。
  const root = path.resolve(opts.bookRoot);
  const st = await stat(root).catch(() => null);
  if (st === null || !st.isDirectory()) {
    throw new Error(`readState：bookRoot 不是目录：${root}`);
  }
  let state: StoryState | null = null;
  if (opts.force !== true) {
    const raw = await readFile(path.join(root, 'state', 'story.json'), 'utf-8').catch(() => null);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(stripBom(raw)) as Record<string, unknown>;
        if (parsed['bookRoot'] === root) {
          if (parsed['schemaVersion'] === SCHEMA_VERSION) state = parsed as unknown as StoryState;
          else if (parsed['schemaVersion'] === 1) state = migrateV1ToV2(parsed, root).state;
          // 其它版本：不认识 → 落入重建分支（失败关闭，不猜语义）
        }
      } catch {
        // JSON 损坏同样视为过期，重建而非报「文件损坏」
      }
    }
  }
  state ??= await rebuildState(root);
  if (opts.skipStaleSweep !== true) await refreshHashesAndSweep(root, state.chapters);
  return state;
}

/**
 * 写状态。原子写：写 story.json.tmp → rename。
 * 写前归一：chapters 按 chapterNo 升序，generatedAt 刷新。
 */
export async function writeState(state: StoryState): Promise<void> {
  // 入口同样归一（见 readState），且落盘的 bookRoot 用归一后的值，保证跨层字符串相等
  const root = path.resolve(state.bookRoot);
  const dir = path.join(root, 'state');
  await mkdir(dir, { recursive: true });
  const normalized: StoryState = {
    ...state,
    schemaVersion: SCHEMA_VERSION,
    bookRoot: root,
    chapters: [...state.chapters].sort((a, b) => a.chapterNo - b.chapterNo),
    generatedAt: new Date().toISOString(),
  };
  const tmpPath = path.join(dir, 'story.json.tmp');
  await writeFile(tmpPath, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, path.join(dir, 'story.json'));
}

/**
 * 摘掉所有章节的**结论字段**：`gateStatus` 与 `needsReview`。
 *
 * **用途唯一**：给「不经检查就直接写状态」的入口（当前只有 `novel state --set`）
 * 在落盘前做一次净化。为什么必须做：这两个字段是**检查/判据的结论**，不是作者输入；
 * 任何不经过 `runGates` / `judgeChapter` 就能写进它们的路径，都是一条「不经检查写出绿」的路——
 * 喂 `{worst:"clean", checkedHash:<真实内容指纹>}` 就能骗过 readState 的过期清扫
 * 并显示在面板上。这条路在 2026-09-24 被判为「保留入口、剥掉越界部分」：
 * 数据字段（story_time / rank / 账本 …）照常可写，迁移与 fixture 用途不受影响，
 * 但**结论字段一律不得从这条路进来**。
 *
 * v2（B-13）把 `needsReview` 一并纳入：它同样是「有人判定过」的结论，
 * 从 --set 写进来就能伪造「这章已经人看过了」。
 *
 * 摘掉而不是拒绝：拒绝会让「只想改一个数据字段」的正常调用方连坐；
 * 摘掉只损失它本就不该提供的能力，且由调用方把代价如实报给用户。
 */
export function stripConclusions(state: StoryState): {
  state: StoryState;
  removed: { gateStatus: number; needsReview: number };
} {
  const removed = { gateStatus: 0, needsReview: 0 };
  const chapters = state.chapters.map((ch) => {
    if (ch.gateStatus === null && !ch.needsReview) return ch;
    if (ch.gateStatus !== null) removed.gateStatus += 1;
    if (ch.needsReview) removed.needsReview += 1;
    return { ...ch, gateStatus: null, needsReview: false };
  });
  return { state: { ...state, chapters }, removed };
}

/**
 * 跑 gate **之前**对每章取内容指纹快照，key = ChapterIndexEntry.file。
 *
 * 为什么必须在跑之前取：假绿窗口。applyGateResult 若在跑完之后才读盘回填，
 * 跑期间被人改过的章会拿到**新**指纹，于是「跑期间的改动」被算成已检。
 * 先快照、回填时只认快照值，「当前指纹 ≠ checkedHash」会留给下次 readState
 * 的清扫去置 null —— 判据不变，只是把「什么时候读的内容」挪到正确的一侧。
 *
 * 文件在快照时不存在 → 记空串（与 applyGateResult 的兜底同口径：空串必被判过期）。
 */
export async function snapshotChapterHashes(
  bookRoot: string,
  chapters: ChapterIndexEntry[],
): Promise<Map<string, string>> {
  const root = path.resolve(bookRoot);
  const snapshot = new Map<string, string>();
  await Promise.all(
    chapters.map(async (ch) => {
      const raw = await readFile(path.join(root, 'chapters', ch.file), 'utf-8').catch(() => null);
      snapshot.set(ch.file, raw === null ? '' : contentHash(stripBom(raw)));
    }),
  );
  return snapshot;
}

export interface ApplyGateResultOptions {
  /**
   * 跑 gate 之前取的内容指纹快照（见 snapshotChapterHashes）。
   * 给定时一律用快照值回填；不给才退回「用后读盘」——那正是假绿窗口本身，
   * 只应在明确知道没有并发写者的场景（如单测）省略。
   */
  hashSnapshot?: Map<string, string>;
}

/**
 * 把 runGates 结果回填进 state（编排层专用；core 六函数不回写状态）。
 * runGates 是全量扫描：未命中 findings 的章 = 本次检查通过，必须置 clean（防上一轮严重度残留）。
 * 命中章与 clean 章共享同一批 checkedAt；checkedHash 取**跑前快照**里的内容指纹。
 * 返回本批 checkedAt。
 *
 * ★回填前先对账（F12 落点 2）：检查器扫到的章数必须等于 state 的章数，否则**拒绝回填**。
 * 为什么必须挡在这里：检查器协议里「什么都没查到」与「查了没问题」是同一个形状
 * （findings 为空 + exit 0），而下面的循环对「没命中 findings 的章」一律置 clean——
 * 少了这道对账，一次「零章」的检查就会把全书刷成绿色，比不检查更危险。
 */
export async function applyGateResult(
  state: StoryState,
  result: GateResult,
  opts: ApplyGateResultOptions = {},
): Promise<string> {
  const root = path.resolve(state.bookRoot);
  if (result.chapter_count !== state.chapters.length) {
    throw new GateFailureError(
      'count-mismatch',
      `拒绝回填：检查器扫到 ${result.chapter_count} 章，state 记了 ${state.chapters.length} 章。\n` +
        `  两处口径必须相等才敢刷 gateStatus，否则「查不到」会被写成「全绿」。\n` +
        `  排查方向：①书根是否指错（result.book_root=${result.book_root}；state.bookRoot=${state.bookRoot}）；\n` +
        `  ②book.json 的 paths.chapters 是否与 TS 侧硬编码的 'chapters' 不一致。`,
    );
  }
  const summary = summarizeGateResult(result);
  const checkedAt = new Date().toISOString();
  for (const ch of state.chapters) {
    // 优先用跑前快照；没有快照才退回用后读盘（后者会重新引入假绿窗口，见 ApplyGateResultOptions）
    const fromSnapshot = opts.hashSnapshot?.get(ch.file);
    const raw = fromSnapshot !== undefined
      ? null
      : await readFile(path.join(root, 'chapters', ch.file), 'utf-8').catch(() => null);
    const checkedHash = fromSnapshot ?? (raw === null ? '' : contentHash(stripBom(raw)));
    const hit = summary.get(ch.file);
    ch.gateStatus = hit !== undefined
      ? { ...hit, checkedAt, checkedHash }
      : { worst: 'clean', count: 0, checkedAt, checkedHash };
  }
  return checkedAt;
}

/**
 * 把 runGates 结果按文件名聚合成每章摘要。key 即 ChapterIndexEntry.file。
 * 注意：map 只含**有 finding 的章**；无 finding 的章由编排层按需补 { worst: "clean", count: 0 }。
 */
export function summarizeGateResult(result: GateResult): Map<string, GateStatus> {
  const map = new Map<string, GateStatus>();
  const checkedAt = new Date().toISOString();
  for (const f of result.findings) {
    const prev = map.get(f.chapter);
    if (prev === undefined) {
      // checkedHash: '' 是占位——聚合层拿不到内容，由编排层（applyGateResult / CLI --write）回填真实值；
      // 若有人跳过回填直接落盘，readState 清扫遇 '' 必判过期置 null，方向保守、安全。
      map.set(f.chapter, { worst: f.severity, count: 1, checkedAt, checkedHash: '' });
      continue;
    }
    // 累加条数 + 取最大严重度。两处都不能省：
    // count 不累加则恒为 1；worst 不比较则退化成「最后一条 finding 的 severity」。
    prev.count += 1;
    const prevWeight = prev.worst === 'clean' ? 0 : SEVERITY_WEIGHT[prev.worst];
    if (SEVERITY_WEIGHT[f.severity] > prevWeight) prev.worst = f.severity;
  }
  return map;
}
