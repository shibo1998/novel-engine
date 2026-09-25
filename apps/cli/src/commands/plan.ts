import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  LAYER_LABEL,
  POSITION_QUESTIONS,
  confirmLayer,
  draftLayer,
  initPlan,
  planStatus,
  writePosition,
} from '@novel/core';
import type { LayerKind } from '@novel/core';

/**
 * novel plan：逐层递进建书（B-10，v0.2 M8.0）。
 *
 * 定位 → 设定 → 总纲 → 卷纲 → 细纲，**每层经作者确认才解锁下一层**。
 * 纪律（与 packages/core/src/plan.ts 一致）：
 *   · LLM 起草只写 `state/drafts/`，绝不覆盖正式文件；
 *   · 「确认」= 对当前文件内容签字（记 contentHash），文件一改即回到「待确认」；
 *   · 上游在本层之后被重新确认 → 本层标「待复核」（stale），不自动重写。
 *
 * ★为什么定位层不做交互问答：本命令面向非交互环境（脚本 / agent 调用）。
 * 问答由上层（agent 或人）发起，答案经 `--answers` / `--answer` 传进来；
 * 题目清单用 `--questions` 取，避免两边各写一份题面而漂移。
 *
 * 输出契约与其余子命令一致：结构化结果走 stdout，人类可读提示走 stderr。
 */

const LAYERS: LayerKind[] = ['position', 'setting', 'outline', 'volume', 'detail'];
/** 定位层由问答直接产生，不经 LLM 起草 */
const DRAFTABLE: LayerKind[] = ['setting', 'outline', 'volume', 'detail'];

function parseLayer(v: string): LayerKind {
  if (!(LAYERS as string[]).includes(v)) {
    throw new Error(`--layer 只能是 ${LAYERS.join(' / ')}，收到「${v}」`);
  }
  return v as LayerKind;
}

function parseDraftableLayer(v: string): LayerKind {
  const kind = parseLayer(v);
  if (!DRAFTABLE.includes(kind)) {
    throw new Error(`--layer ${kind} 没有 LLM 起草（定位由问答产生）：可起草的是 ${DRAFTABLE.join(' / ')}`);
  }
  return kind;
}

/** `--chapters 1-60` → {from:1,to:60} */
function parseChapters(v: string): { from: number; to: number } {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(v.trim());
  if (m === null) throw new Error(`--chapters 形如 1-60，收到「${v}」`);
  return { from: Number(m[1]), to: Number(m[2]) };
}

/** `--answer genre=玄幻-高武` → [genre, 玄幻-高武] */
function parseAnswer(v: string, acc: Record<string, string>): Record<string, string> {
  const i = v.indexOf('=');
  if (i <= 0) throw new Error(`--answer 形如 键=值（如 --answer genre=玄幻-高武），收到「${v}」`);
  acc[v.slice(0, i).trim()] = v.slice(i + 1).trim();
  return acc;
}

