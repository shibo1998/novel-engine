import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CLI 子进程冒烟测试（B-15 / docs/24 P2-1）。
 *
 * 补的是这一类洞：**函数测过了，但「CLI 真的调用它」没测过**。
 * docs/23 自承 `stripGateStatus` 只测了函数本身，没测它有没有接在 `state --set` 上——
 * 而「守卫在但零调用者」正是本仓反复栽的形态（style_doc_issues、hook_check、
 * checkPlanGate 三次同源）。core 的单测永远测不出这件事：接线在 apps/ 这一层。
 *
 * 所以这里**一律起真子进程跑 dist/index.js**，断言只看两样东西：
 * 进程退出码 + stdout 的 JSON。这也顺带把退出码契约（B-14）钉住了。
 *
 * 前置：需要 dist/ 已构建。package.json 的 test 脚本先 tsc 再跑本文件。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'dist', 'index.js');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function novel(args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], {
      windowsHide: true,
      // 清掉 LLM 凭据：这些用例都不该真的调模型，漏配了也要在本地就暴露
      env: { ...process.env, LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    c.stdout.setEncoding('utf-8');
    c.stderr.setEncoding('utf-8');
    c.stdout.on('data', (d: string) => { stdout += d; });
    c.stderr.on('data', (d: string) => { stderr += d; });
    c.on('error', (e) => resolve({ code: null, stdout, stderr: e.message }));
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** 用 CLI 自己开一本新书（顺带冒烟 init 命令本身） */
async function newBook(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'novel-cli-'));
  const root = path.join(parent, '书');
  const r = await novel(['init', '--dir', root, '--title', '冒烟书', '--genre', '玄幻', '--platform', '番茄']);
  assert.equal(r.code, 0, `init 应成功：\n${r.stderr}`);
  return root;
}

const json = <T>(s: string): T => JSON.parse(s) as T;

// ── 接线是否真的生效 ──────────────────────────────────────────────────────

