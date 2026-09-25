import test from 'node:test';
import assert from 'node:assert/strict';
import { RunEventLog, RunRegistry } from '../src/index.js';

/**
 * B-44 长任务事件流。
 *
 * ★本文件最要紧的一条：**`Last-Event-ID` 补不到时必须明说**（`gap: true` + `oldest`）。
 * 假装补发成功会让客户端以为「中间没发生什么」，而真相是「中间的事已经不在缓冲里了」。
 * 这与本项目一贯的「查不到 ≠ 没问题」是同一条。
 */
test('append：id 单调递增；订阅者实时收到', () => {
  const log = new RunEventLog();
  const got: number[] = [];
  const unsub = log.subscribe((e) => got.push(e.id));
  const a = log.append('run-1', 'started', { label: 'x' });
  const b = log.append('run-1', 'progress', { pct: 50 });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.deepEqual(got, [1, 2], '订阅者要实时收到');
  unsub();
  log.append('run-1', 'finished', {});
  assert.deepEqual(got, [1, 2], '退订后不该再收到');
});

test('★since：正常补发只给 id 更大的', () => {
  const log = new RunEventLog();
  log.append('r', 'a');
  log.append('r', 'b');
  log.append('r', 'c');
  const r = log.since(1);
  assert.deepEqual(r.events.map((e) => e.id), [2, 3]);
  assert.equal(r.gap, false);
  assert.equal(r.oldest, 1);
});

test('★since：请求的 id 早于最老的一条 → gap: true（**不许假装补发成功**）', () => {
  const log = new RunEventLog(3);   // 只留 3 条
  for (let i = 0; i < 5; i++) log.append('r', `e${i}`);
  // 现在缓冲里是 id 3、4、5
  assert.equal(log.size, 3);
  assert.equal(log.since(0).oldest, 3);
  assert.equal(log.since(0).gap, true, '★id 1、2 已被丢掉，补不到');
  assert.equal(log.since(1).gap, true, '请求 1 → 缺 id 2（oldest-1）→ 有缺口');
  assert.equal(log.since(2).gap, false, '请求 2 → 3/4/5 都在，**没有缺口**（不是「只要不是最老就报 gap」）');
  assert.equal(log.since(3).gap, false, '请求 3（最老那条）→ 正好接得上');
  assert.equal(log.since(3).events.length, 2);
});

test('环形缓冲：超过 maxEvents 丢最老的，不是丢最新的', () => {
  const log = new RunEventLog(2);
  log.append('r', 'a');
  log.append('r', 'b');
  log.append('r', 'c');
  assert.deepEqual(log.since(0).events.map((e) => e.id), [2, 3], '留下最近的');
});

test('maxEvents 非法 → 构造时就报错（不静默用一个坏配置）', () => {
  assert.throws(() => new RunEventLog(0), /maxEvents 必须是正整数/);
  assert.throws(() => new RunEventLog(-1), /maxEvents 必须是正整数/);
});

test('★RunRegistry：begin 发出 started 事件；finish 发出终态事件；cancel 只对在跑的 run 有效', () => {
  const reg = new RunRegistry();
  const { runId, signal } = reg.begin('/book', '收敛第 7 章');
  assert.match(runId, /^run-[0-9a-f]{12}$/);
  assert.equal(signal.aborted, false);

  const log = reg.logFor('/book');
  assert.deepEqual(log.since(0).events.map((e) => e.kind), ['started']);

  // 取消：真的发出信号
  assert.equal(reg.cancel(runId), true);
  assert.equal(signal.aborted, true);
  assert.equal(reg.get(runId)?.status, 'running', 'cancel 只发信号，状态由 finish 落');

  reg.finish(runId, 'cancelled');
  assert.equal(reg.get(runId)?.status, 'cancelled');
  assert.equal(reg.cancel(runId), false, '★已结束的 run 再取消 → false，不假装成功');
  assert.equal(reg.cancel('run-不存在'), false);
  assert.deepEqual(log.since(0).events.map((e) => e.kind), ['started', 'cancelling', 'cancelled']);
});

test('★RunRegistry：每本书一条独立事件流（混在一起客户端无从分辨）', () => {
  const reg = new RunRegistry();
  reg.begin('/book-a', 'A');
  reg.begin('/book-b', 'B');
  assert.equal(reg.logFor('/book-a').since(0).events.length, 1);
  assert.equal(reg.logFor('/book-b').since(0).events.length, 1);
  assert.equal(reg.list('/book-a').length, 1);
  assert.equal(reg.list('/book-b').length, 1);
  assert.equal(reg.list().length, 2);
});

test('★steer：指令进事件流，且**明标 consumed: false**（当前循环不消费它）', () => {
  const reg = new RunRegistry();
  const { runId } = reg.begin('/book', '收敛第 7 章');
  const e = reg.steer('/book', runId, '把这段改得更冷一些');
  assert.equal(e.kind, 'steer');
  assert.equal(e.data['instruction'], '把这段改得更冷一些');
  assert.equal(e.data['consumed'], false, '★不许让调用方以为「投了就会生效」');
});

test('finish：done 带结果、failed 带错误，都落成事件', () => {
  const reg = new RunRegistry();
  const a = reg.begin('/book', 'x');
  reg.finish(a.runId, 'done', { result: { stopped: 'clean' } });
  const b = reg.begin('/book', 'y');
  reg.finish(b.runId, 'failed', { error: 'boom' });
  const kinds = reg.logFor('/book').since(0).events.map((e) => e.kind);
  assert.deepEqual(kinds, ['started', 'finished', 'started', 'failed']);
  assert.equal(reg.get(a.runId)?.result?.['stopped'], 'clean');
  assert.equal(reg.get(b.runId)?.error, 'boom');
});

test('finish：未知 runId 静默返回（不抛错）——任务早已结束是常态，不是异常', () => {
  const reg = new RunRegistry();
  assert.doesNotThrow(() => reg.finish('run-不存在', 'done'));
});

test('订阅者抛错不影响其它订阅者与任务本身', () => {
  const log = new RunEventLog();
  const got: number[] = [];
  log.subscribe(() => { throw new Error('坏订阅者'); });
  log.subscribe((e) => got.push(e.id));
  assert.doesNotThrow(() => log.append('r', 'x'));
  assert.deepEqual(got, [1]);
});
