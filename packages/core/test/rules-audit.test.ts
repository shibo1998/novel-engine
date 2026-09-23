import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditRules } from '../src/index.js';

/**
 * 造一本带规则目录的书。
 * book: rules.author / rules.plugin 的声明值
 * files: .soloent/ 下的相对 .md 路径清单
 */
async function makeBook(bookRules: unknown, files: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-rules-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await writeFile(
    path.join(root, '.soloent', 'book.json'),
    JSON.stringify(bookRules === null ? {} : { rules: bookRules }),
    'utf-8',
  );
  for (const rel of files) {
    const abs = path.join(root, '.soloent', rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, '# 规则\n', 'utf-8');
  }
  return root;
}

test('auditRules：子目录里的未被声明规则能被抓出来', async () => {
  const root = await makeBook(
    { author: ['rules/a.md'], plugin: [] },
    ['rules/a.md', 'rules/active-plugin-rules/x.md', 'rules/active-plugin-rules/y.md'],
  );
  try {
    const r = await auditRules(root);
    assert.equal(r.declared.length, 1);
    // 递归扫到子目录里的两份
    assert.ok(r.onDisk.includes('rules/active-plugin-rules/x.md'), '必须递归进子目录');
    assert.deepEqual(r.undeclared, ['rules/active-plugin-rules/x.md', 'rules/active-plugin-rules/y.md']);
    assert.deepEqual(r.missing, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auditRules：_candidates/ 不算漏声明（按设计不生效，是待审候选）', async () => {
  const root = await makeBook(
    { author: ['rules/a.md'], plugin: [] },
    ['rules/a.md', 'rules/_candidates/2026-01-01-ch-01.md'],
  );
  try {
    const r = await auditRules(root);
    assert.deepEqual(r.undeclared, [], '_candidates 必须被排除，否则真问题会被淹掉');
    assert.ok(!r.onDisk.some((f) => f.includes('_candidates')), '_candidates 不进 onDisk');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auditRules：声明了但文件不存在 → 进 missing（loadRules 会抛错的那个坑）', async () => {
  const root = await makeBook({ author: ['rules/有.md', 'rules/没有.md'], plugin: [] }, ['rules/有.md']);
  try {
    const r = await auditRules(root);
    assert.deepEqual(r.missing, ['rules/没有.md']);
    assert.deepEqual(r.undeclared, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auditRules：声明用反斜杠或 ./ 前缀也能对上盘上文件（路径归一）', async () => {
  const root = await makeBook(
    { author: ['./rules' + '\\' + 'a.md'], plugin: [] },
    ['rules/a.md'],
  );
  try {
    const r = await auditRules(root);
    assert.deepEqual(r.undeclared, [], '分隔符与 ./ 前缀差异不该被误报成未声明');
    assert.deepEqual(r.missing, [], '声明侧同样要归一，否则会误报缺文件');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auditRules：book.json 缺失/无 rules 段/JSON 坏 → 全部盘上文件算未声明，且不抛错', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-rules-'));
  try {
    await mkdir(path.join(root, '.soloent', 'rules'), { recursive: true });
    await writeFile(path.join(root, '.soloent', 'rules', 'a.md'), '# x\n', 'utf-8');
    const r = await auditRules(root);
    assert.deepEqual(r.declared, []);
    assert.deepEqual(r.undeclared, ['rules/a.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
