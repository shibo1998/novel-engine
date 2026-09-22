import type { PromptBundle, LLMOptions, LLMResponse } from './types.js';
export declare function callLLM(prompt: PromptBundle, options?: LLMOptions): Promise<LLMResponse>;
