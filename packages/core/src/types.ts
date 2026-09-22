export interface StoryState {
  bookId: string;
  updatedAt: string;
  cursor: { volume: number; chapter: number };
  chapters: ChapterIndexEntry[];
}

export interface ChapterIndexEntry {
  chapter: number;
  title: string;
  path: string;
  wordCount: number;
  gateStatus: 'unknown' | 'passed' | 'failed';
}

export interface BuildPromptInput {
  stage: string;
  context: Record<string, unknown>;
  target?: string;
}

export interface PromptBundle {
  system: string;
  user: string;
  meta: { stage: string; target?: string };
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

export interface GateResult {
  gate: string;
  passed: boolean;
  severity: 'info' | 'warn' | 'error';
  messages: string[];
}

export interface FeedbackEntry {
  chapter: number;
  category: string;
  original: string;
  revised: string;
  note?: string;
}
