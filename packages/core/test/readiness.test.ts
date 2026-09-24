import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPrompt, checkChapterReadiness, enclosingStageHeading, extractChapterSection } from '../src/index.js';

async function makeBook(declaredOutline?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-readiness-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'outline'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    book: { title: '测试书', genre: '都市', platform: '番茄' },
    paths: {
      chapters: 'chapters',
      canon: '.soloent/canon.md',
      ledger: '.soloent/ledger.tsv',
      now: '.soloent/now.md',
      ...(declaredOutline === undefined ? {} : { outline: declaredOutline }),
    },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    rules: { author: [], plugin: [] },
  }), 'utf-8');
  return root;
}

test('checkChapterReadiness：按章文件与卷纲都没有时，才报缺细纲（outlineFile 为空串）', async () => {
  const root = await makeBook();
  try {
    const report = await checkChapterReadiness(root, 1);
    assert.equal(report.outlineFile, '', '没找到任何细纲文件时不许报一个不存在的路径');
    assert.equal(report.outlineText, null);
    assert.equal(report.warnings.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPrompt：注入本章细纲且不因缺少细纲阻断起稿', async () => {
  const root = await makeBook();
  try {
    await writeFile(path.join(root, '.soloent', 'canon.md'), '# 正典\n主角叫林青。\n', 'utf-8');
    await writeFile(path.join(root, 'outline', 'ch-01.md'), '# 本章目标\n林青第一次发现线索。\n', 'utf-8');
    const bundle = await buildPrompt({ bookRoot: root, chapterNo: 1, mode: 'draft' });
    assert.ok(bundle.user.includes('本章细纲'));
    assert.ok(bundle.user.includes('林青第一次发现线索'));
    assert.ok(!bundle.user.includes('缺少本章细纲'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ★ 下面这一组是本次修复的主场景：真书的细纲**按卷**写在一份文件里、逐章按行列出，
//   而旧实现只找 outline/ch-NN.md，于是 34 章全书没有一章有按章文件 → 每章都报缺细纲。
const VOLUME = [
  '# 第一卷「垫底」细纲（第 1–60 章）',
  '',
  '> 卷主题：从全校垫底到年级前十。',
  '> 章末钩子标注：五型轮换。',
  '',
  '## 第一幕（1–10 章）',
  '1 榜尾王座：评级榜更新日，F⁻ 垫底遭群嘲｜钩子·对白炸弹',
  '2 新手礼包：界面初现，开箱定级｜钩子·反常画面',
  '3 第一次加点：体质 0.8→1.1｜钩子·反常画面',
  '',
  '## 第二幕（11–20 章）',
  '11 武课闪身：头一回躲开那一脚',
  '25 幕外的一章：用来验证「不覆盖本章的幕标题不得注入」',
  '',
].join('\n');

test('extractChapterSection：只抠本章那一行，不被邻章与邻近标题越界', () => {
  const s = extractChapterSection(VOLUME, 3);
  assert.ok(s.includes('第一次加点'), '应含本章内容');
  assert.ok(!s.includes('榜尾王座'), '不得含第 1 章');
  assert.ok(!s.includes('武课闪身'), '不得含第 11 章');
  assert.equal(extractChapterSection(VOLUME, 999), '', '定位不到就返回空串，不猜');
});

test('enclosingStageHeading：只认范围确实覆盖本章的幕标题，覆盖不到就不给', () => {
  assert.ok(enclosingStageHeading(VOLUME, 3).includes('第一幕'), '第 3 章落在 1–10 章内');
  assert.ok(enclosingStageHeading(VOLUME, 11).includes('第二幕'), '第 11 章落在 11–20 章内');
  assert.equal(enclosingStageHeading(VOLUME, 25), '', '第 25 章没有任何幕的括号范围覆盖它 → 宁缺勿乱');
});

test('checkChapterReadiness：注入的卷级背景不得混入不覆盖本章的幕标题', async () => {
  const root = await makeBook('outline/卷纲.md');
  try {
    await writeFile(path.join(root, 'outline', '卷纲.md'), VOLUME, 'utf-8');
    const report = await checkChapterReadiness(root, 25);
    assert.ok(report.outlineText?.includes('幕外的一章'));
    assert.ok(!report.outlineText?.includes('第一幕'), '第 25 章不得看到第一幕（1–10 章）的标题');
    assert.ok(!report.outlineText?.includes('第二幕'), '第 25 章不得看到第二幕（11–20 章）的标题');
    assert.ok(report.outlineText?.includes('卷主题'), '卷级全局约束仍应保留');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkChapterReadiness：按章文件缺失时回落到 book.json 声明的卷纲，并只注入本章段', async () => {
  const root = await makeBook('outline/卷纲.md');
  try {
    await writeFile(path.join(root, 'outline', '卷纲.md'), VOLUME, 'utf-8');
    const report = await checkChapterReadiness(root, 3);
    assert.equal(report.outlineScope, 'volume');
    assert.equal(report.outlineChapterSectionMissing, false);
    assert.equal(report.outlineFile, 'outline/卷纲.md');
    assert.ok(report.outlineText?.includes('第一次加点'));
    assert.ok(!report.outlineText?.includes('武课闪身'), '注入内容不得混进别的章');
    assert.ok(!report.warnings.some((w) => w.includes('缺少本章细纲')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkChapterReadiness：卷纲里定位不到本章时，明确说这是卷级背景而不是本章细纲', async () => {
  const root = await makeBook('outline/卷纲.md');
  try {
    await writeFile(path.join(root, 'outline', '卷纲.md'), VOLUME, 'utf-8');
    const report = await checkChapterReadiness(root, 77);
    assert.equal(report.outlineScope, 'volume');
    assert.equal(report.outlineChapterSectionMissing, true);
    assert.ok(report.warnings.some((w) => w.includes('没能定位到第 77 章')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildPrompt：卷纲回落的标题必须写明来源与章段，不能冒充「本章细纲」', async () => {
  const root = await makeBook('outline/卷纲.md');
  try {
    await writeFile(path.join(root, '.soloent', 'canon.md'), '# 正典\n主角叫林青。\n', 'utf-8');
    await writeFile(path.join(root, 'outline', '卷纲.md'), VOLUME, 'utf-8');
    const bundle = await buildPrompt({ bookRoot: root, chapterNo: 3, mode: 'draft' });
    assert.ok(bundle.user.includes('outline/卷纲.md 的第 3 章段'), '标题要写明是卷纲的第几章段');
    assert.ok(bundle.user.includes('第一次加点'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
