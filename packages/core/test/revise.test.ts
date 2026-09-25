import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyPatches, locateQuote, readReviseConfig } from '../src/index.js';
import type { QuotePatch } from '../src/index.js';

// B-12 定点修订：按 quote 局部重写。核心是三条守卫——
// 引句定位不到就跳过、空替换跳过、改动量超限整批放弃。

const TEXT = '林青推开门，山风灌进来。\n他知道事情没那么简单。\n他握紧了那枚玉简。\n';

const p = (quote: string, replacement: string, reason = 'r'): QuotePatch => ({ quote, replacement, reason });

// ── locateQuote ───────────────────────────────────────────────────────────

test('locateQuote：逐字命中给出真实区间；去空白回映射也能定位', () => {
  const span = locateQuote(TEXT, '他握紧了那枚玉简。');
  assert.notEqual(span, null);
  assert.equal(TEXT.slice(span!.start, span!.end), '他握紧了那枚玉简。');

  // 模型复述时改了换行/缩进 → 去空白后仍能定位，且返回的是**正文里的真实区间**
  const wrapped = locateQuote(TEXT, '他知道事情\n  没那么简单。');
  assert.notEqual(wrapped, null);
  assert.equal(TEXT.slice(wrapped!.start, wrapped!.end), '他知道事情没那么简单。');

  assert.equal(locateQuote(TEXT, '他拔剑斩向长老。'), null, '不存在的句子必须定位失败');
  assert.equal(locateQuote(TEXT, '   '), null, '空引句');
});

// ── applyPatches 的三条守卫 ───────────────────────────────────────────────

test('applyPatches：命中即替换，未命中的原句一个字符都不动', () => {
  const r = applyPatches(TEXT, [p('他知道事情没那么简单。', '他盯着门缝里那点光。')]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.rejected, null);
  assert.ok(r.text.includes('他盯着门缝里那点光。'));
  assert.ok(!r.text.includes('他知道事情没那么简单'));
  assert.ok(r.text.includes('林青推开门，山风灌进来。'), '未被指出的段落保持原样');
  assert.ok(r.text.includes('他握紧了那枚玉简。'));
});

test('★守卫 1：引句定位不到 → 跳过并报出原因，正文不变（防幻觉）', () => {
  const r = applyPatches(TEXT, [p('他拔剑斩向血刀门长老。', '改成别的。')]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]?.why ?? '', /未能在正文中定位/);
  assert.equal(r.text, TEXT, '没有可应用的补丁时正文必须原样返回');
});

test('★守卫 2：替换文本为空 → 跳过（静默删正文不可逆，交人工）', () => {
  const r = applyPatches(TEXT, [p('他知道事情没那么简单。', '   ')]);
  assert.equal(r.applied.length, 0);
  assert.match(r.skipped[0]?.why ?? '', /替换文本为空/);
  assert.equal(r.text, TEXT);
});

test('★守卫 3：补丁条数超上限 → 整批放弃并说明（那已是重写而非定点修订）', () => {
  const many = Array.from({ length: 5 }, (_, i) => p('他握紧了那枚玉简。', `第${i}版。`));
  const r = applyPatches(TEXT, many, { maxPatches: 3 });
  assert.equal(r.applied.length, 0);
  assert.equal(r.text, TEXT);
  assert.match(r.rejected ?? '', /超过单次上限 3/);
});

test('★守卫 3：改动字符占比超上限 → 整批放弃', () => {
  // 一次替换掉全文 90% 的字符
  const r = applyPatches(TEXT, [p(TEXT.trim(), '一句话。')], { maxReplacedRatio: 0.5 });
  assert.equal(r.applied.length, 0);
  assert.equal(r.text, TEXT);
  assert.match(r.rejected ?? '', /超过上限 50%/);
});

test('区间重叠的补丁只保留先出现的那条，另一条记为跳过', () => {
  const r = applyPatches(TEXT, [
    p('他知道事情没那么简单。', 'A。'),
    p('没那么简单', 'B'),
  ]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0]?.replacement, 'A。');
  assert.match(r.skipped[0]?.why ?? '', /重叠/);
});

test('多条不重叠的补丁按偏移从后往前应用，互不破坏', () => {
  // 用接近真实章节长度的正文：默认的「改动量 ≤50%」守卫在短文本上会误伤
  // （两条各 10 字的补丁在 35 字正文里就是 57%——那确实是重写而非定点）
  const long = [
    '林青推开门，山风灌进来，吹得窗纸哗哗响。',
    '院子里那棵老槐树落了一地叶子。',
    '他知道事情没那么简单。',
    '远处传来打更的声音，一下，两下。',
    '他握紧了那枚玉简。',
    '灶上的水开了，白汽一股股往上冒。',
  ].join('\n') + '\n';

  const r = applyPatches(long, [
    p('他知道事情没那么简单。', '他盯着门缝里那点光。'),
    p('他握紧了那枚玉简。', '他把玉简按进掌心。'),
  ]);
  assert.equal(r.rejected, null, `不该被改动量守卫拦下：${r.rejected ?? ''}`);
  assert.equal(r.applied.length, 2);
  assert.equal(r.skipped.length, 0);
  assert.ok(r.text.includes('他盯着门缝里那点光。'));
  assert.ok(r.text.includes('他把玉简按进掌心。'));
  assert.ok(r.text.includes('院子里那棵老槐树落了一地叶子。'), '未被指出的段落保持原样');
  assert.ok(r.text.includes('灶上的水开了，白汽一股股往上冒。'));
});

