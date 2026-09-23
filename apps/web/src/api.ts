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

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
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
