import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { LlmPurpose } from './llm.js';

/**
 * LLM 配置文件（应用户要求：不想每次都 export 环境变量）。
 *
 * 文件位置：`~/.novel-engine/config.json`（可用 `NOVEL_CONFIG_FILE` 覆盖，测试用）。
 * 格式：
 * ```json
 * {
 *   "baseUrl": "https://your-endpoint/v1",
 *   "apiKey": "sk-...",
 *   "model": "your-model",
 *   "models": { "draft": "...", "judge": "..." }
 * }
 * ```
 *
 * ★为什么放在**用户主目录**而不是仓库里：
 * API key 写进仓库目录就有被 `git add -A` 带进版本控制的风险——
 * 一旦提交，撤销要重写历史。主目录不在任何仓库里，从根上消掉这个可能。
 * 这也是 `.npmrc` / `.netrc` 的做法。
 *
 * ★**优先级：环境变量 > 配置文件**。
 * 不是「配置文件优先」——CI/测试里用 env 覆盖是既有用法（本仓 273 项测试都靠它），
 * 反过来会让测试变成「要看磁盘上碰巧有什么文件」，不确定性正是测试要消灭的。
 *
 * ★**工具绝不替你写这个文件**（没有 `config set` 这类命令）：
 * 写密钥到磁盘的动作必须由作者自己做，工具不做就无所谓「它是不是悄悄写了一份」。
 */

export interface LlmFileConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 按用途覆盖（B-50）。键与 `NOVEL_MODEL_*` 的后缀一致 */
  models?: Partial<Record<LlmPurpose, string>>;
}

/** 配置文件路径。`NOVEL_CONFIG_FILE` 供测试与多账号场景覆盖 */
export function llmConfigFile(): string {
  const override = process.env['NOVEL_CONFIG_FILE'];
  if (override !== undefined && override.trim() !== '') return path.resolve(override);
  return path.join(homedir(), '.novel-engine', 'config.json');
}

let cache: { config: LlmFileConfig | null; missing: boolean } | null = null;
let warned = false;

/** 重新读盘（测试用）。生产代码不需要——配置文件不是运行时会变的东西 */
export function reloadLlmConfig(): void {
  cache = null;
}

function readConfig(): LlmFileConfig | null {
  if (cache !== null) return cache.config;
  const file = llmConfigFile();
  cache = { config: null, missing: true };
  // 同步读：调用方（modelFor / callLLM）是同步签名，改成 async 会传染整个调用链。
  // 配置文件只在进程启动后第一次用到时读一次，阻塞一次几毫秒可接受。
  try {
    // ★必须用真正的 import：这里曾用 `require('node:fs')`，在 ESM/tsx 下不存在，
    // 抛的 TypeError 没有 code → 落进下面的 else 分支 → **每次读都静默失败**，
    // 表现是「配置文件写了却完全没生效」，且没有任何报错。测试当场抓到。
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as LlmFileConfig;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      process.stderr.write(`⚠️ LLM 配置文件不是 JSON 对象，已忽略：${file}\n`);
    } else {
      cache = { config: parsed, missing: false };
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // 没有配置文件是完全正常的（用环境变量的用户）——不提示
    } else if (code === 'EACCES' || code === 'EPERM') {
      process.stderr.write(`⚠️ LLM 配置文件读不了（权限）：${file}\n`);
    } else {
      // ★JSON 坏了要**明说**，不能静默当「没配置」——那会让作者以为配置生效了
      process.stderr.write(
        `⚠️ LLM 配置文件解析失败，已忽略：${file}\n  ${(e instanceof Error ? e.message : String(e))}\n`
          + '  修正它，或删掉它改用环境变量。\n',
      );
    }
  }
  return cache.config;
}

/**
 * 安全提示：配置文件若落在某个 git 仓库内，第一次读到时警告一次。
 * 里面是 API key——被 `git add -A` 带进版本控制就是泄漏。
 */
function warnIfInsideRepo(file: string): void {
  if (warned) return;
  warned = true;
  try {
    let dir = path.dirname(file);
    for (let i = 0; i < 12 && dir !== path.dirname(dir); i++) {
      if (existsSync(path.join(dir, '.git'))) {
        process.stderr.write(
          `⚠️ LLM 配置文件在 git 仓库内（${dir}）：${file}\n`
            + '  里面有 API key，被提交就是泄漏。建议移到 ~/.novel-engine/config.json。\n',
        );
        return;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // 检查失败不影响主流程
  }
}

/** 读配置文件里的某个字段（不存在/为空 → undefined） */
function fileField(name: 'baseUrl' | 'apiKey' | 'model'): string | undefined {
  const cfg = readConfig();
  if (cfg === null) return undefined;
  if (!warned) warnIfInsideRepo(llmConfigFile());
  const v = cfg[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * 统一的 LLM 设置解析入口。**环境变量优先，其次配置文件**。
 *
 * ★本仓所有读 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 的地方都必须走这里，
 * 不许再直接 `process.env[...]`——散开读的话，「配置文件」只在部分入口生效，
 * 那种「命令行能用、Web 不能用」的故障最耗时间。
 */
export function resolveLlmSetting(name: 'LLM_BASE_URL' | 'LLM_API_KEY' | 'LLM_MODEL'): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return fileField(name === 'LLM_BASE_URL' ? 'baseUrl' : (name === 'LLM_API_KEY' ? 'apiKey' : 'model'));
}

/** 按用途解析模型名（环境变量 → 配置文件 → 兜底 `LLM_MODEL`） */
export function resolveModelFor(purpose: LlmPurpose, explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return explicit;
  const byPurposeEnv = process.env[`NOVEL_MODEL_${purpose.toUpperCase()}`];
  if (byPurposeEnv !== undefined && byPurposeEnv !== '') return byPurposeEnv;
  const cfg = readConfig();
  if (cfg !== null && cfg.models !== undefined) {
    const v = cfg.models[purpose];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return resolveLlmSetting('LLM_MODEL') ?? '';
}

/** 从配置文件读一个正数（不存在/非法 → undefined）。供 `timeoutMs` 这类数值项用 */
export function configNumber(key: string): number | undefined {
  const cfg = readConfig();
  if (cfg === null) return undefined;
  const v = (cfg as unknown as Record<string, unknown>)[key];
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
