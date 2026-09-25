import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildStyleAnchor } from '../src/index.js';

/**
 * B-48 文风样稿提炼。需要 Python（检查器的 `--suggest-rhythm`），缺则跳过而非假绿。
 *
 * ★本文件最要紧的一条：**没有样本时要明确报错**，不能返回「指标全 0」——
 * 那会让人以为「我的文风是零句长」，而真相是「样本不够」。
 * 这正是本项目反复在治的「零输入被读成零发现」。
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
const skip = HAS_PYTHON ? false : '未找到可用 Python（检查器跑不起来）';

const PARA = '他推开门，风灌进来。雨点打在瓦上，一阵密一阵疏。远处传来打更的声音，一下，两下。'.repeat(6);

async function makeBook(chapters: number): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-anchor-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '锚点测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  for (let i = 1; i <= chapters; i++) {
    // 每章要超过 300 汉字，否则检查器会判「没有可统计的样本」
    await writeFile(path.join(root, 'chapters', `ch-${String(i).padStart(2, '0')}.md`),
      `# 第${i}章 探针\n\n${PARA}\n\n「你来了。」他抬起头。「嗯。」\n\n${PARA}\n`, 'utf-8');
  }
  return root;
}

test('★B-48：有样本时解析出指标表与可粘贴的阈值', { skip }, async () => {
  const root = await makeBook(3);
  try {
    const r = await buildStyleAnchor(root);
    assert.equal(r.source, '本书现状（chapters/）');
    assert.ok(r.metrics.length >= 4, `应解析出指标行，实得 ${r.metrics.length}`);
    const avg = r.metrics.find((m) => m.name.includes('叙述句平均句长'));
    assert.notEqual(avg, undefined);
    assert.ok((avg?.p25 ?? 0) > 0, '样本够长时均长不该是 0');
    assert.notEqual(r.suggested, null, '要能从输出里抠出那段阈值 JSON');
    assert.equal(r.suggested?.['min_chars'], 300);
    assert.equal(r.suggested?.['enabled'], true);
    assert.notEqual(r.blocked, null, '「按此值 N/M 篇会被拦」要带出来，别让人误以为只拦 25%');
    assert.equal(r.file, null, '默认不写文件');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★B-48：--write 落 anchors/style.md，且明说「改它不生效」', { skip }, async () => {
  const root = await makeBook(2);
  try {
    const r = await buildStyleAnchor(root, { write: true });
    assert.equal(r.file, 'anchors/style.md');
    const md = await readFile(path.join(root, 'anchors', 'style.md'), 'utf-8');
    assert.match(md, /^# 文风锚点/);
    assert.match(md, /\*\*改它不生效\*\*/, '锚点不是闸门——要改标准得改 book.json');
    assert.match(md, /## 实测指标/);
    assert.match(md, /## 建议阈值/);
    assert.match(md, /checks\.rhythm/);
    assert.match(md, /按现状取分位只会固化现状/, '要提醒「按现状校准不改现状」');
    assert.match(md, /## 检查器原始输出/, '原始输出要留着供人工核对');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★B-48：没有样本 → 明确报错并给原因，**不许返回「指标全 0」**', { skip }, async () => {
  const root = await makeBook(1);
  try {
    // 把唯一一章改成很短的（< 300 汉字）
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), '# 第1章\n\n短。\n', 'utf-8');
    await assert.rejects(
      () => buildStyleAnchor(root),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        assert.match(msg, /没有可用的样本/);
        assert.match(msg, /没有超过 300 汉字的样本/, '要转述检查器给的原因');
        assert.match(msg, /--from/, '要给出「按样板书校准」这条路');
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('B-48：--from 指向不存在的目录 → 报错里带上路径', { skip }, async () => {
  const root = await makeBook(1);
  try {
    await assert.rejects(
      () => buildStyleAnchor(root, { from: '不存在的样板书目录' }),
      /不存在的样板书目录|没有可统计的 \.txt/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