// ── B-68：改动量上限可从 book.json 配 ──────────────────────────────────────

async function makeBook(revise?: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-revisecfg-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    book: { title: 't' }, paths: { chapters: 'chapters' }, chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ...(revise !== undefined ? { revise } : {}),
  }), 'utf-8');
  return root;
}

test('★B-68：book.json 的 revise 段可覆盖改动量上限', async () => {
  const root = await makeBook({ maxPatches: 3, maxReplacedRatio: 0.2 });
  try {
    assert.deepEqual(await readReviseConfig(root), { maxPatches: 3, maxReplacedRatio: 0.2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★B-68：没配 / 非法值一律回退默认（手滑的配置不该让整章生成失败）', async () => {
  for (const bad of [undefined, {}, { maxPatches: -1 }, { maxPatches: 'abc' }, { maxPatches: 0 }, { maxReplacedRatio: null }]) {
    const root = await makeBook(bad);
    try {
      assert.deepEqual(await readReviseConfig(root), {}, `非法配置 ${JSON.stringify(bad)} 应回退默认`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('★B-68：读出来的配置传进 applyPatches 真的改变行为（不是读了不用）', async () => {
  // 用接近真实章节长度的正文：短文本上「改动量 ≤50%」会先拦住，测不出 maxPatches
  const long = [
    '林青推开门，山风灌进来，吹得窗纸哗哗响。',
    '院子里那棵老槐树落了一地叶子。',
    '他知道事情没那么简单。',
    '远处传来打更的声音，一下，两下。',
    '他握紧了那枚玉简。',
    '灶上的水开了，白汽一股股往上冒。',
    '墙角那只猫抬起头，又趴了回去。',
  ].join('\n') + '\n';
  const three = [
    p('他知道事情没那么简单。', '他盯着门缝里那点光。'),
    p('他握紧了那枚玉简。', '他把玉简按进掌心。'),
    p('林青推开门，山风灌进来，吹得窗纸哗哗响。', '林青推开门，风灌进来，窗纸哗哗响。'),
  ];

  assert.equal(applyPatches(long, three).applied.length, 3, '默认上限 12 → 三条都过');

  const root = await makeBook({ maxPatches: 2 });
  try {
    const cfg = await readReviseConfig(root);
    const r = applyPatches(long, three, cfg);
    assert.equal(r.applied.length, 0, '★配了 maxPatches:2 → 整批放弃（配置真的被用上了）');
    assert.match(r.rejected ?? '', /超过单次上限 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── B-71：作者指令进 revise prompt ─────────────────────────────────────────

test('★B-71：authorInstructions 会进 revise 的 prompt；为空时不加空标题段', async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createServer } = await import('node:http');
  const { contentHash, readState, resetLlmBreaker } = await import('../src/index.js');

  const root = await mkdtemp(path.join(tmpdir(), 'novel-steer-'));
  try {
    await mkdir(path.join(root, '.soloent'), { recursive: true });
    await mkdir(path.join(root, 'chapters'), { recursive: true });
    await mkdir(path.join(root, 'state'), { recursive: true });
    await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
      _schema: 1, book: { title: 't' },
      paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
      chapter: { file_regex: '^ch-(\\d+)\\.md$' },
      ledger: { columns: ['章'], chapter_column: '章' },
    }), 'utf-8');
    const text = '他推开门，风灌进来。';
    await writeFile(path.join(root, 'chapters', 'ch-01.md'), text, 'utf-8');

    const prompts: string[] = [];
    const srv = createServer((_req, res) => {
      let body = '';
      _req.on('data', (d) => { body += d; });
      _req.on('end', () => {
        const u = (JSON.parse(body) as { messages?: { role: string; content: string }[] })
          .messages?.find((m) => m.role === 'user')?.content ?? '';
        prompts.push(u);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // 返回一个能定位的合法补丁，让流程走完
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches: [{ quote: '他推开门，风灌进来。', replacement: '他推开门，冷风灌进来。', reason: 'x' }] }) } }] }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
        NOVEL_CONFIG_FILE: path.join(tmpdir(), 'novel-test-无此配置文件.json'),
      });
      resetLlmBreaker();

      const { reviseByQuote } = await import('../src/index.js');
      await reviseByQuote({
        bookRoot: root, chapterNo: 1,
        findings: [{ severity: '中等', chapter: 'ch-01.md', line: 1, check: '[M1] 节奏', detail: '他推开门，风灌进来。' }],
        authorInstructions: ['把雨写得更冷', '删掉那句总结'],
      });

      assert.match(prompts[0] ?? '', /# 作者指令/, '有指令时要出现在 prompt 里');
      assert.match(prompts[0] ?? '', /1\. 把雨写得更冷/);
      assert.match(prompts[0] ?? '', /2\. 删掉那句总结/);
      assert.match(prompts[0] ?? '', /与本轮发现冲突时.*优先执行/, '要说明优先级');
    } finally {
      Object.assign(process.env, saved);
      resetLlmBreaker();
      srv.close();
      await rm(root, { recursive: true, force: true });
    }
  } catch (e) {
    throw e;
  }
});
