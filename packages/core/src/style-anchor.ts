import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runGateCli } from './gates.js';

/**
 * 文风样稿提炼 → `anchors/style.md`（B-48 / v0.2 附 A）。
 *
 * 治的是什么：`checks.rhythm` 的阈值按规矩**必须来自实测**（story-style.md §3.1），
 * 而「等拆完样板书再校准」常常永远等不到——于是新书一直带着
 * `_tier: 'uncalibrated'`（`enabled: false`）跑，节拍这一项**从未生效**。
 *
 * ★**判据不在这里重写**：节拍口径（叙述句均长、长句占比、短句占比、对话占比、
 * 转折词密度）在 Python 侧已实现，且与机检**共用同一份 `rhythm_stats`**。
 * TS 侧只做「调用 + 解析 + 落一份人可读的锚点文件」。
 * 在 TS 再写一份 = 同一判据两个副本，必然漂移——项目 MEMORY 里的既有裁决。
 *
 * ★产物是**锚点**不是闸门：`anchors/style.md` 给人看（「我的文风长这样」），
 * 建议阈值给人**粘贴**（不自动写进 book.json）——
 * 自动改配置会让「谁把阈值调成这个数」变得无从追问。
 */

export interface StyleMetric {
  name: string;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

export interface StyleAnchorReport {
  /** 样本来源 */
  source: string;
  /** 指标表（原样解析自检查器输出） */
  metrics: StyleMetric[];
  /** 建议阈值（可粘贴进 book.json 的 checks.rhythm） */
  suggested: Record<string, unknown> | null;
  /** 「按此值，本样本中 N/M 篇会被拦」——原样带出来，别让人误以为只拦 25% */
  blocked: { hit: number; total: number } | null;
  /** 写出的文件（`--write` 时才有） */
  file: string | null;
  /** 检查器的原始输出，供人工核对（解析失败时尤其重要） */
  raw: string;
}

const METRIC_ROW = /^\s*(\S.*?)\s{2,}([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/;

/** 从检查器输出里抠出最后一段可解析的 JSON（就是那段「可粘贴的阈值」） */
function extractSuggested(text: string): Record<string, unknown> | null {
  const start = text.lastIndexOf('{\n  "enabled"');
  const at = start === -1 ? text.lastIndexOf('{') : start;
  if (at === -1) return null;
  const end = text.indexOf('}', at);
  if (end === -1) return null;
  try {
    return JSON.parse(text.slice(at, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface BuildStyleAnchorOptions {
  /** 样板书目录（相对书根或绝对）。给了就按**样板书**校准——这才是「提标准」 */
  from?: string;
  /** 是否写 `anchors/style.md`。默认 false（只报告） */
  write?: boolean;
  python?: string;
}

export async function buildStyleAnchor(
  bookRoot: string,
  opts: BuildStyleAnchorOptions = {},
): Promise<StyleAnchorReport> {
  const root = path.resolve(bookRoot);
  const args = ['--suggest-rhythm', ...(opts.from !== undefined ? ['--from', opts.from] : [])];
  const r = await runGateCli({
    bookRoot: root,
    args,
    ...(opts.python !== undefined ? { python: opts.python } : {}),
  });

  const raw = r.stderr + r.stdout;
  const source = opts.from !== undefined ? `样板书目录 ${opts.from}` : '本书现状（chapters/）';

  // ★没有样本时检查器 exit 1 并给出原因——**照实转述，不当成「指标全 0」**
  if (r.code !== 0) {
    const reason = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '').slice(0, 3).join('\n  ');
    throw new Error(
      `提炼失败：没有可用的样本。\n  ${reason}\n`
        + (opts.from === undefined
          ? '  本书正文章节还不够（或还没写）。要按对标校准，给 --from <样板书目录>（目录里放 .txt 原文）。\n'
          : `  样板书目录里没有可统计的 .txt：${opts.from}\n`),
    );
  }

  const metrics: StyleMetric[] = [];
  for (const line of raw.split('\n')) {
    const m = METRIC_ROW.exec(line);
    if (m !== null) {
      metrics.push({
        name: (m[1] as string).trim(),
        min: Number(m[2]), p25: Number(m[3]), median: Number(m[4]), p75: Number(m[5]), max: Number(m[6]),
      });
    }
  }
  const suggested = extractSuggested(raw);
  const bm = /本样本中\s*\*\*(\d+)\/(\d+)\*\*\s*篇会被拦/.exec(raw);
  const blocked = bm === null ? null : { hit: Number(bm[1]), total: Number(bm[2]) };

  let file: string | null = null;
  if (opts.write === true) {
    file = 'anchors/style.md';
    await mkdir(path.join(root, 'anchors'), { recursive: true });
    await writeFile(path.join(root, file), renderAnchor({ source, metrics, suggested, blocked, raw }), 'utf-8');
  }

  return { source, metrics, suggested, blocked, file, raw };
}

function renderAnchor(a: {
  source: string;
  metrics: StyleMetric[];
  suggested: Record<string, unknown> | null;
  blocked: { hit: number; total: number } | null;
  raw: string;
}): string {
  const lines = [
    '# 文风锚点',
    '',
    '> 由 `novel style-anchor` 从实测样本生成（B-48）。**改它不生效**——',
    '> 要改节拍标准，请改 `book.json` 的 `checks.rhythm`，或重跑本命令。',
    '',
    `样本来源：${a.source}`,
    '',
    '## 实测指标（分位）',
    '',
    '| 指标 | min | P25 | 中位 | P75 | max |',
    '|---|---|---|---|---|---|',
    ...a.metrics.map((m) => `| ${m.name} | ${m.min} | ${m.p25} | ${m.median} | ${m.p75} | ${m.max} |`),
    '',
  ];
  if (a.suggested !== null) {
    lines.push(
      '## 建议阈值（粘进 `book.json` 的 `checks.rhythm`）',
      '',
      '```json',
      JSON.stringify(a.suggested, null, 2),
      '```',
      '',
    );
    if (a.blocked !== null) {
      lines.push(
        `⚠️ 按此值，本样本中 **${a.blocked.hit}/${a.blocked.total}** 篇会被拦。`,
        '注意这不是「四分之一」：四个指标各自罚最差四分位，而只要有任何一项越线就算被拦，',
        '并集自然大得多。想让总体只拦约 25%，把下限调到 P10 附近、上限调到 P90 附近。',
        '',
      );
    }
    lines.push(
      '★**按现状取分位只会固化现状**。想让文风真的变，请按**样板书**校准：',
      '`novel style-anchor --book <书根> --from <样板书目录> --write`',
      '（样板书目录里放 .txt 原文；同时有 .md 时只用 .txt——.md 是拆解报告，混进来会带偏统计。）',
      '',
    );
  } else {
    lines.push('## 建议阈值', '', '（未能从检查器输出里解析出阈值块——见下方原始输出）', '');
  }
  lines.push('## 检查器原始输出', '', '```', a.raw.trim(), '```', '');
  return lines.join('\n');
}
