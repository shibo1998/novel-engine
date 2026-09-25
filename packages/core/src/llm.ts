import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contentHash } from './hash.js';
import type { LLMError, LLMResult, PromptBundle } from './types.js';
import { resolveLlmSetting, resolveModelFor } from './llmconfig.js';

export interface CallLLMOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;                          // 外部取消，与内部超时合并
  /** 覆盖模型。不给则用 `modelFor(purpose)` 的结果 */
  model?: string;
  /**
   * 用途（B-50）。决定「可配小模型」时读哪个 env：
   *   draft  → `NOVEL_MODEL_DRAFT`（缺省回退 LLM_MODEL）
   *   revise → `NOVEL_MODEL_REVISE`
   *   judge  → `NOVEL_MODEL_JUDGE`   （判据：判对错，可以小一点）
   *   summary→ `NOVEL_MODEL_SUMMARY` （摘要：压缩信息，小模型够）
   *   extract→ `NOVEL_MODEL_EXTRACT` （抽取：结构化输出，小模型够）
   *   plan   → `NOVEL_MODEL_PLAN`    （蓝图起草：影响全局，建议用大模型）
   * ★**起草与修订刻意不共用**：定稿质量主要取决于这两步，不该被「省 token」顺手降级。
   */
  purpose?: LlmPurpose;
}

export type LlmPurpose = 'draft' | 'revise' | 'judge' | 'summary' | 'extract' | 'plan';

/**
 * 按用途选模型（B-50）。**只在这里决定**——散在各调用点必然漂移。
 * 没配该用途的 env → 回退 `LLM_MODEL`；`LLM_MODEL` 也没有 → 空串（由 callLLM 报「环境变量缺失」）。
 */
export function modelFor(purpose: LlmPurpose, explicit?: string): string {
  return resolveModelFor(purpose, explicit);
}

const TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 1_000;

/**
 * 重试层数：**只有这一层**（F15）。
 * 上层 convergeChapter 的 3 轮是「改写轮」不是「重试轮」——它换 prompt、改正文，
 * 与「重试同一个请求」语义正交。会出问题的是两者相乘又不封顶，所以：
 *   总请求数上界 = 轮数 × (1 + RETRY_ATTEMPTS)，且下面那个熔断器会在 API 持续
 *   失败时直接掐掉后续尝试，不让「你还在点第 N 章生成」把请求数一路放大。
 * env 可设 0 关掉这一层（自测/离线场景）。
 */
