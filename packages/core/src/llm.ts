import type { PromptBundle, LLMOptions, LLMResponse } from './types.js';

export async function callLLM(prompt: PromptBundle, options?: LLMOptions): Promise<LLMResponse> {
  throw new Error('callLLM 尚未实现：当前仅建立对外契约');
}
