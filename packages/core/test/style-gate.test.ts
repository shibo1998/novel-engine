import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertStyleReady, runStyleGate, StyleNotReadyError } from '../src/index.js';

/**
 * 风格/红线层前置闸门的回归网。
 *
 * 为什么要有这个文件：这套判据（`kit.style_doc_issues` / `style_gate_ready`）在迁仓前
 * 就写好了，却**一个调用者都没有**——死代码。于是「有守卫」与「没守卫」在行为上
 * 完全一样，而且不会有任何红灯。本文件把四条不变量固化下来：
 *
 *   ① 三份文件没填 → 不就绪（闸门真的会拦）
 *   ② 三份文件填好 → 就绪（不会把正常书误拦）
 *   ③ **删掉文件仍不就绪** —— 这是最容易退回去的一条：
 *      只要有人把就绪判据改回「只算 block（占位符）」，删文件就成了一条绕过路径，
 *      而测试若只覆盖「占位符」，这个洞不会被任何红灯照出来。
 *   ④ 全角「（待填）」也算占位符 —— 那正是 `novel init` 实际写出的形态。
 *
 * 需要真 Python（跑 gates/style_doc_check.py），缺 Python 的机器上跳过而不是假绿。
 *
 * ⚠️ 必须用**异步** spawn：本机沙箱对 spawnSync 一律返回 EBUSY（连 `python -c pass`
 * 都起不来），而异步 spawn 正常。用 spawnSync 探测会把「探测失败」误报成
 * 「环境没有 Python」，于是在 Python 可用的机器上静默跳过全部依赖 Python 的用例——
 * 回归网看着全绿，实际一条没跑。（同样的坑在 converge-advisory.test.ts 里也踩过。）
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

/**
 * 与 gates/kit.py 的 STYLE_DOCS 逐字对齐的三条路径。
 *
 * ⚠️ 刻意写成**正斜杠字面量**、不用 path.join：kit.py 的 STYLE_DOCS 默认值就是正斜杠
 * 字符串，检查器把它们原样回显（它没有 path.join 过）。测试若用 path.join，
 * Windows 上会得到反斜杠，于是「消息里有没有点名这个文件」这类断言会假失败——
 * 断言写错比测试缺失更坏：它会让人以为产品坏了。
 */
const STYLE_PATHS = {
  style: '.soloent/rules/story-style.md',
  constitution: '.soloent/constitution/MASTER.md',
  expectation: '1-边界/预期.md',
};

const FILLED_STYLE = '# 本书风格规则\n\n叙述句以 18–30 字为主，长短交替。\n';
const FILLED_CONSTITUTION = '# 创作宪法\n\n一致性高于文采。\n';
const FILLED_EXPECTATION = '# 新书预期\n\n写一个靠算计往上爬的人。\n';

async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-style-'));
  await mkdir(path.join(root, '.soloent', 'rules'), { recursive: true });
  await mkdir(path.join(root, '.soloent', 'constitution'), { recursive: true });
  await mkdir(path.join(root, '1-边界'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '风格闸门测试书' },
    paths: {
      chapters: 'chapters',
      canon: '.soloent/canon.md',
      ledger: '.soloent/ledger.tsv',
      now: '.soloent/now.md',
    },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['ch'], chapter_column: 'ch' },
  }, null, 2), 'utf-8');
  return root;
}

async function fillAll(root: string): Promise<void> {
  await writeFile(path.join(root, STYLE_PATHS.style), FILLED_STYLE, 'utf-8');
  await writeFile(path.join(root, STYLE_PATHS.constitution), FILLED_CONSTITUTION, 'utf-8');
  await writeFile(path.join(root, STYLE_PATHS.expectation), FILLED_EXPECTATION, 'utf-8');
}