function retryAttempts(): number {
  const raw = Number(process.env['NOVEL_LLM_RETRY_ATTEMPTS'] ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
}

function numEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * 熔断器（F15）。**模块级可变状态**，有意为之：本仓 core 是单进程使用
 * （CLI 一次性进程 / server 单实例），跨调用的计数才有意义。
 * 为什么必须跨调用：单看一次 convergeChapter 不会连续失败——LLM 一失败就 break 了。
 * 真正会「一遍遍撞同一堵墙」的是「API 挂了，人还在点下一章生成」，
 * 以及未来若有批量生成时的剩余章。计数只在**可重试类**失败上累加：
 * 4xx / config / parse 重试一百次结果也一样，把那些算进熔断，
 * 只会让「配置写错了」伪装成「服务不稳」。
 */
let consecutiveFailures = 0;
let openedUntil = 0;

export function llmBreakerState(): { consecutiveFailures: number; openedUntil: number } {
  return { consecutiveFailures, openedUntil };
}

export function resetLlmBreaker(): void {
  consecutiveFailures = 0;
  openedUntil = 0;
}

/**
 * 可重试分类（E 阶段收敛循环的判定依据，已定死）：
 * timeout / http-5xx 可重试；parse / config / http-4xx 不可
 * （config 是 env 配错，4xx 是请求本身错，重试一百次结果一样——放它们进循环就是烧 token 的死转）。
 */
export function isRetryable(err: LLMError): boolean {
  if (err.kind === 'timeout') return true;
  if (err.kind === 'http') return err.status >= 500;
  return false;
}

// ── 录像 / 回放（B-26，v0.2 M7.6）───────────────────────────────────────────
//
// 治的是什么：凡是「调模型的代码路径」都没法写确定性测试——要么每跑一次真烧钱，
// 要么只能测到「它没崩」。结果是 Judge / plan draft / 摘要 这些**判据型**逻辑
// 全都只有纯函数部分被测到，真正「模型说了什么、我们怎么处理」那一段无人看守。
//
// 两个环境变量，两个方向：
//   `NOVEL_LLM_RECORD_DIR=<dir>`  跑真调用，把每次请求/响应落到 `<dir>/<请求指纹>.json`
//   `NOVEL_LLM_REPLAY_DIR=<dir>`  不碰网络，按请求指纹取回放；**取不到就失败关闭**
//
// ★三条纪律：
//   1. **回放未命中 → 失败，绝不回退到真调模型。** 回退会让「夹具过期」伪装成
//      「测试通过但悄悄烧了钱」，也让离线环境里的失败原因变得不可理解。
//   2. **录像脱敏**：只存 model / system / user / 响应文本，**绝不写 Authorization**。
//      录像会进版本控制，密钥写进去就是泄漏。
//   3. **回放不需要 LLM_API_KEY**：它压根不发请求。否则「离线确定性测试」还得先配密钥，
//      那就不是离线的了。

/** 请求指纹：同一份 prompt + 同一个模型 → 同一个 hash。与 gateStatus 用的是同一套 contentHash */
function requestHash(model: string, b: PromptBundle): string {
  return contentHash(`${model}\n\u0000\n${b.system}\n\u0000\n${b.user}`);
}

interface LlmRecording {
  hash: string;
  at: string;
  model: string;
  /** 请求（脱敏：只有这三样，没有密钥、没有 header） */
  request: { system: string; user: string };
  response: { text: string };
}

async function replayOrNull(dir: string, hash: string): Promise<LLMResult | null> {
  const raw = await readFile(path.join(dir, `${hash}.json`), 'utf-8').catch(() => null);
  if (raw === null) return null;
  try {
    const rec = JSON.parse(raw) as LlmRecording;
    if (typeof rec.response?.text !== 'string' || rec.response.text === '') return null;
    return { ok: true, text: rec.response.text };
  } catch {
    return null;
  }
}

async function recordCall(dir: string, rec: LlmRecording): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${rec.hash}.json`), JSON.stringify(rec, null, 2) + '\n', 'utf-8');
}

/**
 * 手写薄 HTTP 封装（OpenAI 兼容端点），不用任何厂商 SDK——换厂商只改 env。
 * env：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL；API key 只走 env，绝不写入 book.json。
 * 全程不 throw 裸 Error，错误一律归一成 LLMResult union。
 */
export async function callLLM(b: PromptBundle, o: CallLLMOptions = {}): Promise<LLMResult> {
  // 模型按用途选（B-50）；显式 o.model 优先。hash 必须用**生效的**模型算，
  // 否则换模型后回放会命中旧夹具——那会让「换了模型」这件事在测试里完全看不出来。
  const model = modelFor(o.purpose ?? 'draft', o.model) || '(未知)';
  const hash = requestHash(model, b);

  // 回放先于一切（也先于熔断与 env 检查）：它不发请求，自然不该受熔断影响，
  // 也不该要求 LLM_API_KEY —— 否则「离线确定性测试」还得先配密钥，那就不是离线的了。
  const replayDir = process.env['NOVEL_LLM_REPLAY_DIR'];
  if (replayDir !== undefined && replayDir !== '') {
    const hit = await replayOrNull(replayDir, hash);
    if (hit !== null) return hit;
    // ★失败关闭：不回退到真调模型。回退会让「夹具过期」伪装成「测试通过但悄悄烧钱」。
    return {
      ok: false,
      kind: 'config',
      detail: `回放未命中：${path.join(replayDir, `${hash}.json`)} 不存在或不可用。\n`
        + `  请求指纹 ${hash}（model=${model}）。\n`
        + '  处置：用 NOVEL_LLM_RECORD_DIR 重新录一遍；**不会**回退到真调模型。',
    };
  }

  // 熔断先于一切：断路期间连 env 都不看，直接失败——熔断的全部意义就是「别再发请求」
  const now = Date.now();
  if (now < openedUntil) {
    return {
      ok: false,
      kind: 'circuit-open',
      detail: `熔断中：已连续 ${consecutiveFailures} 次可重试失败，`
        + `${Math.ceil((openedUntil - now) / 1000)}s 后恢复（任意一次成功即清零）`,
    };
  }

  const base = resolveLlmSetting('LLM_BASE_URL');
  const key = resolveLlmSetting('LLM_API_KEY');
  const missing = [
    ...(base === undefined || base === '' ? ['LLM_BASE_URL'] : []),
    ...(key === undefined || key === '' ? ['LLM_API_KEY'] : []),
    ...(model === undefined || model === '' ? ['LLM_MODEL'] : []),
  ];
  if (missing.length > 0) {
    // ★只说「缺失」不够——作者第一次用时会去翻仓库找配置文件，而本仓**没有配置文件**。
    // 报错里直接给出可执行的下一步（项目 MEMORY 里的既有纪律：错误要给下一步）。
    const lines = missing.map((k) => {
      const sample = k === 'LLM_BASE_URL'
        ? 'https://your-endpoint/v1'
        : (k === 'LLM_API_KEY' ? 'sk-...' : 'your-model');
      return `    export ${k}=${sample}`;
    });
    return {
      ok: false,
      kind: 'config',
      detail: `环境变量缺失: ${missing.join(', ')}\n`
        + '  模型配置有两种方式（**变量名没有 NOVEL_ 前缀**）：\n'
        + '  ① 环境变量：\n'
        + lines.join('\n') + '\n'
        + '  ② 配置文件 ~/.novel-engine/config.json（不想每次 export 就用它）：\n'
        + '    {"baseUrl":"https://your-endpoint/v1","apiKey":"sk-...","model":"your-model"}\n'
        + '  ★文件放在用户主目录（不在任何 git 仓库里），API key 不会被误提交；\n'
        + '    环境变量优先于文件。详见 README 的「配置」一节。',
    };
  }

  const attempt = async (): Promise<LLMResult> => {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
    const onExternalAbort = (): void => ctrl.abort();
    if (o.signal !== undefined) {
      if (o.signal.aborted) ctrl.abort();
      else o.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: b.system },
            { role: 'user', content: b.user },
          ],
          ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
          ...(o.maxTokens !== undefined ? { max_tokens: o.maxTokens } : {}),
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        return { ok: false, kind: 'http', status: res.status, detail: bodyText.slice(0, 200) };
      }
      let j: unknown;
      try {
        j = await res.json();
      } catch {
        return { ok: false, kind: 'parse', detail: '响应体不是合法 JSON' };
      }
      const content = (j as { choices?: { message?: { content?: unknown } }[] })
        .choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content === '') {
        return { ok: false, kind: 'parse', detail: 'choices[0].message.content 缺失或为空' };
      }
      // 录像（B-26）：只存 model / prompt / 响应文本，**绝不写 Authorization**
      const recordDir = process.env['NOVEL_LLM_RECORD_DIR'];
      if (recordDir !== undefined && recordDir !== '') {
        await recordCall(recordDir, {
          hash,
          at: new Date().toISOString(),
          model,
          request: { system: b.system, user: b.user },
          response: { text: content },
        }).catch(() => undefined);
      }
      return { ok: true, text: content };
    } catch (e) {
      // 主动取消 ≠ 超时：两者在 fetch 层都表现为 reject，但后续处理完全不同——
      // 取消不该重试、不该计入熔断、也不该被报成「服务慢」（F20-2）。
      if (!timedOut && o.signal?.aborted === true) {
        return { ok: false, kind: 'aborted', detail: '已被调用方取消' };
      }
      return { ok: false, kind: 'timeout', detail: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onExternalAbort);
    }
  };

  let result = await attempt();
  // 内部重试：仅 5xx / 网络错误（timeout kind 同时涵盖超时与连接失败），退避 1s；4xx 不重试
  for (let i = 0, attempts = retryAttempts(); i < attempts && !result.ok && isRetryable(result); i++) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    result = await attempt();
  }

  // 熔断记账（F15）
  if (result.ok) {
    consecutiveFailures = 0;
  } else if (isRetryable(result)) {
    consecutiveFailures += 1;
    const threshold = numEnv('NOVEL_LLM_BREAKER_THRESHOLD', 3);
    if (consecutiveFailures >= threshold && Date.now() >= openedUntil) {
      const cooldownMs = numEnv('NOVEL_LLM_BREAKER_COOLDOWN_MS', 60_000);
      openedUntil = Date.now() + cooldownMs;
      // 落 stderr：熔断是「行为定性改变」，必须能在日志里一眼看见，
      // 而不是只表现为「后面几次很快就失败了」
      process.stderr.write(
        `[llm] ⛔ 熔断：连续 ${consecutiveFailures} 次可重试失败`
          + `（最近一次：${result.kind === 'http' ? `http-${result.status}` : result.kind}`
          + `｜${result.detail.slice(0, 120)}），${Math.round(cooldownMs / 1000)}s 内不再发起请求\n`,
      );
    }
  }
  return result;
}
