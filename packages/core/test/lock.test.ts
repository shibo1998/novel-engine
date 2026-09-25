import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BookLockedError,
  acquireBookLock,
  forceReleaseBookLock,
  readBookLock,
  withBookLock,
  writeChapter,
} from '../src/index.js';

/**
 * 书级写锁（B-25，v0.2 M4.7）。
 *
 * 治的是什么：CLI 与 server 可能同时写同一本书。两个进程各自 readState →
 * 各自写章节 → 各自 writeState，**后写的覆盖先写的，而两边都报告成功**。
 * 这不是理论风险：`convergeChapter` 一轮就要读写 state 两次。
 *
 * 锁放在 `writeChapter` / `convergeChapter` **内部**而不是各入口接线——
 * 接线模式必然漏（B-10 抓到 `novel write` 一道门都没接）。最后一条用例钉住这件事。
 */
async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-lock-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '锁测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  return root;
}

const lockFile = (root: string): string => path.join(root, '.soloent', 'lock.json');

/** 起一个**真实存活**的别的进程，拿它的 pid 来冒充「另一个进程持有锁」 */
async function liveOtherPid(): Promise<{ pid: number; stop: () => void }> {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true });
  await new Promise<void>((r) => { c.on('spawn', () => r()); });
  return { pid: c.pid ?? 0, stop: () => c.kill('SIGKILL') };
}

async function plantLock(root: string, info: Record<string, unknown>): Promise<void> {
  await writeFile(lockFile(root), JSON.stringify(info, null, 2), 'utf-8');
}

const baseInfo = (over: Record<string, unknown>): Record<string, unknown> => ({
  pid: 999_999_999, host: 'other', label: '别的进程', at: new Date().toISOString(), token: 'other-token', ...over,
});

