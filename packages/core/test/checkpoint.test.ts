import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RestoreRefused,
  commitState,
  contentHash,
  listCheckpoints,
  pruneCheckpoints,
  readJournal,
  readPendingCommit,
  readState,
  restoreFrom,
  resume,
  rollback,
  writeState,
} from '../src/index.js';

/**
 * B-24 两步提交 + checkpoint + resume + rollback。
 *
 * 治的是什么：`writeState` 是「一次原子写」，但**一次原子写不等于一次可恢复的事务**。
 * 崩溃点只要落在「正文已改、state 未写」之间，重启后 state 与正文就对不上，
 * 而两边都「看起来正常」。
 *
 * 本文件最要紧的两条：
 *   · **崩溃能判定**：pendingCommit 记着目标指纹 → 对得上就补完、对不上就回退，不靠猜
 *   · **restoreFrom 不静默覆盖**：当前 state 来历不明（被手改）时必须拒绝
 */
const TEXT = '# 第1章\n\n他推开门，山风灌进来。\n';

async function makeBook(chapters = 2): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-cp-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: 'checkpoint 测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  for (let i = 1; i <= chapters; i++) {
    await writeFile(path.join(root, 'chapters', `ch-${String(i).padStart(2, '0')}.md`), TEXT, 'utf-8');
  }
  return root;
}

const storyPath = (root: string): string => path.join(root, 'state', 'story.json');
const pendingPath = (root: string): string => path.join(root, 'state', 'run.pendingCommit');

