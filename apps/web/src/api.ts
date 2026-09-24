export interface GateStatus {
  worst: string;
  count: number;
  checkedAt: string;
  checkedMtimeMs: number;
}

export interface ChapterEntry {
  chapterNo: number;
  file: string;
  title: string;
  wordCount: number;
  gateStatus: GateStatus | null;
}

export interface StoryState {
  schemaVersion: number;
  generatedAt: string;
  bookRoot: string;
  chapters: ChapterEntry[];
}

export interface GateFinding {
  severity: string;
  chapter: string;
  line: number;
  check: string;
  detail: string;
}

export interface GateReport {
  findings: GateFinding[];
  counts: Record<string, number>;
  state?: StoryState;
}

export interface ChapterReadiness {
  chapterNo: number;
  outlineFile: string;
  warnings: string[];
}

export interface GenerationReport extends GateReport {
  readiness: ChapterReadiness;
  generation: {
    file: string;
    drafted: boolean;
    finalWorst: string;
    stopped: string;
    rounds: Array<{ round: number; findings: number; worst: string; action: string }>;
  };
}

async function j<T>(r: Response): Promise<T> {
  const payload: unknown = await r.json();
  if (!r.ok) {
    const error = typeof payload === 'object' && payload !== null && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${r.status}`;
    throw new Error(error);
  }
  return payload as T;
}

export const fetchState = (bookRoot: string): Promise<StoryState> =>
  fetch(`/api/state?bookRoot=${encodeURIComponent(bookRoot)}`).then((r) => j<StoryState>(r));

export const fetchChapter = (bookRoot: string, file: string): Promise<{ file: string; text: string }> =>
  fetch(`/api/chapter?bookRoot=${encodeURIComponent(bookRoot)}&file=${encodeURIComponent(file)}`).then((r) =>
    j<{ file: string; text: string }>(r),
  );

export const postJson = <T>(path: string, body: unknown): Promise<T> =>
  fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => j<T>(r));

export const putJson = <T>(path: string, body: unknown): Promise<T> =>
  fetch(`/api${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => j<T>(r));
