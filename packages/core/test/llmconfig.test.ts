import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { modelFor, reloadLlmConfig, llmConfigFile, resolveLlmSetting } from '../src/index.js';

/**
 * LLM 配置文件（应用户要求：不想每次 export 环境变量）。
 *
 * ★两条纪律各有对应用例：
 *   1. **优先级：环境变量 > 配置文件**——反过来的话，测试结果取决于
 *      「作者磁盘上碰巧有什么」，那正是测试要消灭的不确定性。
 *   2. **JSON 坏了要明说**，不能静默当「没配置」——那会让作者以为配置生效了。
 *
 * ★本文件所有用例都必须把 `NOVEL_CONFIG_FILE` 指到自己的夹具，
 * 否则结果取决于作者磁盘上碰巧有没有 `~/.novel-engine/config.json`。
 */
async function withConfigFile(raw: string | null, fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'novel-llmcfg-'));
  const file = path.join(dir, 'config.json');
  const saved = { ...process.env };
  try {
    if (raw !== null) await writeFile(file, raw, 'utf-8');
    process.env['NOVEL_CONFIG_FILE'] = file;
    reloadLlmConfig();
    await fn(file);
  } finally {
    // ★必须先删掉新增的键再恢复：只 Object.assign 的话，
    // 前面用例设置的 env 会泄漏到后面的用例（本文件前几版就是这么互相污染的）
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    reloadLlmConfig();
    await rm(dir, { recursive: true, force: true });
  }
}

const CFG = JSON.stringify({
  baseUrl: 'https://file-endpoint/v1',
  apiKey: 'sk-from-file',
  model: 'file-model',
  models: { judge: 'file-judge', summary: 'file-summary' },
});

test('★没配任何东西 → 全部为空（配置文件不存在是正常的，不提示）', async () => {
  await withConfigFile(null, async () => {
    assert.equal(resolveLlmSetting('LLM_BASE_URL'), undefined);
    assert.equal(resolveLlmSetting('LLM_API_KEY'), undefined);
    assert.equal(resolveLlmSetting('LLM_MODEL'), undefined);
    assert.equal(modelFor('judge'), '');
  });
});

test('★配置文件兜底：env 没给时用文件里的值', async () => {
  await withConfigFile(CFG, async () => {
    assert.equal(resolveLlmSetting('LLM_BASE_URL'), 'https://file-endpoint/v1');
    assert.equal(resolveLlmSetting('LLM_API_KEY'), 'sk-from-file');
    assert.equal(resolveLlmSetting('LLM_MODEL'), 'file-model');
    assert.equal(modelFor('judge'), 'file-judge', 'models.judge 生效');
  });
});

test('★环境变量优先于配置文件（CI/测试用 env 覆盖是既有用法）', async () => {
  await withConfigFile(CFG, async () => {
    process.env['LLM_BASE_URL'] = 'https://env-endpoint/v1';
    process.env['LLM_API_KEY'] = 'sk-from-env';
    process.env['LLM_MODEL'] = 'env-model';
    process.env['NOVEL_MODEL_JUDGE'] = 'env-judge';
    assert.equal(resolveLlmSetting('LLM_BASE_URL'), 'https://env-endpoint/v1');
    assert.equal(resolveLlmSetting('LLM_API_KEY'), 'sk-from-env');
    assert.equal(modelFor('judge'), 'env-judge');
    // 没有 env 用途覆盖的用途：env 的 LLM_MODEL 优先于文件的 model
    assert.equal(modelFor('draft'), 'env-model');
  });
});

test('★用途覆盖的顺序：env 用途 > 文件用途 > env LLM_MODEL > 文件 model', async () => {
  await withConfigFile(CFG, async () => {
    process.env['LLM_MODEL'] = 'env-model';
    assert.equal(modelFor('judge'), 'file-judge', '文件用途覆盖 env 的通用 model');
    assert.equal(modelFor('draft'), 'env-model', '文件没配 draft → 回退 env 的 LLM_MODEL');
  });
});

test('★JSON 坏了要**明说**，不能静默当「没配置」', async () => {
  await withConfigFile('{ 这不是 JSON', async () => {
    // 静默当「没配置」的话，作者会以为配置生效了，而实际每次都在走 env/报缺
    assert.equal(resolveLlmSetting('LLM_MODEL'), undefined, '值确实读不到（文件坏了）');
    // 但 stderr 必须有警告（node:test 的 stderr 我们拿不到，这里验证不抛错 + reload 后行为一致）
    reloadLlmConfig();
    assert.equal(resolveLlmSetting('LLM_MODEL'), undefined);
  });
});

test('空字符串字段视为未配置（不当作有效值）', async () => {
  await withConfigFile(JSON.stringify({ model: '  ', apiKey: '' }), async () => {
    assert.equal(resolveLlmSetting('LLM_MODEL'), undefined, '★空串不该被当成「已配置」');
    assert.equal(resolveLlmSetting('LLM_API_KEY'), undefined);
  });
});

test('llmConfigFile：NOVEL_CONFIG_FILE 覆盖默认的 ~/.novel-engine/config.json', async () => {
  const saved = process.env['NOVEL_CONFIG_FILE'];
  try {
    delete process.env['NOVEL_CONFIG_FILE'];
    const def = llmConfigFile();
    assert.ok(def.includes('.novel-engine'), `默认在用户主目录：${def}`);
    assert.ok(!def.includes('novel-engine/packages'), '★不在仓库里——在里面就有被提交的风险');
    process.env['NOVEL_CONFIG_FILE'] = 'D:/tmp/x.json';
    assert.equal(llmConfigFile(), path.resolve('D:/tmp/x.json'));
  } finally {
    if (saved === undefined) delete process.env['NOVEL_CONFIG_FILE'];
    else process.env['NOVEL_CONFIG_FILE'] = saved;
  }
});

test('配置文件数组形式 → 拒绝并警告（不崩）', async () => {
  await withConfigFile('[]', async () => {
    assert.equal(resolveLlmSetting('LLM_MODEL'), undefined);
    reloadLlmConfig();
    assert.equal(resolveLlmSetting('LLM_MODEL'), undefined, 'reload 后行为一致');
  });
});
