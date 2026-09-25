import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把 `gates/tests/` 的 Python 固件接进 `pnpm -r test`（B-15 / docs/24 P2-2）。
 *
 * 为什么要这一层：Python 固件如果只能靠「记得手动跑 python -m unittest」，
 * 它就等于不存在——本仓栽过太多次「文件在但从不运行」（docs/23 自承、
 * 2026-09-25 又栽过一次硬编码测试清单）。所以让它跟着主测试链一起跑。
 *
 * 缺 Python 时**跳过而不是假绿**：Node 的 skip 会在汇总里留下 `# skipped N`，
 * 「环境没有」与「跑了且通过」形状不同。
 *
 * ⚠️ 探测必须用异步 spawn（2026-09-24 实测）：本机沙箱对 spawnSync 一律 EBUSY，
 * 同步探测会把 Python 明明可用的机器上的用例全部静默跳过。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/core/test → 仓根 */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const TESTS_DIR = path.join(REPO_ROOT, 'gates', 'tests');

const PY = process.env['NOVEL_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');

function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    let err = '';
    c.stdout.setEncoding('utf-8');
    c.stderr.setEncoding('utf-8');
    c.stdout.on('data', (d: string) => { out += d; });
    c.stderr.on('data', (d: string) => { err += d; });
    c.on('error', (e) => resolve({ code: null, out, err: e.message }));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

const probe = await run(PY, ['-c', 'pass']);
const skip = probe.code === 0 ? false : `未找到可用 Python（${PY}）：${probe.err.trim().slice(0, 120)}`;

test('gates 检查器回归固件（gates/tests/test_gates.py）全部通过', { skip }, async () => {
  const r = await run(PY, ['-m', 'unittest', 'discover', '-s', TESTS_DIR, '-t', TESTS_DIR, '-v']);
  // 失败时把输出贴出来——只看「退出码非 0」的话，读日志的人还得自己再跑一遍
  assert.equal(
    r.code,
    0,
    `Python 固件未通过（exit ${r.code ?? 'signal'}）：\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`,
  );
  assert.match(r.err, /OK/, 'unittest 的正常收尾行应在 stderr（unittest 把结果写 stderr）');
  const ran = /Ran (\d+) test/.exec(r.err);
  assert.ok(ran !== null, '要能看到跑了多少条——「跑了几条」与「全过」是两件事');
  assert.ok(Number(ran[1]) >= 19, `固件条数不应减少（实得 ${ran[1]}）——被静默删掉就是回归`);
});