/** 读 --answers 指向的 JSON（对象，值取字符串；容忍 BOM） */
async function readAnswersFile(file: string): Promise<Record<string, string>> {
  const raw = await readFile(file, 'utf-8');
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--answers 文件须是一个 JSON 对象（键=题目 id，值=答案），收到：${file}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[k] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

export function registerPlan(program: Command): void {
  const plan = program.command('plan').description('逐层递进建书：定位 → 设定 → 总纲 → 卷纲 → 细纲（每层确认后解锁下一层）');

  plan
    .command('init')
    .description('开启逐层流程：建 .soloent/plan.json（已存在则原样返回，不覆盖确认记录）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const p = await initPlan(opts.book);
      process.stdout.write(JSON.stringify({ bookRoot: opts.book, plan: p }) + '\n');
      process.stderr.write('已开启逐层流程。下一层：novel plan position --book <同一本书> --questions\n');
    });

  plan
    .command('status')
    .description('各层状态与「现在该做哪层」。未开启逐层流程的书 → enabled=false（旧书不受影响）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .action(async (opts: { book: string }) => {
      const s = await planStatus(opts.book);
      process.stdout.write(JSON.stringify(s) + '\n');
      if (!s.enabled) {
        process.stderr.write(
          '本书未开启逐层流程（旧书不受闸门影响）。要开启：novel plan init --book <同一本书>\n',
        );
        return;
      }
      for (const l of s.layers) {
        const extra = l.staleBecause !== undefined ? `（上游 ${l.staleBecause} 已重新确认，待复核）` : '';
        process.stderr.write(`  ${LAYER_LABEL[l.kind]} [${l.key}] ${l.status}  ${l.file}${extra}\n`);
      }
      process.stderr.write(
        s.next === null
          ? '全部层级已确认。\n'
          : `下一层：${s.next}\n`,
      );
    });

  plan
    .command('position')
    .description('定位层：--questions 取题目清单；--answers/--answer 给答案并写成 book/premise.md（正式文件，不经 LLM）')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .option('--questions', '只打印题目清单（JSON）后退出，不写文件', false)
    .option('--answers <file>', '答案 JSON 文件（键=题目 id）')
    .option(
      '--answer <k=v>',
      '单条答案，可重复；与 --answers 合并，--answer 优先',
      (v: string, acc: Record<string, string>) => parseAnswer(v, acc),
      {} as Record<string, string>,
    )
    .action(async (opts: { book: string; questions: boolean; answers?: string; answer: Record<string, string> }) => {
      if (opts.questions) {
        process.stdout.write(JSON.stringify(POSITION_QUESTIONS) + '\n');
        return;
      }
      const merged: Record<string, string> = {
        ...(opts.answers !== undefined ? await readAnswersFile(opts.answers) : {}),
        ...opts.answer,
      };
      if (Object.keys(merged).length === 0) {
        throw new Error('没有答案可写：给 --answers <file.json> 或 --answer 键=值；先看题目用 --questions');
      }
      const rel = await writePosition(opts.book, merged);
      process.stdout.write(JSON.stringify({ bookRoot: opts.book, file: rel, answers: merged }) + '\n');
      process.stderr.write(
        `定位已写入 ${rel}。请过目；改完确认：novel plan confirm --book <同一本书> --layer position\n`,
      );
    });

  plan
    .command('draft')
    .description('LLM 起草某层，只写 state/drafts/<层>.md（派生物，可丢弃）；作者审阅后自行改入正式文件再 confirm')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--layer <kind>', `起草哪层（${DRAFTABLE.join(' / ')}）`, parseDraftableLayer)
    .option('--volume <n>', '卷号（卷纲/细纲用）', (v: string) => Number.parseInt(v, 10))
    .option('--note <s>', '给模型的作者补充要求')
    .action(async (opts: { book: string; layer: LayerKind; volume?: number; note?: string }) => {
      const r = await draftLayer(opts.book, opts.layer as Exclude<LayerKind, 'position'>, {
        ...(opts.volume !== undefined ? { volume: opts.volume } : {}),
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      });
      if (!r.ok) {
        const status = 'status' in r ? `${r.status} ` : '';
        throw new Error(`LLM 起草失败 [${r.kind}] ${status}${r.detail}（未写任何文件）`);
      }
      process.stdout.write(JSON.stringify({ bookRoot: opts.book, draftFile: r.draftFile, chars: r.text.length }) + '\n');
      process.stderr.write(
        `草稿已写入 ${r.draftFile}（**不是正式文件**）。审阅后改入 ${LAYER_LABEL[opts.layer]} 的正式文件，`
          + '再 confirm。\n',
      );
    });

  plan
    .command('confirm')
    .description('确认某层（对当前文件内容签字，记 contentHash）；卷纲须给 --chapters，细纲确认后 book.json 的 paths.outline 指向该卷')
    .requiredOption('--book <dir>', '书根目录绝对路径')
    .requiredOption('--layer <kind>', `确认哪层（${LAYERS.join(' / ')}）`, parseLayer)
    .option('--volume <n>', '卷号（卷纲/细纲用，缺省 1）', (v: string) => Number.parseInt(v, 10))
    .option('--chapters <a-b>', '本卷章节范围，如 1-60（仅卷纲，必填）', parseChapters)
    .action(async (opts: { book: string; layer: LayerKind; volume?: number; chapters?: { from: number; to: number } }) => {
      const r = await confirmLayer(opts.book, opts.layer, {
        ...(opts.volume !== undefined ? { volume: opts.volume } : {}),
        ...(opts.chapters !== undefined ? { chapters: opts.chapters } : {}),
      });
      process.stdout.write(JSON.stringify({ bookRoot: opts.book, layer: r }) + '\n');
      process.stderr.write(
        `已确认 ${LAYER_LABEL[r.kind]}（${r.file}，hash ${r.hash.slice(0, 8)}）。`
          + '文件再被改动 → 该层回到「待确认」。下一层状态：novel plan status\n',
      );
    });
}
