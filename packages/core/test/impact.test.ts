import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  analyzeImpact,
  contentHash,
  readState,
  resetLlmBreaker,
  rewriteInOrder,
  syncForeshadows,
} from '../src/index.js';
import type { ChapterFacts, FactsStore } from '../src/index.js';

/**
 * B-41 设定变更影响分析 + 顺序重写。
 *
 * ★三步，**中间那步必须是人**：① 分析（机器）② 圈定（人）③ 顺序重写（机器）。
 * 本文件最要紧的一条是③的**强制升序**：后面的章要看到前面改完的结果，
 * 先改第 12 章再改第 7 章的话，第 12 章的 prompt 里读到的还是**旧**的第 7 章
 * ——那正是「改一处、错两处」的来源。
 */
async function makeBook(texts: Record<number, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-impact-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '影响测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  for (const [no, text] of Object.entries(texts)) {
    await writeFile(path.join(root, 'chapters', `ch-${String(no).padStart(2, '0')}.md`), text, 'utf-8');
  }
  return root;
}

test('★analyzeImpact：命中章按命中数降序，带行号片段；没命中的章不出现', async () => {
  const root = await makeBook({
    1: '# 第1章\n\n林青是炼气三层。\n他自认炼气三层够用。\n',
    2: '# 第2章\n\n雨下了一夜。\n',
    3: '# 第3章\n\n林青已入炼气三层。\n',
  });
  try {
    const r = await analyzeImpact(root, ['炼气三层']);
    assert.deepEqual(r.terms, ['炼气三层']);
    assert.deepEqual(r.chapters.map((c) => c.chapterNo), [1, 3], '按命中数降序（1 章命中 2 次）');
    assert.equal(r.chapters[0]?.hits['炼气三层'], 2);
    assert.equal(r.chapters[0]?.excerpts.length, 2, '每次命中给一条片段');
    assert.equal(r.chapters[0]?.excerpts[0]?.line, 3, '片段要带行号');
    assert.equal(r.chapters.some((c) => c.chapterNo === 2), false, '没命中的章不该出现');
    assert.deepEqual(r.coverage, { extracted: 0, total: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★analyzeImpact：正文是**全文扫**的，所以「没命中」是真的没有这几个字', async () => {
  const root = await makeBook({ 1: '# 第1章\n\n雨下了一夜。\n' });
  try {
    const r = await analyzeImpact(root, ['不存在的词']);
    assert.deepEqual(r.chapters, []);
    assert.equal(r.coverage.extracted, 0, '抽取覆盖为 0，但正文扫描不受影响');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('analyzeImpact：带上事实库里的相关角色与台账里的相关伏笔', async () => {
  const root = await makeBook({ 1: '# 第1章\n\n林青站在院里。\n', 2: '# 第2章\n\n林青又来了。\n' });
  try {
    // ★每个文件用自己的内容指纹——给同一个指纹的话 readFacts 会因「与当前内容不符」
    // 把不符的那条清扫掉（那是 B-13 的既有语义），夹具就失真了
    const textOf: Record<string, string> = {
      'ch-01.md': '# 第1章\n\n林青站在院里。\n',
      'ch-02.md': '# 第2章\n\n林青又来了。\n',
    };
    const mk = (file: string): Record<string, ChapterFacts> => ({
      [file]: {
        extractedAt: '', contentHash: contentHash(textOf[file] as string), model: 'm',
        characters: [{
          name: '林青', voice: { catchphrases: [], speechStyle: '' },
          state: { realm: '炼气三层', location: '', knows: [], ignores: [], relations: [], alive: true },
          cause: '', evidence: '林青站在院里',
        }],
        foreshadows: [{ content: '炼气三层的瓶颈', level: 'core', plantedChapter: 1, paidOff: [], evidence: '林青站在院里' }],
        timeline: [], dropped: 0, malformed: [],
      },
    });
    const store: FactsStore = { schemaVersion: 1, bookRoot: path.resolve(root), chapters: { ...mk('ch-01.md'), ...mk('ch-02.md') } };
    await writeFile(path.join(root, 'state', 'facts.json'), JSON.stringify(store, null, 2), 'utf-8');
    await syncForeshadows(root);

    const r = await analyzeImpact(root, ['炼气三层', '林青']);
    assert.deepEqual(r.relatedCharacters, [{ name: '林青', chapters: [1, 2] }]);
    assert.equal(r.relatedForeshadows.length, 1);
    assert.equal(r.relatedForeshadows[0]?.id, 'f-001');
    assert.equal(r.relatedForeshadows[0]?.level, undefined, '台账条目这里只给 id/内容/状态/埋设章');
    assert.equal(r.relatedForeshadows[0]?.plantedChapter, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 顺序重写（需要假 LLM）─────────────────────────────────────────────────

async function withFakeLLM(
  handler: (chapterText: string, callIndex: number) => string | null,
  fn: (base: string, calls: () => number) => Promise<void>,
): Promise<void> {
  let calls = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const i = calls;
      calls += 1;
      const user = (JSON.parse(body) as { messages?: { role: string; content: string }[] })
        .messages?.find((m) => m.role === 'user')?.content ?? '';
      const content = handler(user, i);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: content ?? '不是 JSON' } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
    });
    resetLlmBreaker();
    await fn(`http://127.0.0.1:${port}`, () => calls);
  } finally {
    Object.assign(process.env, saved);
    resetLlmBreaker();
    srv.close();
  }
}

test('★rewriteInOrder：强制**升序 + 串行**（乱序输入会被排序）', async () => {
  // ★正文要接近真实长度：短文本上「改动量 ≤50%」守卫会先拦住，
  // 那样测的是守卫而不是顺序（本文件前几版就是这么被咬的）
  const filler = '雨点打在瓦上，一阵密一阵疏。\n';
  const root = await makeBook({
    1: '# 第1章\n\n' + filler.repeat(8) + '林青是炼气三层。\n',
    2: '# 第2章\n\n' + filler.repeat(8) + '林青还是炼气三层。\n',
    3: '# 第3章\n\n' + filler.repeat(8) + '林青仍是炼气三层。\n',
  });
  const seen: string[] = [];
  try {
    await withFakeLLM((user) => {
      seen.push(/第 (\d+) 章/.exec(user)?.[1] ?? '?');
      // ★取**最后一次**匹配：prompt 里「设定变更」那行也含「林青…炼气三层」，
      // 取第一次会拿到变更说明本身（那不在正文里）→ 引句定位不到 → 整条被跳过。
      // 这个坑正是「引句必须逐字命中正文」这条守卫抓出来的。
      const all = [...user.matchAll(/林青[^\n]*炼气三层[^\n]*/g)];
      const quote = all.at(-1)?.[0] ?? '';
      return JSON.stringify({ patches: [{ quote, replacement: '林青已是筑基初期。', reason: '设定变更' }] });
    }, async () => {
      const r = await rewriteInOrder({
        bookRoot: root,
        chapters: [3, 1, 2],   // 故意乱序
        instruction: '林青的境界从炼气三层改为筑基初期',
      });
      assert.deepEqual(r.order, [1, 2, 3], '★强制升序：后面的章要看到前面改完的结果');
      assert.deepEqual(seen, ['1', '2', '3'], '★串行执行，且顺序就是章号顺序');
      assert.equal(r.results.length, 3);
      assert.ok(r.results.every((x) => x.applied === 1), `每章应各改 1 处，实得 ${JSON.stringify(r.results)}`);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★rewriteInOrder：正文真的落盘，且 state 被刷新（下一章才读得到新内容）', async () => {
  const root = await makeBook({ 1: '# 第1章\n\n林青是炼气三层。\n' });
  try {
    await withFakeLLM(() => JSON.stringify({
      patches: [{ quote: '林青是炼气三层。', replacement: '林青已是筑基初期。', reason: '设定变更' }],
    }), async () => {
      await rewriteInOrder({ bookRoot: root, chapters: [1], instruction: '改成筑基初期' });
    });
    const text = await readFile(path.join(root, 'chapters', 'ch-01.md'), 'utf-8');
    assert.ok(text.includes('筑基初期'), '★补丁必须落盘（reviseByInstruction 只返回文本）');
    assert.ok(!text.includes('炼气三层'));
    const st = await readState({ bookRoot: root });
    assert.equal(st.chapters[0]?.contentHash, contentHash(text), '★state 要刷新，否则下一章读到的是旧正文');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★rewriteInOrder：中途失败 → **停下**并报改到哪一章，后面的章不改', async () => {
  const root = await makeBook({
    1: '# 第1章\n\n林青是炼气三层。\n',
    2: '# 第2章\n\n林青还是炼气三层。\n',
    3: '# 第3章\n\n林青仍是炼气三层。\n',
  });
  try {
    await withFakeLLM((_user, i) => {
      // 第 2 次调用（第 2 章）返回不可解析的内容 → reviseByInstruction 重试一次也失败
      if (i === 1 || i === 2) return null;
      const quote = '林青是炼气三层。';
      return JSON.stringify({ patches: [{ quote, replacement: '林青已是筑基初期。', reason: 'x' }] });
    }, async () => {
      const r = await rewriteInOrder({ bookRoot: root, chapters: [1, 2, 3], instruction: '改成筑基初期' });
      assert.equal(r.results.length, 1, '第 1 章成功后就停了');
      assert.equal(r.stoppedAt?.chapterNo, 2);
      assert.match(r.stoppedAt?.reason ?? '', /parse/);
    });
    // 第 3 章**没被改**
    const t3 = await readFile(path.join(root, 'chapters', 'ch-03.md'), 'utf-8');
    assert.ok(t3.includes('炼气三层'), '★中途失败后不许继续往下改——基于半成品只会更乱');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rewriteInOrder：模型认为不受影响（0 补丁）要标出来，供人工看一眼', async () => {
  const root = await makeBook({ 1: '# 第1章\n\n雨下了一夜。\n' });
  try {
    await withFakeLLM(() => JSON.stringify({ patches: [] }), async () => {
      const r = await rewriteInOrder({ bookRoot: root, chapters: [1], instruction: '改成筑基初期' });
      assert.equal(r.results[0]?.applied, 0);
      assert.equal(r.results[0]?.noPatches, true, '「没补丁」可能是真不受影响，也可能是没看出来——要标出来');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
