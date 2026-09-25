import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convergeChapter, isPassingWorst, resetLlmBreaker } from '../src/index.js';

/**
 * 这一组要真跑检查器（Python），缺 Python 的机器上跳过而不是假绿。
 *
 * ⚠️ 必须用**异步** spawn，不能用 spawnSync（2026-09-24 实测）：
 * 本机沙箱对同步子进程一律返回 `EBUSY`，连 `python -c pass` 都起不来，
 * 而异步 spawn 完全正常（runGates 走的正是异步那条）。
 * 用 spawnSync 探测的后果是——**在 Python 明明可用的机器上把所有依赖 Python 的
 * 用例静默跳过**，回归网看着绿，实际一条没跑。跳过本身是设计意图，
 * 但「探测失败」与「环境没有」被混成了同一个结果，就是本仓最忌的那种同形。
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

// 含 7 处 AI 句式（裁判腔/柔化副词/时间切片/否定排比/空气拟态）
const AI_STYLE_TEXT = `# 第1章 测试\n\n他知道事情没那么简单。空气仿佛凝固了。\n\n他缓缓抬起头，一瞬间，脑海里闪过无数画面——不是恐惧，不是犹豫，是某种更冷的东西。\n\n林砚轻轻叹了口气。屋里鸦雀无声。\n`;

async function makeBook(draftFree: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-advisory-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'outline'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '提示级测试书' },
    paths: {
      chapters: 'chapters',
      canon: '.soloent/canon.md',
      ledger: '.soloent/ledger.tsv',
      now: '.soloent/now.md',
    },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
    ...(draftFree ? { gate: { draft_free: true } } : {}),
  }), 'utf-8');
  await writeFile(path.join(root, '.soloent', 'canon.md'), '# 正典\n主角：林砚。\n', 'utf-8');
  await writeFile(path.join(root, 'chapters', 'ch-01.md'), AI_STYLE_TEXT, 'utf-8');
  return root;
}

/** 起一个恒定返回同一段正文的假 LLM；返回 [端点, 请求计数器, 关闭函数] */
async function fakeLLM(): Promise<[string, () => number, () => void]> {
  let requests = 0;
  const srv = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: AI_STYLE_TEXT } }] }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return [`http://127.0.0.1:${port}`, () => requests, () => srv.close()];
}

test('isPassingWorst：失败关闭——不认识的取值一律算没过', () => {
  assert.equal(isPassingWorst('clean'), true);
  assert.equal(isPassingWorst('提示'), true, '提示级只报告，与检查器的 draft_free 声明一致');
  assert.equal(isPassingWorst('轻微'), false);
  assert.equal(isPassingWorst('中等'), false);
  assert.equal(isPassingWorst('严重'), false);
  assert.equal(isPassingWorst('unknown'), false, '不认识的值必须失败关闭，不能默认放行');
  assert.equal(isPassingWorst(''), false);
});

test('converge：draft_free 下只剩提示级 → clean-advisory，且不为提示级烧改写轮', { skip }, async () => {
  const root = await makeBook(true);
  const [base, count, close] = await fakeLLM();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      LLM_BASE_URL: base, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
    });
    resetLlmBreaker();
    const r = await convergeChapter({ bookRoot: root, chapterNo: 1 });
    assert.equal(r.stopped, 'clean-advisory', '提示级不构成拦截，应收敛为 clean-advisory');
    // 章已存在 → 不需要起草；提示级不触发改写轮 → **一次请求都不发**。
    // 这正是 draft_free 要的效果：只报告，不为「自由起草」的措辞烧 token。
    assert.equal(r.llmCalls, 0, '提示级不该触发任何 LLM 请求');
    assert.equal(count(), 0);
    assert.equal(r.rounds.at(-1)?.action, 'stop-advisory');
  } finally {
    Object.assign(process.env, saved);
    close();
    await rm(root, { recursive: true, force: true });
  }
});

test('converge：非 draft_free 下同样的正文是拦截级 → 两阶段都用完 → human-needed（停下等人）', { skip }, async () => {
  const root = await makeBook(false);
  const [base, count, close] = await fakeLLM();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      LLM_BASE_URL: base, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
    });
    resetLlmBreaker();
    // maxLocalRounds=0 把定点修订整段跳过，单独测整章重写那条路（本用例的假 LLM
    // 恒定返回同一段正文，定点修订对它没有意义）
    const r = await convergeChapter({ bookRoot: root, chapterNo: 1, maxLocalRounds: 0, maxRewriteRounds: 3 });
    assert.equal(r.stopped, 'human-needed', '机器改不动 → 停下等人，不再是含混的 max-rounds');
    assert.ok((r.handoff?.findings.length ?? 0) > 0, '必须给出交接清单');
    assert.equal(isPassingWorst(r.finalWorst), false, '拦截级未清空 → 批量跑必须据此停下');
    assert.equal(r.llmCalls, 3, '3 轮整章重写各一次请求');
    assert.equal(count(), 3);
    assert.equal(r.rounds.at(-1)?.action, 'stop-human-needed');
  } finally {
    Object.assign(process.env, saved);
    close();
    await rm(root, { recursive: true, force: true });
  }
});

test('★converge：定点修订先于整章重写——按 quote 只改那一句，其余一字不动（B-12）', { skip }, async () => {
  const root = await makeBook(false);
  const saved = { ...process.env };
  let patched = '';
  // 假 LLM：回一条**引句真实存在**的补丁，把「他知道」那句改掉
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            patches: [{
              quote: '他知道事情没那么简单。',
              replacement: '他盯着门缝里那点光，指节发白。',
              reason: '去掉裁判腔，用行为暴露想法',
            }],
          }),
        },
      }],
    }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    Object.assign(process.env, {
      LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
    });
    resetLlmBreaker();
    const r = await convergeChapter({ bookRoot: root, chapterNo: 1, maxLocalRounds: 1, maxRewriteRounds: 0 });
    const first = r.rounds[0];
    assert.equal(first?.phase, 'local', '第一轮必须是定点修订，不是整章重写');
    assert.equal(first?.action, 'local-revise');
    assert.equal(first?.patches?.applied, 1, '引句命中 → 应真的替换掉');
    const { readFile } = await import('node:fs/promises');
    patched = await readFile(path.join(root, 'chapters', 'ch-01.md'), 'utf-8');
    assert.ok(patched.includes('他盯着门缝里那点光'), '被指出的那句应已改写');
    assert.ok(!patched.includes('他知道事情没那么简单'), '原句应已不在');
    assert.ok(patched.includes('空气仿佛凝固了'), '★没被指出的段落一字不动——这正是定点修订的意义');
  } finally {
    Object.assign(process.env, saved);
    srv.close();
    await rm(root, { recursive: true, force: true });
  }
});
