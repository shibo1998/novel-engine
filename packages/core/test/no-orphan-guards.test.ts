import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「守卫在但零调用者」静态检查（B-66 / docs/24 P2-3）。
 *
 * 本项目已经**三次**栽在同一件事上，且三次都是人肉发现的：
 *   ① `kit.style_doc_issues` 全仓零调用者（洞是「没接线」不是「没实现」）；
 *   ② `hook_check` 两份实现、两份都不生效；
 *   ③ `checkPlanGate` 写完了但零调用者（B-10 才接上）。
 * 这个用例把「人肉发现」换成「机器发现」。
 *
 * ★两条纪律：
 *   1. 断言**必须包含夹具自检**（导出了几个、扫了几个文件）。否则解析器一坏、
 *      导出列表变空 → 孤儿列表当然也空 → 「全绿」。这正是本仓最忌的那种假绿。
 *   2. 必须做**突变验证**（喂一份含假孤儿的 index）。只有「0 孤儿」一种输出的检查器，
 *      无法区分「真的干净」与「它坏了」。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const TOOL = path.join(REPO_ROOT, 'tools', 'find-orphan-exports.mjs');

interface OrphanReport {
  indexFile: string;
  scannedFiles: number;
  exported: number;
  used: number;
  orphanGuards: string[];
  orphanOthers: string[];
  unenumerable: string[];
}

function runTool(extraArgs: string[] = []): Promise<OrphanReport> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [TOOL, '--json', ...extraArgs], { cwd: REPO_ROOT, windowsHide: true });
    let out = '';
    let err = '';
    c.stdout.setEncoding('utf-8');
    c.stderr.setEncoding('utf-8');
    c.stdout.on('data', (d: string) => { out += d; });
    c.stderr.on('data', (d: string) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`工具退出码 ${code}：${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out) as OrphanReport);
      } catch {
        reject(new Error(`工具输出不是 JSON：${out.slice(0, 300)}`));
      }
    });
  });
}

test('★夹具自检：解析器确实解析出了导出、也确实扫到了文件', async () => {
  const r = await runTool();
  // 没有这两条，下面「0 孤儿」可能只是「什么都没解析出来」
  assert.ok(r.exported >= 60, `解析到的导出数太少（${r.exported}）——解析器可能坏了`);
  assert.ok(r.scannedFiles >= 30, `扫到的源文件太少（${r.scannedFiles}）——扫描根可能指错了`);
  assert.equal(r.used + r.orphanGuards.length + r.orphanOthers.length, r.exported, '导出必须被完整分到「有人用」或「孤儿」两桶里，不许漏');
});

test('★突变验证：工具确实抓得住孤儿守卫（否则「0 孤儿」不是结论）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'novel-orphan-'));
  try {
    const fakeIndex = path.join(dir, 'index.ts');
    await writeFile(fakeIndex, [
      "export { assertSomethingNobodyCalls } from './nowhere.js';",
      "export { runGates } from './gates.js';",
      'export type { Whatever } from "./nowhere.js";',
    ].join('\n'), 'utf-8');

    const r = await runTool(['--index', fakeIndex]);
    assert.deepEqual(
      r.orphanGuards,
      ['assertSomethingNobodyCalls'],
      '假 index 里的孤儿守卫必须被抓出来——抓不住就说明这个检查器是摆设',
    );
    // runGates 真实存在且被 apps/ 用着 → 不该出现在孤儿里（证明判据不是「一律报孤儿」）
    assert.ok(!r.orphanGuards.includes('runGates'), '有人用的守卫不许被误报');
    // 类型导出不该进名单（编译期擦除，留着无害）
    assert.ok(!r.orphanGuards.includes('Whatever'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('真仓现状：守卫家族（assert/check/audit/verify/guard/enforce）零孤儿', async () => {
  const r = await runTool();
  assert.deepEqual(
    r.orphanGuards,
    [],
    '这些名字**必须**有生产调用者。出现了就说明又写了一个「在但没人调」的守卫：\n'
      + `  ${r.orphanGuards.join(', ')}\n`
      + '  处置：要么接进调用链，要么删掉——留着只会让下一个人以为它是活的。',
  );
  // 「其它孤儿」只报告不断言：里面多为对外 API（loadFeedback 给 CLI 用、LAYER_ORDER 给未来用）
  // 或测试专用（llmBreakerState）。把它做成硬失败会制造永久噪音，真问题就被淹了。
  assert.ok(Array.isArray(r.orphanOthers));
  assert.deepEqual(r.unenumerable, ['./types.js'], 'export * 无法静态枚举——这条要显式留在报告里，别假装覆盖了');
});
