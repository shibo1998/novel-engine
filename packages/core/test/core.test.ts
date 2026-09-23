import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isRetryable } from '../src/llm.js';
import { readState, summarizeGateResult } from '../src/state.js';
import { loadRules, RuleFileMissing } from '../src/prompt.js';
import type { GateResult } from '../src/types.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/book-a', import.meta.url));

test('isRetryable：timeout/5xx 可重试，parse/config/4xx 不可', () => {
  assert.equal(isRetryable({ ok: false, kind: 'timeout', detail: '' }), true);
  assert.equal(isRetryable({ ok: false, kind: 'http', status: 500, detail: '' }), true);
  assert.equal(isRetryable({ ok: false, kind: 'http', status: 502, detail: '' }), true);
  assert.equal(isRetryable({ ok: false, kind: 'http', status: 401, detail: '' }), false);
  assert.equal(isRetryable({ ok: false, kind: 'http', status: 422, detail: '' }), false);
  assert.equal(isRetryable({ ok: false, kind: 'config', detail: '' }), false);
  assert.equal(isRetryable({ ok: false, kind: 'parse', detail: '' }), false);
});

test('summarizeGateResult：权重聚合与 checkedMtimeMs 占位 0', () => {
  const result: GateResult = {
    gate: 'g',
    book_root: '/x',
    chapter_count: 2,
    counts: { 提示: 2, 严重: 1 },
    findings: [
      { severity: '提示', chapter: 'ch-01.md', line: 1, check: 'a', detail: '' },
      { severity: '严重', chapter: 'ch-01.md', line: 2, check: 'b', detail: '' },
      { severity: '提示', chapter: 'ch-02.md', line: 3, check: 'c', detail: '' },
    ],
  };
  const m = summarizeGateResult(result);
  assert.equal(m.get('ch-01.md')?.worst, '严重');
  assert.equal(m.get('ch-01.md')?.count, 2);
  assert.equal(m.get('ch-02.md')?.worst, '提示');
  assert.equal(m.get('ch-01.md')?.checkedMtimeMs, 0);
});

test('readState：从 chapters/ 重建索引（章号/标题/字数）', async () => {
  const s = await readState({ bookRoot: fixtureRoot, force: true });
  assert.equal(s.chapters.length, 1);
  assert.equal(s.chapters[0]?.chapterNo, 1);
  assert.equal(s.chapters[0]?.file, 'ch-01.md');
  assert.equal(s.chapters[0]?.title, '测试标题');
  assert.ok((s.chapters[0]?.wordCount ?? 0) > 0);
  assert.equal(s.chapters[0]?.gateStatus, null);
});

test('loadRules：声明缺失文件抛 RuleFileMissing', async () => {
  await assert.rejects(loadRules(fixtureRoot, { author: ['rules/不存在.md'] }), RuleFileMissing);
});

test('loadRules：按声明加载 author 先于 plugin', async () => {
  const { text, refs } = await loadRules(fixtureRoot, { author: ['rules/r1.md'] });
  assert.equal(text.length, 1);
  assert.ok(text[0]!.includes('规则一'));
  assert.deepEqual(refs.author, ['rules/r1.md']);
  assert.deepEqual(refs.plugin, []);
});
