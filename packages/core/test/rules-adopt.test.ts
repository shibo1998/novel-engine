import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RuleAdoptError,
  adoptRuleCandidate,
  listRuleCandidates,
  loadFeedback,
} from '../src/index.js';

/**
 * B-28：`rules adopt`——把改稿候选采纳进生效规则。
 *
 * 此前 `recordFeedback` 一直在产出候选，但**没有采纳路径**：那条链路是断的，
 * 作者要手工复制文件、手工改 book.json、手工记账，三步必然只做前两步。
 *
 * ★核心守卫：候选是**行级 diff 报告**（「原文 / 改后」），不是规则条文。
 * 原样采纳 = 每章往 prompt 里塞一份 diff：prompt 变长、内容却不是规则，
 * 而且没有任何红灯。所以未改写的候选一律拒绝。
 */
const RAW_CANDIDATE = [
  '# 规则候选 · 2026-09-25 · 第 5 章（ch-05.md）',
  '',
  '> 本文件由 recordFeedback 机械生成：人工改稿与原稿的行级 diff 聚合。',
  '> **候选不生效**；人工审阅后把条目提炼进 author 组规则文件，并在 book.json 的 rules.author 声明。',
  '',
  '## 候选 1（原章第 12 行起）',
  '',
  '**原文**',
  '',
  '> 他知道事情没那么简单。',
  '',
  '**改后**',
  '',
  '> 他盯着门缝里那点光。',
  '',
].join('\n');

const REWRITTEN = [
  '# 本书补充规则',
  '',
  '## 1 叙述',
  '不用「他知道」这类裁判腔；用行为或环境暴露想法。',
  '',
].join('\n');

async function makeBook(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'novel-adopt-'));
  await mkdir(path.join(root, '.soloent', 'rules', '_candidates'), { recursive: true });
  await writeFile(path.join(root, '.soloent', 'book.json'), JSON.stringify({
    _schema: 1,
    book: { title: '采纳测试书' },
    paths: { chapters: 'chapters', canon: '.soloent/canon.md', ledger: '.soloent/ledger.tsv', now: '.soloent/now.md' },
    chapter: { file_regex: '^ch-(\\d+)\\.md$' },
    ledger: { columns: ['章'], chapter_column: '章' },
    rules: { author: [], plugin: [] },
  }), 'utf-8');
  return root;
}

const candPath = (root: string, id: string): string =>
  path.join(root, '.soloent', 'rules', '_candidates', `${id}.md`);

