#!/usr/bin/env node
// 找出「core 导出了，但 apps/ 一处都没引用」的符号（B-66 / docs/24 P2-3）。
//
// 为什么需要它：本项目已经**三次**栽在同一件事上——判据写好了、没人调用，
// 于是「有守卫」与「没守卫」在行为上完全一样：
//   ① `kit.style_doc_issues` 全仓零调用者（洞是「没接线」不是「没实现」）；
//   ② `hook_check` 两份实现、两份都不生效；
//   ③ `checkPlanGate` 写完了但零调用者（B-10 才接上）。
// 三次都是**人肉发现**的。这个脚本把「人肉」换成「机器」，并且纳入测试。
//
// 用法：
//   node tools/find-orphan-exports.mjs                    # 人类可读报告
//   node tools/find-orphan-exports.mjs --json             # 结构化输出
//   node tools/find-orphan-exports.mjs --json --index <p> # 换一份 index 当输入（供测试做突变验证）
//
// 判据的边界（刻意保守，信噪比比覆盖率重要）：
//   · 搜索范围 = `packages/core/src/**` + `apps/**`，**不含测试目录**。
//     为什么不含测试：测试里用到只能证明「这个函数被跑过」，**不证明它接进了生产链路**。
//     本工具要回答的是「守卫在但零调用者」，而「零调用者」指的是**生产代码里没人调**。
//   · 「孤儿」的准确判据：**除了定义那一处之外，没有任何引用**。
//     即：定义文件里出现次数 ≤1（只有 `export function foo`）且其它文件零命中。
//     为什么不是「定义文件整个排除」——那会把「只在本模块内被调用」的守卫（完全正常）
//     全报成孤儿，噪音一多真问题就淹了。
//   · 只看**值导出**；`export type` 编译期擦除，留着无害。
//   · `export * from './types.js'` 无法静态枚举，跳过并在报告里说明（不假装覆盖了）。
//   · **Python 侧不在范围内**（`gates/` 的判据）。历史上 style_doc_issues 那类事故
//     发生在 Python，本工具看不见——别把它当成全覆盖。
//
// 退出码恒为 0：它是**报告**不是闸门。「哪些算必须有人调」由调用方（测试）决定，
// 判据只允许有一个来源，别在这里再长一份。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * `--index <path>` 只是为了让**测试能喂一份假 index** 来验证本工具「有牙齿」。
 * 没有它，这个检查器只有「0 孤儿」一种输出，而 0 既可能是「真的干净」，
 * 也可能是「解析器坏了、一个导出都没解析出来」——两种 0 必须形状不同。
 */
const indexArgIdx = process.argv.indexOf('--index');
const INDEX = indexArgIdx === -1
  ? path.join(REPO_ROOT, 'packages', 'core', 'src', 'index.ts')
  : path.resolve(process.argv[indexArgIdx + 1]);
const CORE_SRC = path.join(REPO_ROOT, 'packages', 'core', 'src');
const APPS = path.join(REPO_ROOT, 'apps');

/** 守卫家族：这些名字**必须**有调用者，否则就是「守卫在但零调用者」 */
const GUARD_PATTERN = /^(assert|check|audit|verify|guard|enforce)[A-Z]/;

/** 递归收集 .ts/.tsx（跳过 node_modules 与 dist） */
function collectSources(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(abs);
    }
  };
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true) walk(dir);
  return out;
}

/** 从 index.ts 抠出值导出名（跳过 `export type` 与 `export *`） */
function parseValueExports(src) {
  const names = [];
  const skipped = [];
  // `export * from '...'` —— 无法静态枚举
  for (const m of src.matchAll(/^export\s+\*\s+from\s+'([^']+)'/gm)) skipped.push(m[1]);
  // 逐条 export 语句（可能跨行）
  for (const m of src.matchAll(/^export\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+'([^']+)'/gm)) {
    const isType = m[1] !== undefined;
    const from = m[3];
    for (const raw of m[2].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim() ?? '';
      if (name === '') continue;
      if (isType) continue;
      names.push({ name, from });
    }
  }
  return { names, skipped };
}

/** `./gates.js` → `<core/src>/gates.ts`（用于把定义文件排除在搜索范围外） */
function definingFile(from) {
  const base = from.replace(/^\.\//, '').replace(/\.js$/, '');
  return path.join(CORE_SRC, base + '.ts');
}

const indexSrc = readFileSync(INDEX, 'utf-8');
const { names, skipped } = parseValueExports(indexSrc);
const coreSources = collectSources(CORE_SRC);
const appSources = collectSources(APPS);
const allSources = [...coreSources, ...appSources];
const blobs = allSources.map((f) => ({ file: f, text: readFileSync(f, 'utf-8') }));

const orphans = [];
const used = [];
for (const { name, from } of names) {
  const def = definingFile(from);
  const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g');
  const countIn = (text) => (text.match(re) ?? []).length;

  const defBlob = blobs.find((b) => b.file === def);
  const defCount = defBlob === undefined ? 0 : countIn(defBlob.text);
  const otherHits = blobs
    .filter((b) => b.file !== def && b.file !== INDEX && re.test(b.text))
    .map((b) => path.relative(REPO_ROOT, b.file).split(path.sep).join('/'));

  // 定义处本身算 1 次；≤1 且外部零命中 = 真的没人调
  if (defCount <= 1 && otherHits.length === 0) {
    orphans.push({ name, from, guard: GUARD_PATTERN.test(name), defCount });
  } else {
    used.push({ name, defCount, otherHits });
  }
}

const guards = orphans.filter((o) => o.guard).map((o) => o.name);
const others = orphans.filter((o) => !o.guard).map((o) => o.name);

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({
    repoRoot: REPO_ROOT,
    indexFile: INDEX,
    scannedFiles: allSources.length,
    exported: names.length,
    used: used.length,
    orphanGuards: guards,
    orphanOthers: others,
    unenumerable: skipped,
  }) + '\n');
} else {
  process.stdout.write(
    `core 值导出 ${names.length} 个；扫了 core/src ${coreSources.length} + apps ${appSources.length} 个源文件`
      + '（**已排除各自的定义文件**）\n',
  );
  if (skipped.length > 0) {
    process.stdout.write(`⚠️ 无法静态枚举（未纳入本次检查，别当成已覆盖）：${skipped.join(', ')}\n`);
  }
  process.stdout.write(`\n【守卫家族·零调用者】${guards.length} 个\n`);
  for (const g of guards) process.stdout.write(`  ⛔ ${g}\n`);
  process.stdout.write(`\n【其它·零调用者】${others.length} 个（多为对外 API 或测试专用，未必是问题）\n`);
  for (const o of others) process.stdout.write(`  · ${o}\n`);
}
process.exitCode = 0;
