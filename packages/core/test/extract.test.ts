import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  characterStateUpTo,
  extractChapter,
  parseFacts,
  readFacts,
  readState,
  resetLlmBreaker,
  rollbackChapterFacts,
} from '../src/index.js';
import type { FactsStore } from '../src/index.js';

/**
 * B-20 Extractor：每章抽事实（人物状态 / 伏笔 / 时间线）。
 *
 * ★本文件最要紧的一条：**引句命不中正文的条目整条丢弃，不降级保留。**
 * 比 Judge 更严（那里是降 `unsure`）——Judge 的结论是给人看的意见，
 * 而这里抽出的事实会**喂给后续章节的 prompt**。一条编造的事实会像真的一样
 * 被引用、被传播，而且再也查不出源头。
 */
const CHAPTER = '林青推开门，山风灌进来。\n他左臂还缠着布，抬手时皱了皱眉。\n慕容雪在院里等他。\n';

async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-extract-'));
  await mkdir(path.join(root, '.soloent'), { recursive: true });
  await mkdir(path.join(root, 'chapters'), { recursive: true });
  await mkdir(path.join(root, 'state'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '抽取测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
  }), 'utf-8');
  await writeFile(path.join(root, 'chapters', 'ch-01.md'), CHAPTER, 'utf-8');
  return root;
}

const payload = (o: unknown): string => JSON.stringify(o);

// ── 纯函数：引句核对（可脱离模型测）────────────────────────────────────────

test('★parseFacts：引句命中的保留，命不中的**整条丢弃**并如实计数', () => {
  const r = parseFacts(payload({
    characters: [
      { name: '林青', state: { realm: '炼气三层', location: '山门', alive: true }, cause: '带伤归来', evidence: '他左臂还缠着布' },
      { name: '编造的人', state: {}, cause: 'x', evidence: '这句话根本不在正文里' },
    ],
    foreshadows: [{ content: '左臂的伤', level: 'minor', plantedChapter: 1, paidOff: [], evidence: '他左臂还缠着布' }],
    timeline: [{ storyTime: '第三日', event: '林青回山门', participants: ['林青'], irreversible: false, evidence: '林青推开门' }],
  }), CHAPTER, 1);

  assert.equal(r.characters.length, 1, '★编造引句的整条丢掉，不是降级保留');
  assert.equal(r.characters[0]?.name, '林青');
  assert.equal(r.foreshadows.length, 1);
  assert.equal(r.timeline.length, 1);
  assert.equal(r.dropped, 1);
  assert.match(r.malformed[0] ?? '', /引句未命中正文/, '丢的东西必须可见，否则「抽少了」会被当成「正文里没有」');
});

test('parseFacts：缺 name/content/event 的条目同样丢弃', () => {
  const r = parseFacts(payload({
    characters: [{ state: {}, cause: '', evidence: '林青推开门' }],
    foreshadows: [{ level: 'minor', evidence: '林青推开门' }],
    timeline: [{ storyTime: 'x', evidence: '林青推开门' }],
  }), CHAPTER, 1);
  assert.equal(r.characters.length + r.foreshadows.length + r.timeline.length, 0);
  assert.equal(r.dropped, 3);
});

test('★parseFacts：alive 缺省 true——「没写死」不等于「死了」', () => {
  const r = parseFacts(payload({
    characters: [{ name: '林青', state: { location: '山门' }, cause: '', evidence: '林青推开门' }],
  }), CHAPTER, 1);
  assert.equal(r.characters[0]?.state.alive, true,
    '默认 false 会让每个没提到的角色都被判死——那会污染后续所有章节的 prompt');
});

test('parseFacts：level 非法值回退 minor；relations 过滤掉缺 to 的项', () => {
  const r = parseFacts(payload({
    characters: [{
      name: '林青', cause: '', evidence: '林青推开门',
      state: { relations: [{ to: '慕容雪', kind: '同门' }, { kind: '缺 to' }] },
    }],
    foreshadows: [{ content: 'x', level: '超大的', evidence: '林青推开门' }],
  }), CHAPTER, 1);
  assert.equal(r.characters[0]?.state.relations.length, 1);
  assert.equal(r.foreshadows[0]?.level, 'minor');
});

