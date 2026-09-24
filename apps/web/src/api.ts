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
  /**
   * 服务端 /cancel 的产物（F20-2）。带这个标记时**没有 findings 字段**——
   * 一次空的 findings 与「查完没问题」形状相同，前端必须先判 cancelled。
   */
  cancelled?: true;
  note?: string;
}

/** 服务端在跑的长任务（F20-1）：用来区分「我这儿在等」与「服务端确实还在跑」。 */
export interface InflightTask {
  bookRoot: string;
  label: string;
  startedAt: string;
  elapsedMs: number;
}

export interface CancelResult {
  cancelled: boolean;
  label?: string;
  note: string;
}

export interface ChapterReadiness {
  chapterNo: number;
  outlineFile: string;
  /** chapter=按章细纲文件；volume=从 book.json 的 paths.outline 声明的卷纲里取用 */
  outlineScope: 'chapter' | 'volume';
  /** true 表示卷纲里没定位到本章段，界面提示的是卷级背景而非本章细纲 */
  outlineChapterSectionMissing: boolean;
  warnings: string[];
}

export interface GenerationReport extends GateReport {
  readiness: ChapterReadiness;
  generation: {
    file: string;
    drafted: boolean;
    finalWorst: string;
    stopped: string;
    /** 本次实际发出的 LLM 请求数（F15）：把「轮数 × 重试层数」的乘积摊开给人看 */
    llmCalls: number;
    rounds: Array<{ round: number; findings: number; worst: string; action: string }>;
  };
}

const TOKEN_KEY = 'novel.token';

/**
 * 服务端启动时会把 token 打到日志里。这里只做本地保存 + 统一注入，
 * 不散在每个调用点——请求头漏一个就是一个 401。
 */
export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token === '') localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

export function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  return token === '' ? base : { ...base, Authorization: `Bearer ${token}` };
}

async function j<T>(r: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await r.json();
  } catch {
    // 解析失败（含半写窗口）不能渲染成空态——空态看起来像「数据丢了」，
    // 抛出去让 React Query 重拉，才是对瞬时窗口正确的反应。
    throw new Error(`HTTP ${r.status}：响应不是合法 JSON（可能是读到了半写文件，稍后重试）`);
  }
  if (!r.ok) {
    const error = typeof payload === 'object' && payload !== null && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${r.status}`;
    if (r.status === 401) throw new Error(`未授权：请在左上方填入服务端日志里的 token（${error}）`);
    throw new Error(error);
  }
  return payload as T;
}

export const fetchState = (bookRoot: string): Promise<StoryState> =>
  fetch(`/api/state?bookRoot=${encodeURIComponent(bookRoot)}`, { headers: authHeaders() }).then((r) =>
    j<StoryState>(r),
  );

export const fetchChapter = (bookRoot: string, file: string): Promise<{ file: string; text: string }> =>
  fetch(`/api/chapter?bookRoot=${encodeURIComponent(bookRoot)}&file=${encodeURIComponent(file)}`, {
    headers: authHeaders(),
  }).then((r) => j<{ file: string; text: string }>(r));

export const postJson = <T>(path: string, body: unknown): Promise<T> =>
  fetch(`/api${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }).then((r) => j<T>(r));

export const putJson = <T>(path: string, body: unknown): Promise<T> =>
  fetch(`/api${path}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }).then((r) => j<T>(r));

/** 查服务端在跑什么长任务（F20-1）。附带把 true 作为 `cancelled` 判定的来源。 */
export const fetchTasks = (): Promise<{ tasks: InflightTask[] }> =>
  fetch('/api/tasks', { headers: authHeaders() }).then((r) => j<{ tasks: InflightTask[] }>(r));

/**
 * 取消后端长任务（F20-2）。
 * ★必须由 server 侧取消：前端 abort 只能断掉这条 HTTP 连接，
 * server 无状态、每次现读，spawn 出去的检查器会照跑到底。
 */
export const postCancel = (bookRoot: string): Promise<CancelResult> =>
  postJson<CancelResult>('/cancel', { bookRoot });
