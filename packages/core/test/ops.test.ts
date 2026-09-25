import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  autoCommitEnabled,
  chapterFileCandidates,
  commitBook,
  isGitRepo,
  planNumberingMigration,
  resolveExistingFile,
} from '../src/index.js';

/**
 * B-51 书目录 git 提交 / B-52 章号编号迁移。
 *
 * 两条最要紧的形状纪律：
 *   · **「提交了」与「没提交」必须不同形**——不是 git 仓库、树干净、
 *     提交失败，三种都返回 `committed:false` **且带原因**，绝不静默成功
 *   · **迁移默认 dry-run**——重命名章文件会动 git 历史与作者的习惯
 */
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(args: string[], cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    const c = spawn('git', args, { cwd, windowsHide: true, env: GIT_ENV });
    c.on('error', () => resolve(null));
    c.on('close', (code) => resolve(code));
  });
}

async function makeBook(withGit: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-ops-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'outline'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '运维测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  if (withGit) {
    await git(['init', '-q'], root);
  }
  return root;
}

// ── B-51 ──────────────────────────────────────────────────────────────────

test('★commitBook：不是 git 仓库 → 明确跳过并给出「怎么变成仓库」', async () => {
  const root = await makeBook(false);
  try {
    assert.equal(await isGitRepo(root), false);
    const r = await commitBook({ bookRoot: root, chapterNo: 1 });
    assert.equal(r.committed, false);
    assert.match(r.skippedReason ?? '', /不是 git 仓库/);
    assert.match(r.skippedReason ?? '', /git init/, '要给出可执行的下一步，不能只说「不行」');
    assert.equal(r.message, '第 1 章');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★commitBook：有改动 → 真提交，回传短 hash；提交信息含章号', async () => {
  const root = await makeBook(true);
  try {
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), '# 第1章\n\n正文。\n', 'utf-8');
    const r = await commitBook({ bookRoot: root, chapterNo: 1, title: '入山' });
    assert.equal(r.committed, true, `应提交成功：${r.skippedReason ?? ''}`);
    assert.equal(r.message, '第 1 章 入山', '★提交信息要含章号（X5 明文），git log 才能扫读');
    assert.ok((r.hash ?? '').length >= 6, '要回传短 hash 供核对');

    // 再提交一次：树干净 → **不是错误**，但必须说清
    const again = await commitBook({ bookRoot: root, chapterNo: 1 });
    assert.equal(again.committed, false);
    assert.match(again.skippedReason ?? '', /没有可提交的改动/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★autoCommitEnabled：默认 **false**（git 历史是作者的东西，工具不替他决定）', async () => {
  const root = await makeBook(true);
  try {
    assert.equal(await autoCommitEnabled(root), false);
    const cfg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root, '.soloent', 'book.json'), 'utf-8')) as Record<string, unknown>;
    cfg['git'] = { autoCommit: true };
    await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify(cfg), 'utf-8');
    assert.equal(await autoCommitEnabled(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── B-52 ──────────────────────────────────────────────────────────────────

test('chapterFileCandidates：四位在前、两位与无填充在后（读取兼容旧名）', () => {
  assert.deepEqual(chapterFileCandidates(7), ['ch-0007.md', 'ch-07.md', 'ch-7.md']);
});

test('resolveExistingFile：目录里哪个宽度在就用哪个；都没有 → null', async () => {
  const root = await makeBook(false);
  try {
    await writeFile(path.join(root, 'outline', 'ch-01.md'), '# 两位', 'utf-8');
    assert.equal(await resolveExistingFile(path.join(root, 'outline'), chapterFileCandidates(1)), 'ch-01.md',
      '★存量书是两位的，必须认得出来');
    await writeFile(path.join(root, 'outline', 'ch-0002.md'), '# 四位', 'utf-8');
    assert.equal(await resolveExistingFile(path.join(root, 'outline'), chapterFileCandidates(2)), 'ch-0002.md');
    assert.equal(await resolveExistingFile(path.join(root, 'outline'), chapterFileCandidates(9)), null,
      '找不到就是找不到，不猜、不静默兜底');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★planNumberingMigration：只出计划不动文件；已是四位的计入 alreadyFour', async () => {
  const root = await makeBook(false);
  try {
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), 'a', 'utf-8');
    await writeFile(path.join(root, 'chapters', 'ch-0002.md'), 'b', 'utf-8');
    await writeFile(path.join(root, 'outline', 'ch-03.md'), 'c', 'utf-8');
    await writeFile(path.join(root, 'chapters', 'not-a-chapter.md'), 'd', 'utf-8');

    const plan = await planNumberingMigration(root);
    assert.deepEqual(plan.entries.map((e) => `${e.from}→${e.to}`), [
      'chapters/ch-01.md→chapters/ch-0001.md',
      'outline/ch-03.md→outline/ch-0003.md',
    ]);
    assert.equal(plan.alreadyFour, 1, '已是四位的不需要动');
    assert.equal(plan.entries.some((e) => e.from.includes('not-a-chapter')), false, '不匹配的一律不动');

    // ★计划阶段**不许动文件**
    const files = await readdir(path.join(root, 'chapters'));
    assert.ok(files.includes('ch-01.md'), '计划阶段不得重命名');
    assert.ok(files.includes('ch-0002.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planNumberingMigration：空目录 → 空计划（不是错误）', async () => {
  const root = await makeBook(false);
  try {
    const plan = await planNumberingMigration(root);
    assert.deepEqual(plan, { entries: [], alreadyFour: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
