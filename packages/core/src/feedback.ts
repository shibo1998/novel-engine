import type { FeedbackEntry } from './types.js';

export async function recordFeedback(entry: FeedbackEntry): Promise<void> {
  throw new Error('recordFeedback 尚未实现：当前仅建立对外契约');
}
