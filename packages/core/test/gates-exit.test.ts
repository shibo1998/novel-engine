import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GateFailureError, assertNoResultOnFailure, parseGateError, runGates } from '../src/index.js';

/**
 * B-14：gates 退出码契约。
 *
 *   0 = 正常跑完 → **结论只看 stdout 的 JSON**（findings 几条与退出码无关）
 *   非 0 = 本次**没有产出可用结论**（崩溃 / 环境错）→ 一律当失败处理
 *
 * 这一层要防的是「把非 0 读成查了没问题」——本项目的假绿形态。
 * 纯函数部分（契约判据）不依赖 Python，直接测；真实子进程路径缺 Python 时跳过而非假绿。
 *
 * ⚠️ 探测必须用**异步** spawn（2026-09-24 实测）：本机沙箱对 spawnSync 一律 EBUSY，
 * 用同步探测会在 Python 明明可用的机器上把所有用例静默跳过。
 */
async function pythonAvailable(): Promise<boolean> {
  const py = process.env['NOVEL_PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean): void => { if (!settled) { settled = true; resolve(v); } };
    try {
      const c = spawn(py, ['-c', 'pass'], { windowsHide: true });
      const timer = setTimeout(() => { c.kill('SIGKILL'); done(false); }, 10_000);
      c.on('error', () => { clearTimeout(timer); done(false); });
      c.on('close', (code) => { clearTimeout(timer); done(code === 0); });
    } catch {
      done(false);
    }
  });
}
const HAS_PYTHON = await pythonAvailable();
const skip = HAS_PYTHON ? false : '未找到可用 Python（gates 检查器跑不起来）';

// ── 契约判据（纯函数）─────────────────────────────────────────────────────

test('parseGateError：认得出结构化的 config/crash，认不出的返回 null（不猜语义）', () => {
  const cfg = parseGateError(JSON.stringify({
    gate: 'consistency_check', book_root: '/x', ok: false,
    error: { kind: 'config', detail: '配置结构校验未通过', problems: ['paths.canon 缺失'] },
  }));
  assert.equal(cfg?.kind, 'config');
  assert.deepEqual(cfg?.problems, ['paths.canon 缺失']);

  const crash = parseGateError(JSON.stringify({ ok: false, error: { kind: 'crash', detail: 'boom' } }));
  assert.equal(crash?.kind, 'crash');
  assert.deepEqual(crash?.problems, []);

  assert.equal(parseGateError(''), null, '空 stdout');
  assert.equal(parseGateError('⛔ 人类可读的一坨文本'), null, '不是 JSON');
  assert.equal(parseGateError('{"findings":[]}'), null, '没有 error 段');
  assert.equal(parseGateError('{"error":{"detail":"缺 kind"}}'), null, '缺 kind 不算结构化原因');
});

test('★assertNoResultOnFailure：非 0 退出却吐了完整 GateResult → 当场报契约违规，不挑一个语义活下去', () => {
  // 正常的非 0 输出（结构化错误 / 空 / 纯文本）都应放行——它们不含结论
  for (const ok of [
    '',
    '⛔ 配置错了',
    JSON.stringify({ ok: false, error: { kind: 'config', detail: 'x' } }),
  ]) {
    assertNoResultOnFailure(ok);
  }

  // 含 findings + chapter_count = 完整的 GateResult → 退出码说「没跑成」、stdout 说「跑成了」
  assert.throws(
    () => assertNoResultOnFailure(JSON.stringify({ gate: 'g', chapter_count: 3, counts: {}, findings: [] })),
    (e: unknown) => e instanceof GateFailureError && e.kind === 'shape' && /契约违规/.test(e.message),
  );
});

// ── 真实子进程路径 ────────────────────────────────────────────────────────

/** 造一本 book.json 结构非法的书（缺 _schema / paths / chapter.file_regex / ledger） */
async function makeBrokenBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-gateexit-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'),
    JSON.stringify({ book: { title: '坏配置' }, paths: { chapters: 'chapters' } }), 'utf-8');
  await writeFile(path.join(root, 'chapters', 'ch-01.md'), '# 第1章\n\n正文。\n', 'utf-8');
  return root;
}

test('★配置非法的书 → kind=config（不是笼统的 exit），且 problems 逐条带出来', { skip }, async () => {
  const root = await makeBrokenBook();
  try {
    await assert.rejects(
      () => runGates({ bookRoot: root }),
      (e: unknown) => {
        assert.ok(e instanceof GateFailureError, `期望 GateFailureError，实得 ${String(e)}`);
        assert.equal(e.kind, 'config', '配置错必须与脚本崩溃分开，否则调用方分不出「谁去修」');
        assert.match(e.message, /paths\.canon 缺失/, '缺项要逐条带出来，不能只回显首行');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★非 0 退出绝不产出结论：runGates 抛错而不是返回空 findings（假绿防线）', { skip }, async () => {
  const root = await makeBrokenBook();
  try {
    let returned: unknown = 'NOT_THROWN';
    try {
      returned = await runGates({ bookRoot: root });
    } catch {
      returned = 'THREW';
    }
    assert.equal(returned, 'THREW', '非 0 时若「返回空 findings」，上层就会把全书刷成 clean');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