test('★commitState：建 checkpoint + 写 state + 清 pendingCommit + 记 journal', async () => {
  const root = await makeBook();
  try {
    const r = await commitState({ bookRoot: root, reason: '测试提交' });
    assert.equal(r.checkpoint.id, 'cp-0001');
    assert.equal(r.checkpoint.state.chapters.length, 2);
    assert.ok(Object.keys(r.checkpoint.chapterHashes).length === 2, 'checkpoint 要带章文件指纹');
    assert.equal(await readPendingCommit(root), null, '第 ④ 步：pendingCommit 必须被清掉');

    const journal = await readJournal(root);
    assert.equal(journal.length, 1);
    assert.equal(journal[0]?.kind, 'commit');
    assert.equal(journal[0]?.['checkpoint'], 'cp-0001');

    // 第二份序号递增
    const r2 = await commitState({ bookRoot: root, reason: '再来一次' });
    assert.equal(r2.checkpoint.id, 'cp-0002');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume：没有未完成的提交 → none（不是错误）', async () => {
  const root = await makeBook();
  try {
    const r = await resume(root);
    assert.equal(r.action, 'none');
    assert.match(r.detail, /没有未完成的提交/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★resume：目标指纹已就位 → **补完**（第 ③ 步其实写成了，只是没清 pending）', async () => {
  const root = await makeBook();
  try {
    const r = await commitState({ bookRoot: root, reason: 'x' });
    // 手工把 pendingCommit 塞回去（模拟「第 ④ 步没跑完」）
    await writeFile(pendingPath(root), JSON.stringify({
      checkpointId: r.checkpoint.id, startedAt: new Date().toISOString(),
      targetHash: r.stateHash, reason: 'x',
    }), 'utf-8');

    const out = await resume(root);
    assert.equal(out.action, 'completed');
    assert.equal(await readPendingCommit(root), null, '补完要清掉 pending');
    // state 没被动过
    assert.equal(contentHash(await readFile(storyPath(root), 'utf-8')), r.stateHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★resume：目标指纹不符 → **回退**（正文改了、state 没写的中间态不能留着）', async () => {
  const root = await makeBook();
  try {
    const r = await commitState({ bookRoot: root, reason: 'x' });
    // 模拟「第 ③ 步崩了」：pendingCommit 在，但 story.json 被改成了别的内容
    const tampered = JSON.parse(await readFile(storyPath(root), 'utf-8')) as Record<string, unknown>;
    tampered['generatedAt'] = '2000-01-01T00:00:00.000Z';
    await writeFile(storyPath(root), JSON.stringify(tampered, null, 2) + '\n', 'utf-8');
    await writeFile(pendingPath(root), JSON.stringify({
      checkpointId: r.checkpoint.id, startedAt: new Date().toISOString(),
      targetHash: r.stateHash, reason: 'x',
    }), 'utf-8');

    const out = await resume(root);
    assert.equal(out.action, 'rolled-back');
    assert.equal(out.checkpointId, r.checkpoint.id);
    assert.equal(await readPendingCommit(root), null);
    const back = JSON.parse(await readFile(storyPath(root), 'utf-8')) as { generatedAt: string };
    assert.notEqual(back.generatedAt, '2000-01-01T00:00:00.000Z', '★应已回退到 checkpoint 的快照');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume：pendingCommit 指向的 checkpoint 不在了 → 明说「无法自动判定」，不猜', async () => {
  const root = await makeBook();
  try {
    await writeFile(pendingPath(root), JSON.stringify({
      checkpointId: 'cp-9999', startedAt: new Date().toISOString(), targetHash: 'nope', reason: 'x',
    }), 'utf-8');
    const out = await resume(root);
    assert.equal(out.action, 'none');
    assert.match(out.detail, /无法自动判定/);
    assert.match(out.detail, /人工核对/, '要给出下一步，不能只说不行');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★restoreFrom：当前 state 是引擎写的 → 直接成功；**来历不明 → 拒绝**', async () => {
  const root = await makeBook();
  try {
    const a = await commitState({ bookRoot: root, reason: 'A' });
    await commitState({ bookRoot: root, reason: 'B' });

    // 当前 state 是引擎写的（journal 里有它的指纹）→ 直接成功
    const ok = await restoreFrom(root, a.checkpoint.id);
    assert.equal(ok.restored, 'cp-0001');

    // 手改 story.json → 指纹不在 journal 里 → 拒绝
    await writeFile(storyPath(root), JSON.stringify({
      schemaVersion: 2, generatedAt: '1999-01-01T00:00:00.000Z', bookRoot: path.resolve(root), chapters: [],
    }, null, 2) + '\n', 'utf-8');
    await assert.rejects(
      () => restoreFrom(root, a.checkpoint.id),
      (e: unknown) => {
        assert.ok(e instanceof RestoreRefused);
        assert.match(e.message, /在 journal 里找不到/);
        assert.match(e.message, /被手改过/);
        assert.match(e.message, /--force/, '要给出出路');
        assert.match(e.message, /正文文件不会被恢复/, '要提前说清恢复范围');
        return true;
      },
    );
    // --force 才覆盖
    const forced = await restoreFrom(root, a.checkpoint.id, { force: true });
    assert.equal(forced.restored, 'cp-0001');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restoreFrom：未知 id → 报错并列出候选', async () => {
  const root = await makeBook();
  try {
    await commitState({ bookRoot: root, reason: 'A' });
    await assert.rejects(() => restoreFrom(root, 'cp-9999'), /现有：cp-0001/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★rollback：只报「正文与快照不符」，**绝不替作者改正文**', async () => {
  const root = await makeBook();
  try {
    const a = await commitState({ bookRoot: root, reason: 'A' });
    // 快照之后改正文
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), TEXT + '\n他改了主意。\n', 'utf-8');

    const rep = await rollback(root, a.checkpoint.id);
    assert.equal(rep.changedChapters.length, 1);
    assert.equal(rep.changedChapters[0]?.file, 'ch-01.md');
    assert.match(rep.changedChapters[0]?.note ?? '', /内容与快照不符/);
    assert.match(rep.hint, /工具不会替你改正文/);
    assert.match(rep.hint, /git checkout/);
    // ★正文必须原样留着
    assert.ok((await readFile(path.join(root, 'chapters', 'ch-01.md'), 'utf-8')).includes('他改了主意'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rollback：正文与快照一致时不啰嗦（明说「无需回退正文」）', async () => {
  const root = await makeBook();
  try {
    const a = await commitState({ bookRoot: root, reason: 'A' });
    const rep = await rollback(root, a.checkpoint.id);
    assert.equal(rep.changedChapters.length, 0);
    assert.match(rep.hint, /无需回退正文/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★pruneCheckpoints：保留最近 N 份 + **每卷末 1 份**', async () => {
  const root = await makeBook();
  try {
    for (let i = 1; i <= 5; i++) {
      await commitState({ bookRoot: root, reason: `r${i}`, ...(i === 1 ? { volume: 1 } : {}) });
    }
    // 只留最近 2 份；第 1 份虽老，但它是「第 1 卷末」→ 必须留
    const r = await pruneCheckpoints(root, { keepRecent: 2 });
    assert.deepEqual(r.kept, ['cp-0001', 'cp-0004', 'cp-0005'], '卷末那份比中间态值钱');
    assert.deepEqual(r.removed, ['cp-0002', 'cp-0003']);
    assert.equal(await stat(path.join(root, 'state', 'checkpoints', 'cp-0002.json')).catch(() => null), null);
    assert.notEqual(await stat(path.join(root, 'state', 'checkpoints', 'cp-0001.json')).catch(() => null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listCheckpoints：只读元信息，不把每份的完整快照都读进来', async () => {
  const root = await makeBook();
  try {
    await commitState({ bookRoot: root, reason: 'A', volume: 2 });
    const metas = await listCheckpoints(root);
    assert.equal(metas.length, 1);
    assert.deepEqual(Object.keys(metas[0] ?? {}).sort(), ['at', 'chapters', 'id', 'reason', 'seq', 'volume']);
    assert.equal(metas[0]?.volume, 2);
    assert.equal(metas[0]?.chapters, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkpoint 是派生数据：state/ 清空后从正文重建，不报「checkpoint 丢了」', async () => {
  const root = await makeBook();
  try {
    await commitState({ bookRoot: root, reason: 'A' });
    await rm(path.join(root, 'state', 'checkpoints'), { recursive: true, force: true });
    const state = await readState({ bookRoot: root });
    assert.equal(state.chapters.length, 2, 'state 能从 chapters/ 重建');
    assert.deepEqual(await listCheckpoints(root), [], 'checkpoint 没了就是没了——它是派生数据，不是备份');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('commitState：reason 会进 checkpoint 与 journal（出问题时能追是哪一步）', async () => {
  const root = await makeBook();
  try {
    await commitState({ bookRoot: root, reason: '第 7 章收敛结束（clean）' });
    const metas = await listCheckpoints(root);
    assert.equal(metas[0]?.reason, '第 7 章收敛结束（clean）');
    const journal = await readJournal(root);
    assert.equal(journal[0]?.['reason'], '第 7 章收敛结束（clean）');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeState 仍可用（两步提交是增量能力，不替代原子写）', async () => {
  const root = await makeBook();
  try {
    const st = await readState({ bookRoot: root });
    await writeState(st);
    assert.notEqual(await stat(storyPath(root)).catch(() => null), null);
    // 直接 writeState 不产生 checkpoint —— 「有没有回退点」与「state 写没写」是两件事
    assert.deepEqual(await listCheckpoints(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
