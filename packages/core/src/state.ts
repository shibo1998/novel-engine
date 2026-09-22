import type { StoryState } from './types.js';

export async function readState(): Promise<StoryState> {
  throw new Error('readState 尚未实现：当前仅建立对外契约');
}

export async function writeState(state: StoryState): Promise<void> {
  throw new Error('writeState 尚未实现：当前仅建立对外契约');
}
