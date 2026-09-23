import type { LLMError, LLMResult, PromptBundle } from './types.js';

export interface CallLLMOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;                          // 外部取消，与内部超时合并
}

const TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 1_000;

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
  // 内部重试一次：仅 5xx / 网络错误（timeout kind 同时涵盖超时与连接失败），退避 1s；4xx 不重试
  if (!result.ok && isRetryable(result)) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    result = await attempt();
  }
  return result;
}
