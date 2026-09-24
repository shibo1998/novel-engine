import type { LLMError, LLMResult, PromptBundle } from './types.js';

export interface CallLLMOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;                          // 外部取消，与内部超时合并
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

/**
 * 手写薄 HTTP 封装（OpenAI 兼容端点），不用任何厂商 SDK——换厂商只改 env。
 * env：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL；API key 只走 env，绝不写入 book.json。
 * 全程不 throw 裸 Error，错误一律归一成 LLMResult union。
 */
export async function callLLM(b: PromptBundle, o: CallLLMOptions = {}): Promise<LLMResult> {
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

  const base = process.env['LLM_BASE_URL'];
  const key = process.env['LLM_API_KEY'];
  const model = process.env['LLM_MODEL'];
  const missing = [
    ...(base === undefined || base === '' ? ['LLM_BASE_URL'] : []),
    ...(key === undefined || key === '' ? ['LLM_API_KEY'] : []),
    ...(model === undefined || model === '' ? ['LLM_MODEL'] : []),
  ];
  if (missing.length > 0) {
    return { ok: false, kind: 'config', detail: `环境变量缺失: ${missing.join(', ')}` };
  }

  const attempt = async (): Promise<LLMResult> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
      return { ok: true, text: content };
    } catch (e) {
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
