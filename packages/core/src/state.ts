import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChapterIndexEntry, GateResult, GateSeverity, GateStatus, StoryState } from './types.js';

/**
 * 默认章节命名正则——与 Python 侧 kit.py:298 的默认值逐字一致。
 * 两边默认值一旦漂移，readState 建出的索引和 gate 报的 chapter 就对不上键，
 * 且只在配置缺失的书上暴露，最难查。改它必须两边同步。
 */
const DEFAULT_FILE_REGEX = '^ch-(\\d+)\\.md$';

/** 严重度权重：取该章最大值当 worst */
const SEVERITY_WEIGHT: Record<GateSeverity, number> = { 严重: 4, 中等: 3, 轻微: 2, 提示: 1 };

export interface ReadStateOptions {
  bookRoot: string;
  /** 强制走重建分支（CLI --rebuild 的入口）；契约两条分支不变，此开关只是绕过缓存 */
  force?: boolean;
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
    const text = stripBom(await readFile(path.join(chaptersDir, fn), 'utf-8'));
    chapters.push({
      chapterNo: Number.parseInt(group, 10),
      file: fn,
      title: extractTitle(text),
      wordCount: countWords(text),
      gateStatus: null,
    });
  }
  chapters.sort((a, b) => a.chapterNo - b.chapterNo);
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), bookRoot, chapters };
}

/**
 * 读状态。行为：
 *  1. <bookRoot>/state/story.json 存在且 schemaVersion 匹配且与书配对 → 解析返回
 *  2. 不存在 / 版本不符 / 与书不配对 / JSON 损坏 → 扫 chapters/ 重建（内存返回，不写盘）
 *  3. bookRoot 不是目录 → throw
 */
export async function readState(opts: ReadStateOptions): Promise<StoryState> {
  // 归一：绝对化 + 分隔符统一为平台形式。所有拼 state 路径、bookRoot 比较、落盘一律用 root。
  // 不归一大小写（d:/ vs D:/ 仍不等，实践中无人混敲）。
  const root = path.resolve(opts.bookRoot);
  const st = await stat(root).catch(() => null);
  if (st === null || !st.isDirectory()) {
    throw new Error(`readState：bookRoot 不是目录：${root}`);
  }
  if (opts.force !== true) {
    const raw = await readFile(path.join(root, 'state', 'story.json'), 'utf-8').catch(() => null);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(stripBom(raw)) as StoryState;
        if (parsed.schemaVersion === 1 && parsed.bookRoot === root) return parsed;
        // 版本不符或与书不配对：视为过期，落入重建分支
      } catch {
        // JSON 损坏同样视为过期，重建而非报「文件损坏」
      }
    }
  }
  return rebuildState(root);
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
    bookRoot: root,
    chapters: [...state.chapters].sort((a, b) => a.chapterNo - b.chapterNo),
    generatedAt: new Date().toISOString(),
  };
  const tmpPath = path.join(dir, 'story.json.tmp');
  await writeFile(tmpPath, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, path.join(dir, 'story.json'));
}

/**
 * 把 runGates 结果按文件名聚合成每章摘要。key 即 ChapterIndexEntry.file。
 * 注意：map 只含**有 finding 的章**；无 finding 的章由编排层按需补 { worst: "clean", count: 0 }。
 */
export function summarizeGateResult(result: GateResult): Map<string, GateStatus> {
  const map = new Map<string, GateStatus>();
  const checkedAt = new Date().toISOString();
  for (const f of result.findings) {
    const weight = SEVERITY_WEIGHT[f.severity];
    const prev = map.get(f.chapter);
    if (prev === undefined) {
      map.set(f.chapter, { worst: f.severity, count: 1, checkedAt });
      continue;
    }
    prev.count += 1;
    const prevWeight = prev.worst === 'clean' ? 0 : SEVERITY_WEIGHT[prev.worst];
    if (weight > prevWeight) prev.worst = f.severity;
  }
  return map;
}