test('parseFacts：整体不是 JSON → 0 条 + 记录原因（不是静默空）', () => {
  const r = parseFacts('我觉得这章写得还行。', CHAPTER, 1);
  assert.equal(r.characters.length, 0);
  assert.equal(r.malformed.length, 1);
});

// ── 落盘：按章覆盖 + 指纹绑定 + 撤回 ──────────────────────────────────────

async function seedFacts(root: string, file: string, facts: Partial<FactsStore['chapters'][string]>): Promise<void> {
  const state = await readState({ bookRoot: root });
  const entry = state.chapters.find((c) => c.file === file);
  const text = await readFile(path.join(root, 'chapters', file), 'utf-8');
  const { contentHash } = await import('../src/index.js');
  const store: FactsStore = {
    schemaVersion: 1,
    bookRoot: path.resolve(root),
    chapters: {
      [file]: {
        extractedAt: new Date().toISOString(),
        contentHash: contentHash(text),
        model: 'm',
        characters: [], foreshadows: [], timeline: [], dropped: 0, malformed: [],
        ...facts,
      },
    },
  };
  assert.notEqual(entry, undefined);
  await writeFile(path.join(root, 'state', 'facts.json'), JSON.stringify(store, null, 2), 'utf-8');
}

test('★readFacts：正文改了 → 该章事实作废（过期的记忆会以「事实」的口吻说旧话）', async () => {
  const root = await makeBook();
  try {
    await seedFacts(root, 'ch-01.md', {
      characters: [{ name: '林青', state: { realm: '炼气', location: '', knows: [], ignores: [], relations: [], alive: true }, cause: '', evidence: '林青推开门' }],
    });
    assert.equal(Object.keys((await readFacts(root)).chapters).length, 1, '内容没变 → 保留');

    await writeFile(path.join(root, 'chapters', 'ch-01.md'), CHAPTER + '\n他改了主意。\n', 'utf-8');
    assert.equal(Object.keys((await readFacts(root)).chapters).length, 0, '★内容变了，记忆必须作废');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★rollbackChapterFacts：撤回该章贡献并回传被撤回的那条（供人工核对）', async () => {
  const root = await makeBook();
  try {
    await seedFacts(root, 'ch-01.md', { dropped: 3 });
    const prev = await rollbackChapterFacts(root, 1);
    assert.equal(prev?.dropped, 3, '撤回要回传原记录，不能只回一句「好了」');
    assert.equal(Object.keys((await readFacts(root)).chapters).length, 0);
    assert.equal(await rollbackChapterFacts(root, 1), null, '再撤回一次 → null，不抛错');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('characterStateUpTo：取「截至第 N 章」的**最新**快照', async () => {
  const root = await makeBook();
  try {
    const { contentHash } = await import('../src/index.js');
    const state = await readState({ bookRoot: root });
    const mk = (file: string, no: number, realm: string) => ({
      [file]: {
        extractedAt: '', contentHash: contentHash(CHAPTER), model: 'm',
        characters: [{ name: '林青', state: { realm, location: '', knows: [], ignores: [], relations: [], alive: true }, cause: `第${no}章`, evidence: '林青推开门' }],
        foreshadows: [], timeline: [], dropped: 0, malformed: [],
      },
    });
    await writeFile(path.join(root, 'chapters', 'ch-02.md'), CHAPTER, 'utf-8');
    await writeFile(path.join(root, 'chapters', 'ch-03.md'), CHAPTER, 'utf-8');
    const store: FactsStore = {
      schemaVersion: 1, bookRoot: path.resolve(root),
      chapters: { ...mk('ch-01.md', 1, '炼气一层'), ...mk('ch-02.md', 2, '炼气三层'), ...mk('ch-03.md', 3, '筑基') },
    };
    const order = state.chapters.map((c) => ({ file: c.file, chapterNo: c.chapterNo }));
    order.push({ file: 'ch-02.md', chapterNo: 2 }, { file: 'ch-03.md', chapterNo: 3 });

    assert.equal(characterStateUpTo(store, 1, order).get('林青')?.state.realm, '炼气一层');
    assert.equal(characterStateUpTo(store, 2, order).get('林青')?.state.realm, '炼气三层');
    assert.equal(characterStateUpTo(store, 3, order).get('林青')?.state.realm, '筑基');
    assert.equal(characterStateUpTo(store, 2, order).get('林青')?.atChapter, 2, '要报出这个状态是「截至第几章」的');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 全链路（靠 B-26 回放）───────────────────────────────────────────────

test('★extractChapter 全链路可确定性复现（录一遍→回放一遍，零网络请求）', async () => {
  const root = await makeBook();
  const recDir = await mkdtemp(path.join(tmpdir(), 'novel-extractrec-'));
  let requests = 0;
  const RESP = payload({
    characters: [{ name: '林青', state: { realm: '炼气三层', location: '山门', alive: true }, cause: '带伤归来', evidence: '他左臂还缠着布' }],
    foreshadows: [],
    timeline: [{ storyTime: '当日', event: '林青回山门', participants: ['林青'], irreversible: false, evidence: '林青推开门' }],
  });
  const srv = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: RESP } }] }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  const saved = { ...process.env };
  const restore = (): void => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    resetLlmBreaker();
  };
  try {
    Object.assign(process.env, {
      LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm',
      NOVEL_LLM_RETRY_ATTEMPTS: '0', NOVEL_LLM_RECORD_DIR: recDir,
    });
    delete process.env['NOVEL_LLM_REPLAY_DIR'];
    resetLlmBreaker();
    const live = await extractChapter({ bookRoot: root, chapterNo: 1 });
    assert.equal(live.ok, true, `首次抽取应成功：${JSON.stringify(live)}`);
    assert.equal(requests, 1);
    if (live.ok) {
      assert.equal(live.facts.characters.length, 1);
      assert.equal(live.facts.timeline.length, 1);
      assert.equal(live.facts.dropped, 0);
      assert.equal(live.facts.contentHash.length, 16, '要记内容指纹——正文改了记忆就该失效');
    }
    // 已落盘
    assert.equal(Object.keys((await readFacts(root)).chapters).length, 1);

    // 回放
    Object.assign(process.env, { NOVEL_LLM_RECORD_DIR: undefined, NOVEL_LLM_REPLAY_DIR: recDir });
    delete process.env['NOVEL_LLM_RECORD_DIR'];
    delete process.env['LLM_BASE_URL'];
    delete process.env['LLM_API_KEY'];
    resetLlmBreaker();
    await rollbackChapterFacts(root, 1);
    const replay = await extractChapter({ bookRoot: root, chapterNo: 1 });
    assert.equal(replay.ok, true, '回放应成功');
    assert.equal(requests, 1, '★回放不该产生任何网络请求');
    assert.equal(Object.keys((await readFacts(root)).chapters).length, 1);
  } finally {
    restore();
    srv.close();
    await rm(recDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

// ── B-49 人物口吻 / B-50 按用途选模型 ──────────────────────────────────────

test('★B-49：parseFacts 抽口吻；没抽到就空着（**不许编**）', () => {
  const r = parseFacts(payload({
    characters: [
      { name: '林青', voice: { catchphrases: ['少废话'], speechStyle: '短句、少修饰' }, state: {}, cause: '', evidence: '林青推开门' },
      { name: '慕容雪', state: {}, cause: '', evidence: '慕容雪在院里等他' },
    ],
  }), CHAPTER, 1);
  assert.deepEqual(r.characters[0]?.voice, { catchphrases: ['少废话'], speechStyle: '短句、少修饰' });
  assert.deepEqual(r.characters[1]?.voice, { catchphrases: [], speechStyle: '' },
    '★抽不到就留空——编出来的口吻会让后续章节模仿一个不存在的腔调');
});

test('★B-49：人物口吻会进 J3 的参考材料（口吻漂移的唯一判据来源）', async () => {
  const root = await makeBook();
  let userPrompt = '';
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        userPrompt = (JSON.parse(body) as { messages?: { role: string; content: string }[] })
          .messages?.find((m) => m.role === 'user')?.content ?? '';
      } catch { /* 断言用，解析失败不影响被测逻辑 */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [] }) } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  const saved = { ...process.env };
  try {
    // 夹具自检：judgeChapter 在「未声明判据」时会抛 JudgesNotDeclared，
    // 那样 prompt 压根发不出去，断言会以「userPrompt 是空串」的形式失败——
    // 看起来像「口吻没进 prompt」，其实是「根本没跑」。先把判据声明好。
    const { scaffoldJudges } = await import('../src/index.js');
    const cfgPath = path.join(root, '.soloent', 'book.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf-8')) as Record<string, unknown>;
    cfg['judges'] = { enabled: ['j3-continuity'] };
    await writeFile(cfgPath, JSON.stringify(cfg), 'utf-8');
    await scaffoldJudges(root);

    // 先塞一份带口吻的事实（模拟已抽过）
    const { contentHash } = await import('../src/index.js');
    await writeFile(path.join(root, 'state', 'facts.json'), JSON.stringify({
      schemaVersion: 1, bookRoot: path.resolve(root),
      chapters: {
        'ch-01.md': {
          extractedAt: '', contentHash: contentHash(CHAPTER), model: 'm',
          characters: [{
            name: '林青', voice: { catchphrases: ['少废话'], speechStyle: '短句、少修饰' },
            state: { realm: '', location: '', knows: [], ignores: [], relations: [], alive: true },
            cause: '', evidence: '林青推开门',
          }],
          foreshadows: [], timeline: [], dropped: 0, malformed: [],
        },
      },
    }, null, 2), 'utf-8');

    Object.assign(process.env, {
      LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
    });
    delete process.env['NOVEL_LLM_REPLAY_DIR'];
    resetLlmBreaker();
    const { judgeChapter } = await import('../src/index.js');
    await judgeChapter({ bookRoot: root, chapterNo: 1 });

    assert.notEqual(userPrompt, '', '夹具自检：prompt 真的发出去了');
    assert.match(userPrompt, /# 人物口吻/, 'J3 要能看到人物口吻，否则「像不像自己」无从判起');
    assert.match(userPrompt, /林青：短句、少修饰｜口头禅：少废话/);
  } finally {
    Object.assign(process.env, saved);
    resetLlmBreaker();
    srv.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('★B-49：没抽过口吻时，J3 的参考材料里明写「缺」而不是静默留空', async () => {
  const root = await makeBook();
  let userPrompt = '';
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        userPrompt = (JSON.parse(body) as { messages?: { role: string; content: string }[] })
          .messages?.find((m) => m.role === 'user')?.content ?? '';
      } catch { /* 断言用 */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"results":[]}' } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const saved = { ...process.env };
  try {
    const { scaffoldJudges } = await import('../src/index.js');
    const cfgPath = path.join(root, '.soloent', 'book.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf-8')) as Record<string, unknown>;
    cfg['judges'] = { enabled: ['j3-continuity'] };
    await writeFile(cfgPath, JSON.stringify(cfg), 'utf-8');
    await scaffoldJudges(root);

    Object.assign(process.env, {
      LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm', NOVEL_LLM_RETRY_ATTEMPTS: '0',
    });
    resetLlmBreaker();
    const { judgeChapter } = await import('../src/index.js');
    await judgeChapter({ bookRoot: root, chapterNo: 1 });
    assert.notEqual(userPrompt, '', '夹具自检：prompt 真的发出去了');
    assert.match(userPrompt, /（缺：还没抽过人物口吻/, '「没抽过」与「抽过但没口吻」必须形状不同');
  } finally {
    Object.assign(process.env, saved);
    resetLlmBreaker();
    srv.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('★B-50：modelFor 按用途取 env，显式覆盖优先，缺省回退 LLM_MODEL', async () => {
  const { modelFor } = await import('../src/index.js');
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      LLM_MODEL: 'big', NOVEL_MODEL_JUDGE: 'small-judge', NOVEL_MODEL_SUMMARY: 'small-sum',
    });
    assert.equal(modelFor('judge'), 'small-judge');
    assert.equal(modelFor('summary'), 'small-sum');
    assert.equal(modelFor('draft'), 'big', '★起草没配专属 env → 回退大模型（不顺手降级）');
    assert.equal(modelFor('revise'), 'big', '★修订与起草一样：定稿质量取决于它们');
    assert.equal(modelFor('judge', 'explicit'), 'explicit', '显式覆盖优先');
    delete process.env['NOVEL_MODEL_JUDGE'];
    assert.equal(modelFor('judge'), 'big', '专属 env 没配 → 回退 LLM_MODEL');
    delete process.env['LLM_MODEL'];
    assert.equal(modelFor('judge'), '', '都没有 → 空串，由 callLLM 报「环境变量缺失」');
  } finally {
    Object.assign(process.env, saved);
  }
});