test('取锁 → 释放；文件随之消失', async () => {
  const root = await makeBook();
  try {
    const h = await acquireBookLock(root, { label: '测试' });
    assert.equal(h.acquired, true);
    assert.equal(h.info.pid, process.pid);
    assert.equal((await readBookLock(root))?.label, '测试');
    assert.equal(await h.release(), undefined);
    assert.equal(await readBookLock(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★别的进程持有时拒绝并发写，并给出「怎么接管」的指引', async () => {
  const root = await makeBook();
  const other = await liveOtherPid();
  try {
    await plantLock(root, baseInfo({ pid: other.pid, label: 'novel book 第 1-5 章' }));
    await assert.rejects(
      () => acquireBookLock(root, { label: '我这个进程' }),
      (e: unknown) => {
        assert.ok(e instanceof BookLockedError, `期望 BookLockedError，实得 ${String(e)}`);
        assert.equal(e.holder.pid, other.pid);
        assert.match(e.message, /novel lock status/, '要给出「看是谁」的命令');
        assert.match(e.message, /novel lock release/, '要给出「强制释放」的命令');
        return true;
      },
    );
  } finally {
    other.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('★同进程可重入：convergeChapter 内部调 writeChapter 时不能自己挡自己', async () => {
  const root = await makeBook();
  try {
    const outer = await acquireBookLock(root, { label: '收敛' });
    const inner = await acquireBookLock(root, { label: '起草' });
    assert.equal(inner.acquired, false, '同进程第二次取锁应视为已持有');
    assert.equal(inner.info.token, outer.info.token, '拿到的应是同一把锁');
    // 内层的 release 必须是空操作，否则会提前把外层的锁删掉
    await inner.release();
    assert.notEqual(await readBookLock(root), null, '★内层 release 不得释放外层的锁');
    await outer.release();
    assert.equal(await readBookLock(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★陈旧锁可接管：原持有进程已不存在 → 接管并如实报告原因', async () => {
  const root = await makeBook();
  try {
    await plantLock(root, baseInfo({ pid: 999_999_999, label: '崩掉的进程' }));
    const h = await acquireBookLock(root, { label: '我' });
    assert.equal(h.acquired, true);
    assert.equal(h.tookOverFrom?.pid, 999_999_999);
    assert.match(h.tookOverFrom?.why ?? '', /已不存在/, '要如实说清为什么能接管，不能静默抢');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★陈旧锁可接管：进程还在但锁龄超阈值', async () => {
  const root = await makeBook();
  const other = await liveOtherPid();
  try {
    const old = new Date(Date.now() - 60 * 60_000).toISOString(); // 1 小时前
    await plantLock(root, baseInfo({ pid: other.pid, at: old }));
    const h = await acquireBookLock(root, { label: '我', staleMs: 30 * 60_000 });
    assert.equal(h.acquired, true);
    assert.match(h.tookOverFrom?.why ?? '', /锁龄超过 30 分钟/);
  } finally {
    other.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('★release 只释放自己那把：token 对不上就不动（防「A 接管后 B 把它删了」）', async () => {
  const root = await makeBook();
  try {
    const h = await acquireBookLock(root, { label: '我' });
    // 模拟「锁被别人接管了」：换掉文件里的 token
    await plantLock(root, { ...h.info, token: 'someone-elses-token' });
    const { releaseBookLock } = await import('../src/index.js');
    assert.equal(await releaseBookLock(root, h.info.token), false, 'token 不符应拒绝释放');
    assert.notEqual(await readBookLock(root), null, '别人的锁不许被我删掉');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('withBookLock：函数抛错也要释放（否则一次失败让整本书再也写不了）', async () => {
  const root = await makeBook();
  try {
    await assert.rejects(
      () => withBookLock(root, '会炸的操作', async () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.equal(await readBookLock(root), null, '★异常路径也必须释放');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('forceReleaseBookLock：不看 token 强释，并回传原持有者供如实报告', async () => {
  const root = await makeBook();
  try {
    await plantLock(root, baseInfo({ pid: 12345, label: '卡住的进程' }));
    const prev = await forceReleaseBookLock(root);
    assert.equal(prev?.pid, 12345);
    assert.equal(await readBookLock(root), null);
    assert.equal(await forceReleaseBookLock(root), null, '本来就没有锁时返回 null，不抛错');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('锁文件坏了按「没有锁」处理——不让自己被一个残文件永久挡住', async () => {
  const root = await makeBook();
  try {
    await writeFile(lockFile(root), '{ 这不是 JSON', 'utf-8');
    assert.equal(await readBookLock(root), null);
    const h = await acquireBookLock(root, { label: '我' });
    assert.equal(h.acquired, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★接线：writeChapter 真的持有锁（别的进程占着时它必须拒绝，且早于任何 LLM 调用）', async () => {
  const root = await makeBook();
  const other = await liveOtherPid();
  const saved = { ...process.env };
  try {
    await plantLock(root, baseInfo({ pid: other.pid, label: '另一个进程' }));
    // 故意不配 LLM 环境：若锁没生效，报的会是「环境变量缺失」而不是锁错误
    delete process.env['LLM_BASE_URL'];
    delete process.env['LLM_API_KEY'];
    delete process.env['LLM_MODEL'];
    await assert.rejects(
      () => writeChapter({ bookRoot: root, chapterNo: 1 }),
      (e: unknown) => {
        assert.ok(e instanceof BookLockedError, `★锁必须接在 writeChapter 里；实得 ${String(e)}`);
        return true;
      },
    );
    // 且没落盘
    assert.equal(await stat(path.join(root, 'chapters', 'ch-01.md')).catch(() => null), null);
  } finally {
    Object.assign(process.env, saved);
    other.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('★接线：正常路径下 writeChapter 跑完会释放锁（不留残锁）', async () => {
  const root = await makeBook();
  const saved = { ...process.env };
  try {
    // 用本地假端点让 buildPrompt→callLLM 走通
    const { createServer } = await import('node:http');
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '# 第1章\n\n正文。\n' } }] }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    Object.assign(process.env, {
      LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
    });
    try {
      const r = await writeChapter({ bookRoot: root, chapterNo: 1 });
      assert.equal(r.ok, true, `起草应成功：${JSON.stringify(r)}`);
      assert.equal(await readBookLock(root), null, '★跑完必须释放，否则下一次写入会被自己挡住');
      assert.ok((await readFile(path.join(root, 'chapters', 'ch-01.md'), 'utf-8')).includes('正文'));
    } finally {
      srv.close();
    }
  } finally {
    Object.assign(process.env, saved);
    await rm(root, { recursive: true, force: true });
  }
});