test('style gate：三份文件一份都没落 → 不就绪，且每份都有对应的 finding', { skip }, async () => {
  const root = await makeBook();
  try {
    const report = await runStyleGate(root);
    assert.equal(report.ready, false);
    assert.equal(report.findings.length, 3);
    assert.equal(report.blocking.length, 3);
    // 三份文件都要被点名，而不是只报一个总数——读者需要知道去填哪个
    for (const rel of Object.values(STYLE_PATHS)) {
      assert.ok(
        report.findings.some((f) => f.check.includes(rel) || f.detail.includes(rel)),
        `未点名 ${rel}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('style gate：填好三份 → 就绪（不误拦正常书）', { skip }, async () => {
  const root = await makeBook();
  try {
    await fillAll(root);
    const report = await runStyleGate(root);
    assert.equal(report.ready, true);
    assert.equal(report.findings.length, 0);
    // assertStyleReady 只在未就绪时抛；就绪时应正常返回
    await assertStyleReady(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('style gate：★删掉文件仍不就绪（堵「删文件绕过闸门」）', { skip }, async () => {
  const root = await makeBook();
  try {
    await fillAll(root);
    await rm(path.join(root, STYLE_PATHS.constitution));
    const report = await runStyleGate(root);
    // 关键：缺文件不是 block 级（旧判据只算 block），但**必须**仍然不就绪。
    // 判据是「一条 issue 都没有」，不是「没有 block」。
    assert.equal(report.ready, false, '删掉文件后闸门放行了——判据退化回「只算 block」了');
    assert.equal(report.findings.length, 1);
    assert.match(report.findings[0]?.detail ?? '', /缺失或为空/);
    // 这条断言用来钉住第二道防线：缺文件本身必须被归为「阻断」级（映射到「严重」），
    // 而不是「提醒」。两道防线是独立的——只改就绪判据或只改分级，都还有另一道兜着，
    // 所以光看 ready 无法分辨是哪一道破了；钉住严重度才能让两处都受测试约束。
    assert.equal(
      report.findings[0]?.severity, '严重',
      '「文件缺失」被降级成非阻断级了——删文件就成了一条绕过路径',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('style gate：占位符（含全角「（待填）」）→ 不就绪', { skip }, async () => {
  const root = await makeBook();
  try {
    await fillAll(root);
    // 全角括号那种是 `novel init` 实际写进 canon/now 的形态；
    // 词表少收一条，闸门就会对最常见的占位写法视而不见。
    await writeFile(path.join(root, STYLE_PATHS.style), '# 本书风格规则\n\n（待填）\n', 'utf-8');
    const report = await runStyleGate(root);
    assert.equal(report.ready, false);
    assert.match(report.findings[0]?.detail ?? '', /占位符/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('style gate：与插件模板一字不差 → 不就绪（等于没填）', { skip }, async () => {
  const root = await makeBook();
  try {
    await fillAll(root);
    // 逐字复制插件模板。挑 `预期.md`：它**不含**占位符词表里的任何标记，
    // 所以「与模板 byte 级相同」是唯一能识别它的信号（story-style.md 里全是 ✏️，
    // 会先命中占位符那条并 continue，走不到模板比对——这里要验的正是后者）。
    // 这条依赖 kit.TEMPLATES 指向真实目录：它曾指向不存在的 <仓根>/templates，
    // 而比对外面套着 isfile 守卫，于是这条判据静默失效。
    const tpl = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..',
      'content', 'templates', '预期.md',
    );
    await writeFile(path.join(root, STYLE_PATHS.expectation), await readFile(tpl, 'utf-8'), 'utf-8');
    const report = await runStyleGate(root);
    assert.equal(report.ready, false);
    assert.equal(report.findings.length, 1, '除「一字不差」外不该有别的发现');
    assert.match(report.findings[0]?.detail ?? '', /一字不差/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('style gate：assertStyleReady 不就绪时抛 StyleNotReadyError，且消息里给出该填的文件', { skip }, async () => {
  const root = await makeBook();
  try {
    await assert.rejects(
      () => assertStyleReady(root),
      (e: unknown) => {
        assert.ok(e instanceof StyleNotReadyError, `期望 StyleNotReadyError，实得 ${String(e)}`);
        for (const rel of Object.values(STYLE_PATHS)) {
          assert.ok(e.message.includes(rel), `错误消息未点名 ${rel}`);
        }
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