test('★state --set 净化真的接在 CLI 上：伪造的绿写进去，读回来必须是「待检」', async () => {
  const root = await newBook();
  try {
    // init 不产章节；先放一章，否则「伪造的绿」无处可挂（这正是夹具失真的典型形态）
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), '# 第1章 冒烟\n\n他推开门，风灌进来。\n', 'utf-8');

    const before = json<{ chapters: { file: string; contentHash: string }[] }>(
      (await novel(['state', '--book', root, '--rebuild'])).stdout,
    );
    assert.equal(before.chapters.length, 1, '夹具自检：确实索引到 1 章');
    const state = json<Record<string, unknown>>((await novel(['state', '--book', root])).stdout);

    // 伪造一枚「能存活过期清扫」的绿：checkedHash 取**真实内容指纹**
    const forged = {
      ...state,
      chapters: (state['chapters'] as Record<string, unknown>[]).map((ch) => ({
        ...ch,
        gateStatus: { worst: 'clean', count: 0, checkedAt: new Date().toISOString(), checkedHash: before.chapters[0]?.contentHash },
        needsReview: true,
      })),
    };

    const set = await novel(['state', '--book', root, '--set', JSON.stringify(forged)]);
    assert.equal(set.code, 0, `--set 应成功：\n${set.stderr}`);
    const setOut = json<{ gateStatusRemoved: number; needsReviewRemoved: number }>(set.stdout);
    assert.equal(setOut.gateStatusRemoved, 1, '★CLI 必须真的调用了净化——这正是 core 单测测不到的那一步');
    assert.equal(setOut.needsReviewRemoved, 1, 'needsReview 也是结论，同样要摘');

    const after = json<{ chapters: { gateStatus: unknown; needsReview: boolean }[] }>(
      (await novel(['state', '--book', root])).stdout,
    );
    assert.equal(after.chapters.every((c) => c.gateStatus === null), true, '读回来不得有绿');
    assert.equal(after.chapters.every((c) => !c.needsReview), true, '读回来不得有 needsReview');
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('★novel write 也有前置闸门（B-10 修掉的旁路）：风格层没填 → 非 0 且不产正文', async () => {
  const root = await newBook();
  try {
    // 新书的三份风格文件是**未填模板**，风格闸门必然不就绪
    const r = await novel(['write', '--book', root, '--chapter', '1']);
    assert.notEqual(r.code, 0, '风格层未就绪却放行 = 闸门是摆设');
    assert.match(r.stderr, /风格\/红线层未就绪/, '要明确说是哪道门拦的');
    await assert.rejects(
      () => readFile(path.join(root, 'chapters', 'ch-01.md'), 'utf-8'),
      '被拦时不得落盘',
    );
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('preflight：未就绪 → 非 0，且 stdout 里能看到是哪一道门', async () => {
  const root = await newBook();
  try {
    const r = await novel(['preflight', '--book', root, '--chapter', '1']);
    assert.notEqual(r.code, 0);
    const payload = json<{ styleGate: { ready: boolean }; planGate: { enabled: boolean } }>(r.stdout);
    assert.equal(payload.styleGate.ready, false, '三份风格文件没填 → 不就绪');
    assert.equal(payload.planGate.enabled, false, '没建 plan.json 的书：逐层闸门不启用（旧书不连坐）');
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('hooks：只读报告，退出码**恒为 0**（§7.2 纪律——它不当结论用）', async () => {
  const root = await newBook();
  try {
    const r = await novel(['hooks', '--book', root]);
    assert.equal(r.code, 0, 'hooks 的红灯是线索不是结论，退出码不得非 0');
    assert.doesNotThrow(() => json(r.stdout), 'stdout 必须是 JSON');
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('judge --list：一个判据都没声明时给出明确指引（不是静默通过）', async () => {
  const root = await newBook();
  try {
    const r = await novel(['judge', '--book', root, '--list']);
    assert.equal(r.code, 0);
    const payload = json<{ declared: string[]; builtin: { id: string }[] }>(r.stdout);
    assert.deepEqual(payload.declared, []);
    assert.ok(payload.builtin.length >= 3, '内置判据清单要能列出来');
    assert.match(r.stderr, /未声明/, '要明说「此时 judge 不会做任何判定」');
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

// ── 退出码契约（B-14）──────────────────────────────────────────────────────

test('退出码：参数/环境错 → 2；不是 1（1 是「内容未通过」）', async () => {
  // 书目录不存在：命令抛出 → 顶层 catch → 2
  const r = await novel(['plan', 'confirm', '--book', path.join(tmpdir(), '不存在的书-' + Date.now()), '--layer', 'position']);
  assert.equal(r.code, 2, '走到 catch 的从来不是内容结论，必须与「内容未通过」分开');
  assert.ok(r.stderr.trim() !== '', '错误信息要走 stderr');
});

test('退出码：--layer 拼错 → 2（参数错）', async () => {
  const root = await newBook();
  try {
    const r = await novel(['plan', 'confirm', '--book', root, '--layer', 'volumn']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--layer 只能是/, '要说清合法取值');
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('退出码：plan 跳层确认 → 2，且指明是哪个上游层没过', async () => {
  const root = await newBook();
  try {
    await novel(['plan', 'init', '--book', root]);
    const r = await novel(['plan', 'confirm', '--book', root, '--layer', 'setting']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /上游层「position」/, '要指出卡在哪一层，而不是笼统报错');
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('★B-62：风格闸门**抛错**时 preflight 仍要吐 JSON，且与「没就绪」不同形', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'novel-cli-badcfg-'));
  const root = path.join(parent, '坏配置书');
  try {
    // book.json 结构非法 → 检查器 exit 2 → runStyleGate 抛错
    await mkdir(path.join(root, '.soloent'), { recursive: true });
    await mkdir(path.join(root, 'chapters'), { recursive: true });
    await writeFile(path.join(root, '.soloent', 'book.json'),
      JSON.stringify({ book: { title: '坏配置' }, paths: { chapters: 'chapters' } }), 'utf-8');

    const r = await novel(['preflight', '--book', root, '--chapter', '1']);
    assert.notEqual(r.code, 0);
    // 旧版这里 stdout 一个字符都没有，脚本与面板只能从 stderr 猜
    const payload = json<{ styleGate: { ready: boolean; error?: string; blocking?: string[] }; planGate: unknown }>(r.stdout);
    assert.equal(payload.styleGate.ready, false);
    assert.ok(typeof payload.styleGate.error === 'string' && payload.styleGate.error !== '',
      '「没跑成」必须带 error 字段——「没就绪」带的是 blocking，两者不许同形');
    assert.equal(payload.styleGate.blocking, undefined, '没跑成时不该有 blocking');
    assert.notEqual(payload.planGate, undefined, '一道门失败不该把另一道门的信息冲掉');
    assert.match(r.stderr, /没跑成/, '要说清是「没跑成」而不是「没就绪」');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