test('listRuleCandidates：认出日期/章号/条数，并标出「是否已改写为规则」', async () => {
  const root = await makeBook();
  try {
    await writeFile(candPath(root, '2026-09-25-ch-05'), RAW_CANDIDATE, 'utf-8');
    await writeFile(candPath(root, '2026-09-24-ch-03'), REWRITTEN, 'utf-8');
    const list = await listRuleCandidates(root);
    assert.equal(list.length, 2);
    const [first, second] = list;
    assert.equal(first?.id, '2026-09-24-ch-03', '按文件名排序 = 按时间');
    assert.equal(first?.rawDiff, false, '已改写的候选不该被标成机械 diff');
    assert.equal(second?.id, '2026-09-25-ch-05');
    assert.equal(second?.date, '2026-09-25');
    assert.equal(second?.chapterNo, 5);
    assert.equal(second?.count, 1);
    assert.equal(second?.rawDiff, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★拒绝采纳未改写的机械 diff——并说清该怎么改', async () => {
  const root = await makeBook();
  try {
    await writeFile(candPath(root, '2026-09-25-ch-05'), RAW_CANDIDATE, 'utf-8');
    await assert.rejects(
      () => adoptRuleCandidate({ bookRoot: root, id: '2026-09-25-ch-05' }),
      (e: unknown) => {
        assert.ok(e instanceof RuleAdoptError);
        assert.match(e.message, /仍是 recordFeedback 机械生成的行级 diff/);
        assert.match(e.message, /提炼成一句规则/, '要给出可执行的下一步，不能只说「不行」');
        assert.match(e.message, /--force/, '要说明确实想强采时的出路');
        return true;
      },
    );
    // 拒绝时**不得**动任何文件
    assert.notEqual(await stat(candPath(root, '2026-09-25-ch-05')).catch(() => null), null, '候选应原样留着');
    assert.equal(await stat(path.join(root, '.soloent', 'rules', '2026-09-25-ch-05.md')).catch(() => null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★采纳已改写的候选：移到 rules/ → 声明进 book.json → feedback.jsonl 记账', async () => {
  const root = await makeBook();
  try {
    await writeFile(candPath(root, '2026-09-25-ch-05'), REWRITTEN, 'utf-8');
    const r = await adoptRuleCandidate({ bookRoot: root, id: '2026-09-25-ch-05' });

    assert.equal(r.to, 'rules/2026-09-25-ch-05.md');
    assert.equal(r.group, 'author');
    assert.equal(r.forced, false);

    // ① 文件已移走，不再是候选
    assert.equal(await stat(candPath(root, '2026-09-25-ch-05')).catch(() => null), null, '候选应已移走');
    const moved = await readFile(path.join(root, '.soloent', 'rules', '2026-09-25-ch-05.md'), 'utf-8');
    assert.equal(moved, REWRITTEN, '内容原样');

    // ② book.json 已声明——**不声明等于没生效**（rules 不扫目录）
    const cfg = JSON.parse(await readFile(path.join(root, '.soloent', 'book.json'), 'utf-8')) as {
      rules: { author: string[]; plugin: string[] };
    };
    assert.deepEqual(cfg.rules.author, ['rules/2026-09-25-ch-05.md']);
    assert.deepEqual(cfg.rules.plugin, [], '别动另一组');

    // ③ 记账
    const lines = (await readFile(path.join(root, '.soloent', 'feedback.jsonl'), 'utf-8')).trim().split('\n');
    const rec = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(rec['kind'], 'adopt');
    assert.equal(rec['candidate'], '2026-09-25-ch-05');
    assert.equal(rec['to'], 'rules/2026-09-25-ch-05.md');
    assert.equal(rec['group'], 'author');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★采纳记录混在 feedback.jsonl 里，loadFeedback 必须按形状跳过它（不许把历史读坏）', async () => {
  const root = await makeBook();
  try {
    await writeFile(candPath(root, '2026-09-25-ch-05'), REWRITTEN, 'utf-8');
    await adoptRuleCandidate({ bookRoot: root, id: '2026-09-25-ch-05' });
    // 再追加一条真正的改稿记录，顺序上「采纳记录在前」
    await writeFile(path.join(root, '.soloent', 'feedback.jsonl'),
      (await readFile(path.join(root, '.soloent', 'feedback.jsonl'), 'utf-8'))
        + JSON.stringify({
          at: '2026-09-25T00:00:00.000Z', chapterNo: 5, file: 'ch-05.md', category: '裁判腔',
          findingCount: 1, original: '原文', revised: '改后',
        }) + '\n', 'utf-8');

    const fb = await loadFeedback(root);
    assert.equal(fb.length, 1, '只该返回改稿记录——采纳记录没有 original/revised，按形状过滤掉');
    assert.equal(fb[0]?.chapterNo, 5);
    assert.equal(fb[0]?.category, '裁判腔');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('★拒绝覆盖已有规则文件（规则是 prompt 的一部分，覆盖掉找不回来）', async () => {
  const root = await makeBook();
  try {
    await writeFile(candPath(root, '2026-09-25-ch-05'), REWRITTEN, 'utf-8');
    await writeFile(path.join(root, '.soloent', 'rules', '2026-09-25-ch-05.md'), '# 已有内容\n', 'utf-8');
    await assert.rejects(
      () => adoptRuleCandidate({ bookRoot: root, id: '2026-09-25-ch-05' }),
      (e: unknown) => e instanceof RuleAdoptError && /拒绝覆盖/.test(e.message),
    );
    const kept = await readFile(path.join(root, '.soloent', 'rules', '2026-09-25-ch-05.md'), 'utf-8');
    assert.equal(kept, '# 已有内容\n', '已有文件必须原样');
    assert.notEqual(await stat(candPath(root, '2026-09-25-ch-05')).catch(() => null), null, '候选也不该被动');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('候选不存在 → 报错并列出现有候选（不用自己去翻目录）', async () => {
  const root = await makeBook();
  try {
    await writeFile(candPath(root, '2026-09-25-ch-05'), RAW_CANDIDATE, 'utf-8');
    await assert.rejects(
      () => adoptRuleCandidate({ bookRoot: root, id: '不存在的候选' }),
      (e: unknown) => e instanceof RuleAdoptError && /现有候选/.test(e.message) && /2026-09-25-ch-05/.test(e.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--force：明知是机械 diff 也采纳，但如实记账 forced=true', async () => {
  const root = await makeBook();
  try {
    await writeFile(candPath(root, '2026-09-25-ch-05'), RAW_CANDIDATE, 'utf-8');
    const r = await adoptRuleCandidate({ bookRoot: root, id: '2026-09-25-ch-05', force: true, name: '临时规则.md' });
    assert.equal(r.forced, true, '强采必须留痕');
    assert.equal(r.to, 'rules/临时规则.md', '--name 可指定目标名');
    const rec = JSON.parse((await readFile(path.join(root, '.soloent', 'feedback.jsonl'), 'utf-8')).trim()) as Record<string, unknown>;
    assert.equal(rec['forced'], true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('采纳进 plugin 组：写的是 rules.plugin，不是 author', async () => {
  const root = await makeBook();
  try {
    await writeFile(candPath(root, '2026-09-25-ch-05'), REWRITTEN, 'utf-8');
    await adoptRuleCandidate({ bookRoot: root, id: '2026-09-25-ch-05', group: 'plugin' });
    const cfg = JSON.parse(await readFile(path.join(root, '.soloent', 'book.json'), 'utf-8')) as {
      rules: { author: string[]; plugin: string[] };
    };
    assert.deepEqual(cfg.rules.plugin, ['rules/2026-09-25-ch-05.md']);
    assert.deepEqual(cfg.rules.author, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
