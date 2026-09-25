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

/** 用 CLI 自己开一本新书（顺带冒烟 init 命令本身）。extra 可传 `--no-plan` 走旧书路径。 */
async function newBook(extra: string[] = []): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'novel-cli-'));
  const root = path.join(parent, '书');
  const r = await novel(['init', '--dir', root, '--title', '冒烟书', '--genre', '玄幻', '--platform', '番茄', ...extra]);
  assert.equal(r.code, 0, `init 应成功：\n${r.stderr}`);
  return root;
}

/** CLI 输出与 book.json 都可能带 BOM（init 刻意写的），解析前统一剥掉 */
const json = <T>(s: string): T => JSON.parse(s.replace(/^\uFEFF/, '')) as T;

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

test('★B-60：init 默认开启逐层流程 → preflight 两道门都在，且都报未就绪', async () => {
  const root = await newBook();
  try {
    const r = await novel(['preflight', '--book', root, '--chapter', '1']);
    assert.notEqual(r.code, 0);
    const payload = json<{ styleGate: { ready: boolean }; planGate: { enabled: boolean; ready: boolean; blocking: string[] } }>(r.stdout);
    assert.equal(payload.styleGate.ready, false, '三份风格文件没填 → 不就绪');
    assert.equal(payload.planGate.enabled, true, '★init 应一并建 plan.json——否则「多跑一次 plan init」那步一定会漏');
    assert.equal(payload.planGate.ready, false, '五层都没确认 → 逐层闸门拦住');
    assert.ok(payload.planGate.blocking.some((b) => b.includes('定位')), '要指出卡在第一层');
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('init --no-plan：走旧书路径——不建 plan.json，逐层闸门不启用（不连坐）', async () => {
  const root = await newBook(['--no-plan']);
  try {
    const r = await novel(['preflight', '--book', root, '--chapter', '1']);
    const payload = json<{ planGate: { enabled: boolean; ready: boolean } }>(r.stdout);
    assert.equal(payload.planGate.enabled, false, '--no-plan 的书不该被逐层闸门管');
    assert.equal(payload.planGate.ready, true, '不启用 = 恒就绪');
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('★B-58：定位问答要同步进 book.json 的 book 段，不只写 premise.md', async () => {
  const root = await newBook(['--no-plan']);
  try {
    const r = await novel(['plan', 'position', '--book', root,
      '--answer', 'genre=玄幻-高武', '--answer', 'platform=番茄', '--answer', 'reader=男频爽文',
      '--answer', 'logline=落魄少年靠加点系统向上', '--answer', 'protagonist=林青，寒门',
      '--answer', 'cheat=加点系统', '--answer', 'tone=热血短句',
      '--answer', 'selling=打脸升级', '--answer', 'scale=200万字10卷', '--answer', 'ending=登临绝顶',
    ]);
    assert.equal(r.code, 0, `定位应成功：\n${r.stderr}`);

    const cfg = json<{ book: Record<string, string> }>(await readFile(path.join(root, '.soloent', 'book.json'), 'utf-8'));
    assert.equal(cfg.book['genre'], '玄幻-高武', '★genre 要被问答覆盖（init 时传的是「玄幻」）');
    assert.equal(cfg.book['platform'], '番茄');
    assert.equal(cfg.book['audience'], '男频爽文', '目标读者要落到 book 段');
    assert.equal(cfg.book['tone'], '热血短句');
    assert.equal(cfg.book['title'], '冒烟书', '原有键不许被冲掉');
    // 真相源仍是 premise.md
    const premise = await readFile(path.join(root, 'book', 'premise.md'), 'utf-8');
    assert.ok(premise.includes('落魄少年靠加点系统向上'));
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

test('★B-28：rules candidates / adopt 真的接在 CLI 上，且拒绝未改写的候选', async () => {
  const root = await newBook(['--no-plan']);
  try {
    const candDir = path.join(root, '.soloent', 'rules', '_candidates');
    await mkdir(candDir, { recursive: true });
    const raw = path.join(candDir, '2026-09-25-ch-01.md');
    await writeFile(raw, [
      '# 规则候选 · 2026-09-25 · 第 1 章（ch-01.md）', '',
      '> 本文件由 recordFeedback 机械生成：人工改稿与原稿的行级 diff 聚合。', '',
      '**原文**', '', '> 他知道事情没那么简单。', '', '**改后**', '', '> 他盯着门缝里那点光。', '',
    ].join('\n'), 'utf-8');

    // 列候选：要标出「未改写」
    const listed = await novel(['rules', 'candidates', '--book', root]);
    assert.equal(listed.code, 0);
    const list = json<{ id: string; rawDiff: boolean; count: number }[]>(listed.stdout);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, '2026-09-25-ch-01');
    assert.equal(list[0]?.rawDiff, true);
    assert.match(listed.stderr, /未改写/);

    // 未改写 → 拒绝，且退出码 2（环境/参数错），不是 1
    const refused = await novel(['rules', 'adopt', '--book', root, '--candidate', '2026-09-25-ch-01']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /机械生成的行级 diff/);
    assert.match(refused.stderr, /提炼成一句规则/);

    // 改写后 → 采纳成功
    await writeFile(raw, '# 本书补充规则\n\n## 1 叙述\n不用「他知道」这类裁判腔。\n', 'utf-8');
    const ok = await novel(['rules', 'adopt', '--book', root, '--candidate', '2026-09-25-ch-01']);
    assert.equal(ok.code, 0, `采纳应成功：\n${ok.stderr}`);
    const res = json<{ to: string; group: string }>(ok.stdout);
    assert.equal(res.to, 'rules/2026-09-25-ch-01.md');
    assert.equal(res.group, 'author');

    // 声明要落到 book.json（不声明等于没生效）
    const cfg = json<{ rules: { author: string[] } }>(await readFile(path.join(root, '.soloent', 'book.json'), 'utf-8'));
    assert.deepEqual(cfg.rules.author, ['rules/2026-09-25-ch-01.md']);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('★B-25：novel lock status/release 可用，且与 core 的锁文件同源', async () => {
  const root = await newBook(['--no-plan']);
  try {
    // 没有锁 → 明确说没有，而不是空输出
    const none = await novel(['lock', 'status', '--book', root]);
    assert.equal(none.code, 0);
    assert.equal(json<{ lock: unknown }>(none.stdout).lock, null);
    assert.match(none.stderr, /当前没有锁/);

    // 手写一把别人的锁 → status 要报出持有者与用途
    await writeFile(path.join(root, '.soloent', 'lock.json'), JSON.stringify({
      pid: 999999999, host: 'other', label: 'novel book 第 1-5 章', at: new Date().toISOString(), token: 't',
    }), 'utf-8');
    const held = await novel(['lock', 'status', '--book', root]);
    assert.equal(held.code, 0);
    const info = json<{ lock: { pid: number; label: string } }>(held.stdout).lock;
    assert.equal(info.pid, 999999999);
    assert.equal(info.label, 'novel book 第 1-5 章');
    assert.match(held.stderr, /novel lock release/, '要给出接管路径');

    // 强制释放
    const rel = await novel(['lock', 'release', '--book', root]);
    assert.equal(rel.code, 0);
    assert.equal(json<{ released: { pid: number } }>(rel.stdout).released.pid, 999999999);
    assert.match(rel.stderr, /已强制释放/);
    assert.equal(json<{ lock: unknown }>((await novel(['lock', 'status', '--book', root])).stdout).lock, null);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('★B-29：novel stats 报北极星；没有改稿数据时明说「没有数据」而不是 0', async () => {
  const root = await newBook(['--no-plan']);
  try {
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), '# 第1章 冒烟\n\n他推开门，风灌进来。\n', 'utf-8');
    await novel(['state', '--book', root, '--rebuild']);

    const r = await novel(['stats', '--book', root]);
    assert.equal(r.code, 0, `stats 应成功：\n${r.stderr}`);
    const s = json<{ chapters: number; human: { feedbackEntries: number; editedLinesPerKilo: number }; judge: { passRate: number | null } }>(r.stdout);
    assert.equal(s.chapters, 1);
    assert.equal(s.human.feedbackEntries, 0);
    // ★「还没有改稿记录」必须与「改了但没动字」形状不同
    assert.match(r.stderr, /还没有任何改稿记录/);
    assert.match(r.stderr, /不是 0，是没有数据/);
    assert.match(r.stderr, /北极星/);
    assert.equal(s.judge.passRate, null, '一章都没跑判据 → null，不是 0');
    assert.match(r.stderr, /暂无数据/);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('★B-20：novel extract 的 --status / --rollback 可用；没抽过时明说「没抽」', async () => {
  const root = await newBook(['--no-plan']);
  try {
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), '# 第1章 冒烟\n\n他推开门。\n', 'utf-8');
    await novel(['state', '--book', root, '--rebuild']);

    // 没抽过 → 明确指引，不是空输出
    const st0 = await novel(['extract', '--book', root, '--status']);
    assert.equal(st0.code, 0);
    assert.equal(json<{ extractedChapters: number }>(st0.stdout).extractedChapters, 0);
    assert.match(st0.stderr, /还没有抽取任何章/);

    // 手写一条事实记录（模拟已抽过）→ status 要报出来
    const { contentHash } = await import('@novel/core');
    const text = await readFile(path.join(root, 'chapters', 'ch-01.md'), 'utf-8');
    await writeFile(path.join(root, 'state', 'facts.json'), JSON.stringify({
      schemaVersion: 1, bookRoot: path.resolve(root),
      chapters: {
        'ch-01.md': {
          extractedAt: new Date().toISOString(), contentHash: contentHash(text), model: 'm',
          characters: [{ name: '林青', state: { realm: '炼气', location: '', knows: [], ignores: [], relations: [], alive: true }, cause: '', evidence: '他推开门' }],
          foreshadows: [], timeline: [], dropped: 2, malformed: [],
        },
      },
    }, null, 2), 'utf-8');

    const st1 = await novel(['extract', '--book', root, '--status']);
    const s1 = json<{ extractedChapters: number; dropped: number }>(st1.stdout);
    assert.equal(s1.extractedChapters, 1);
    assert.equal(s1.dropped, 2, '★丢弃数要能被看到——「抽出来了」不等于「抽对了」');
    assert.match(st1.stderr, /丢弃 2 条/);

    // 查某人 → 走 novel lookup（B-22 把「反查」独立出去了；
    // 一个答案只留一个入口，不让 extract 和 lookup 各查一遍）
    const ch = await novel(['lookup', 'character', '--book', root, '--name', '林青']);
    assert.equal(ch.code, 0);
    assert.deepEqual(json<{ appearances: number[] }>(ch.stdout).appearances, [1]);
    // 查不存在的人 → 明说没有，并列出已记录的人
    const miss = await novel(['lookup', 'character', '--book', root, '--name', '查无此人']);
    assert.equal(json<{ history: unknown[] }>(miss.stdout).history.length, 0);
    assert.match(miss.stderr, /已记录的出场人物：林青/);

    // 撤回
    const rb = await novel(['extract', '--book', root, '--rollback', '1']);
    assert.equal(rb.code, 0);
    assert.equal(json<{ rolledBack: boolean }>(rb.stdout).rolledBack, true);
    assert.equal(json<{ extractedChapters: number }>((await novel(['extract', '--book', root, '--status'])).stdout).extractedChapters, 0);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('★B-22/B-23：novel foreshadow / lookup 接在 CLI 上，空库时都明说「没有」', async () => {
  const root = await newBook(['--no-plan']);
  try {
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), '# 第1章 冒烟\n\n他推开门。\n', 'utf-8');
    await novel(['state', '--book', root, '--rebuild']);

    // 台账空 → 明确指引
    const l0 = await novel(['foreshadow', 'list', '--book', root]);
    assert.equal(l0.code, 0);
    assert.equal(json<{ items: unknown[] }>(l0.stdout).items.length, 0);
    assert.match(l0.stderr, /台账是空的/);

    // sync（没有事实库 → 0 新增，不该崩）
    const sync = await novel(['foreshadow', 'sync', '--book', root]);
    assert.equal(sync.code, 0, `sync 应成功：\n${sync.stderr}`);
    assert.equal(json<{ added: unknown[] }>(sync.stdout).added.length, 0);

    // lookup 查无此人 → 明说没有 + 报覆盖率
    const ch = await novel(['lookup', 'character', '--book', root, '--name', '林青']);
    assert.equal(ch.code, 0);
    assert.equal(json<{ history: unknown[] }>(ch.stdout).history.length, 0);
    assert.match(ch.stderr, /没有「林青」的记录/);
    assert.match(ch.stderr, /抽取覆盖率：0\/1 章/);

    // timeline 空 → 明说「没抽过的章不在这里」
    const tl = await novel(['lookup', 'timeline', '--book', root]);
    assert.equal(json<{ events: unknown[] }>(tl.stdout).events.length, 0);
    assert.match(tl.stderr, /没抽过的章不在这里/);

    // conflicts 空 → 明说「只说明抽出来的事实不打架」
    const cf = await novel(['lookup', 'conflicts', '--book', root]);
    assert.equal(json<{ hints: unknown[] }>(cf.stdout).hints.length, 0);
    assert.match(cf.stderr, /不说明正文没矛盾/);

    // set 未知 id → 退出码 2，并列出候选
    const bad = await novel(['foreshadow', 'set', '--book', root, '--id', 'f-999', '--level', 'core']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /没有伏笔 f-999/);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});

test('★B-24：novel checkpoint list/commit/resume/rollback 接在 CLI 上', async () => {
  const root = await newBook(['--no-plan']);
  try {
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), '# 第1章 冒烟\n\n他推开门。\n', 'utf-8');
    await novel(['state', '--book', root, '--rebuild']);

    // 还没建过 → 明确说没有
    const l0 = await novel(['checkpoint', 'list', '--book', root]);
    assert.equal(l0.code, 0);
    assert.equal(json<{ checkpoints: unknown[] }>(l0.stdout).checkpoints.length, 0);
    assert.match(l0.stderr, /还没有任何 checkpoint/);

    // 手动建一份
    const c = await novel(['checkpoint', 'commit', '--book', root, '--reason', '测试回退点']);
    assert.equal(c.code, 0, `建 checkpoint 应成功：\n${c.stderr}`);
    assert.equal(json<{ id: string }>(c.stdout).id, 'cp-0001');

    // resume：没有未完成的提交
    const rs = await novel(['checkpoint', 'resume', '--book', root]);
    assert.equal(json<{ action: string }>(rs.stdout).action, 'none');

    // journal 要能看到刚那次提交
    const j = await novel(['checkpoint', 'journal', '--book', root]);
    assert.equal(json<{ total: number }>(j.stdout).total, 1);
    assert.match(j.stderr, /commit/);

    // rollback：正文没改 → 明说「无需回退正文」
    const rb = await novel(['checkpoint', 'rollback', '--book', root, '--id', 'cp-0001']);
    assert.equal(rb.code, 0);
    assert.match(rb.stderr, /无需回退正文/);

    // 未知 id → 退出码 2，列出候选
    const bad = await novel(['checkpoint', 'restore', '--book', root, '--id', 'cp-9999']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /现有：cp-0001/);
  } finally {
    await rm(path.dirname(root), { recursive: true, force: true });
  }
});
