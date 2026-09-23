import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchChapter, fetchState, postJson } from './api.js';
import type { ChapterEntry } from './api.js';

/** worst → 徽标颜色（clean 绿 / 提示 黄 / 轻微 黄绿 / 中等 橙 / 严重 红 / 未检查 灰） */
const WORST_COLOR: Record<string, string> = {
  clean: '#2e7d32',
  提示: '#f9a825',
  轻微: '#9e9d24',
  中等: '#ef6c00',
  严重: '#c62828',
};

function Badge({ ch }: { ch: ChapterEntry }): React.JSX.Element {
  const worst = ch.gateStatus?.worst ?? '未检查';
  const color = ch.gateStatus === null ? '#757575' : (WORST_COLOR[worst] ?? '#757575');
  return (
    <span
      style={{
        display: 'inline-block',
        minWidth: 56,
        textAlign: 'center',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 12,
        color: '#fff',
        background: color,
      }}
    >
      {worst}
      {ch.gateStatus !== null && ch.gateStatus.count > 0 ? ` ${ch.gateStatus.count}` : ''}
    </span>
  );
}

export function App(): React.JSX.Element {
  const [bookRoot, setBookRoot] = useState<string>(
    () => localStorage.getItem('novel.bookRoot') ?? '',
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');
  const queryClient = useQueryClient();

  const stateQuery = useQuery({
    queryKey: ['state', bookRoot],
    queryFn: () => fetchState(bookRoot),
    enabled: bookRoot.trim() !== '',
    refetchInterval: 5000, // React Query 轮询 /state（经 /api 代理到 server）
  });

  const chapterQuery = useQuery({
    queryKey: ['chapter', bookRoot, selected],
    queryFn: () => fetchChapter(bookRoot, selected!),
    enabled: bookRoot.trim() !== '' && selected !== null,
  });

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['state', bookRoot] });

  const runAction = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    try {
      await fn();
      await refresh();
    } catch (e) {
      alert(`${label} 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <aside style={{ width: 320, borderRight: '1px solid #ddd', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 12, borderBottom: '1px solid #ddd' }}>
          <input
            style={{ width: '100%', boxSizing: 'border-box' }}
            placeholder="书根目录 bookRoot"
            value={bookRoot}
            onChange={(e) => {
              setBookRoot(e.target.value);
              localStorage.setItem('novel.bookRoot', e.target.value);
              setSelected(null);
            }}
          />
          <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
            {stateQuery.isLoading && '加载中…'}
            {stateQuery.isError && `读取失败：${(stateQuery.error as Error).message}`}
            {stateQuery.data && `共 ${stateQuery.data.chapters.length} 章 · 5s 轮询`}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {stateQuery.data?.chapters.map((ch) => (
            <div
              key={ch.chapterNo}
              onClick={() => setSelected(ch.file)}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                cursor: 'pointer',
                background: selected === ch.file ? '#e3f2fd' : undefined,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {String(ch.chapterNo).padStart(2, '0')} · {ch.title || ch.file}
              </span>
              <Badge ch={ch} />
            </div>
          ))}
        </div>
      </aside>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', gap: 8 }}>
          <button
            disabled={busy !== '' || bookRoot.trim() === ''}
            onClick={() =>
              void runAction('过闸', () => postJson('/gates', { bookRoot, write: true }))
            }
          >
            过闸并回填
          </button>
          <button
            disabled={busy !== '' || bookRoot.trim() === '' || stateQuery.data === undefined}
            onClick={() => {
              const next = (stateQuery.data?.chapters.length ?? 0) + 1;
              void runAction(`生成第 ${next} 章`, () => postJson('/write', { bookRoot, chapterNo: next }));
            }}
          >
            生成下一章
          </button>
          <span style={{ fontSize: 12, color: '#666', alignSelf: 'center' }}>{busy}</span>
        </div>
        <pre
          style={{
            flex: 1,
            overflowY: 'auto',
            margin: 0,
            padding: 16,
            whiteSpace: 'pre-wrap',
            fontFamily: 'inherit',
            lineHeight: 1.8,
          }}
        >
          {selected === null
            ? '点左侧章节查看正文'
            : chapterQuery.isLoading
              ? '加载中…'
              : chapterQuery.isError
                ? `读取失败：${(chapterQuery.error as Error).message}`
                : chapterQuery.data?.text}
        </pre>
      </main>
    </div>
  );
}
