import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchChapter, fetchState, getToken, postJson, putJson, setToken } from './api.js';
import type { ChapterEntry, ChapterReadiness, GateFinding, GateReport, GenerationReport } from './api.js';

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
    <span style={{ display: 'inline-block', minWidth: 56, textAlign: 'center', padding: '2px 8px', borderRadius: 10, fontSize: 12, color: '#fff', background: color }}>
      {worst}{ch.gateStatus !== null && ch.gateStatus.count > 0 ? ` ${ch.gateStatus.count}` : ''}
    </span>
  );
}

export function App(): React.JSX.Element {
  const [bookRoot, setBookRoot] = useState<string>(() => localStorage.getItem('novel.bookRoot') ?? '');
  // 服务端现在强制鉴权；token 存本地，改它即触发上面的 query 重拉（key 里带上 token）
  const [token, setTokenState] = useState<string>(() => getToken());
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [gateFindings, setGateFindings] = useState<GateFinding[] | null>(null);
  const [readiness, setReadiness] = useState<ChapterReadiness | null>(null);
  const [draftText, setDraftText] = useState<string>('');
  const [savedText, setSavedText] = useState<string>('');
  const [baselineText, setBaselineText] = useState<string>('');
  const [loadedKey, setLoadedKey] = useState<string>('');
  const queryClient = useQueryClient();

  const stateQuery = useQuery({
    // token 进 queryKey：改 token 后必须重拉，否则会一直显示上个 token 的错误
    queryKey: ['state', bookRoot, token],
    queryFn: () => fetchState(bookRoot),
    enabled: bookRoot.trim() !== '',
    refetchInterval: 5000,
  });

  const chapterQuery = useQuery({
    queryKey: ['chapter', bookRoot, selected, token],
    queryFn: () => fetchChapter(bookRoot, selected!),
    enabled: bookRoot.trim() !== '' && selected !== null,
  });

  useEffect(() => {
    const chapter = chapterQuery.data;
    if (chapter === undefined) return;
    const key = `${bookRoot}\0${chapter.file}`;
    if (loadedKey === key) return;
    setLoadedKey(key);
    setDraftText(chapter.text);
    setSavedText(chapter.text);
    setBaselineText(chapter.text);
  }, [bookRoot, chapterQuery.data, loadedKey]);

  const refreshState = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['state', bookRoot, token] });
  const selectedEntry = stateQuery.data?.chapters.find((chapter) => chapter.file === selected);
  const nextChapterNo = (stateQuery.data?.chapters.reduce((max, chapter) => Math.max(max, chapter.chapterNo), 0) ?? 0) + 1;
  const targetChapterNo = selectedEntry?.chapterNo ?? nextChapterNo;
  const visibleFindings = gateFindings?.filter((finding) => finding.chapter === selected) ?? [];
  const dirty = chapterQuery.data !== undefined && draftText !== savedText;
  const hasUnrecordedFeedback = savedText !== baselineText;
  const hasPendingAuthorWork = dirty || hasUnrecordedFeedback;

  const runAction = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setNotice('');
    try {
      await fn();
      await refreshState();
    } catch (e) {
      alert(`${label} 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  };

  const runGates = (): void => {
    void runAction('过闸', async () => {
      const report = await postJson<GateReport>('/gates', { bookRoot, write: true });
      setGateFindings(report.findings);
      setNotice(`门禁完成：共 ${report.findings.length} 条发现。`);
    });
  };

  const runPreflight = (): void => {
    void runAction('写前检查', async () => {
      const report = await postJson<ChapterReadiness>('/preflight', { bookRoot, chapterNo: targetChapterNo });
      setReadiness(report);
      setNotice(report.warnings.length === 0 ? '写前检查通过。' : `写前提醒 ${report.warnings.length} 项；仍可继续起稿。`);
    });
  };

  const runGenerate = (): void => {
    void runAction('生成并收敛', async () => {
      const report = await postJson<GenerationReport>('/generate', { bookRoot, chapterNo: targetChapterNo });
      const updatedChapter = await fetchChapter(bookRoot, report.generation.file);
      setGateFindings(report.findings);
      setReadiness(report.readiness);
      setDraftText(updatedChapter.text);
      setSavedText(updatedChapter.text);
      setBaselineText(updatedChapter.text);
      setLoadedKey(`${bookRoot}\0${updatedChapter.file}`);
      queryClient.setQueryData(['chapter', bookRoot, updatedChapter.file, token], updatedChapter);
      setSelected(report.generation.file);
      setNotice(`第 ${targetChapterNo} 章：${report.generation.stopped}，门禁发现 ${report.findings.length} 项。`);
    });
  };

  const saveChapter = (): void => {
    if (selected === null || selectedEntry === undefined) return;
    void runAction('保存正文', async () => {
      const saved = await putJson<{ file: string; text: string }>('/chapter', {
        bookRoot,
        chapterNo: selectedEntry.chapterNo,
        text: draftText,
      });
      setDraftText(saved.text);
      setSavedText(saved.text);
      setGateFindings(null);
      queryClient.setQueryData(['chapter', bookRoot, saved.file, token], saved);
      setNotice('正文已保存；旧门禁结果已失效，请重新检查。');
    });
  };

  const recordEditFeedback = (): void => {
    if (selectedEntry === undefined || !hasUnrecordedFeedback || dirty) return;
    void runAction('记录改稿反馈', async () => {
      await postJson('/feedback', {
        bookRoot,
        chapterNo: selectedEntry.chapterNo,
        originalText: baselineText,
        revisedText: savedText,
        findings: gateFindings?.filter((finding) => finding.chapter === selected) ?? [],
      });
      setBaselineText(savedText);
      setNotice('改稿反馈已记录，并生成待审规则候选。');
    });
  };

  const updateSummary = (): void => {
    if (selectedEntry === undefined) return;
    void runAction('更新摘要', async () => {
      const result = await postJson<{ ok: boolean; detail?: string; text?: string }>('/summarize', {
        bookRoot,
        chapterNo: selectedEntry.chapterNo,
      });
      if (!result.ok) throw new Error(result.detail ?? '摘要生成失败');
      setNotice(`第 ${selectedEntry.chapterNo} 章摘要已更新。`);
    });
  };

  const reportFindings = (): React.ReactNode => {
    if (gateFindings === null) return '尚未运行门禁。';
    if (visibleFindings.length === 0) return '当前章节没有门禁发现。';
    return visibleFindings.map((finding, index) => (
      <li key={`${finding.check}-${finding.line}-${index}`} style={{ marginBottom: 8 }}>
        <strong>[{finding.severity}] {finding.check}</strong>
        <div>{finding.line > 0 ? `第 ${finding.line} 行` : '整章'}{finding.detail ? ` · ${finding.detail}` : ''}</div>
      </li>
    ));
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
              if (hasPendingAuthorWork && !window.confirm('有未保存正文或未记录反馈，切换书目会放弃这些编辑记录。继续吗？')) return;
              setBookRoot(e.target.value);
              localStorage.setItem('novel.bookRoot', e.target.value);
              setSelected(null);
              setGateFindings(null);
              setReadiness(null);
              setLoadedKey('');
              setDraftText('');
              setSavedText('');
              setBaselineText('');
            }}
          />
          <input
            type="password"
            style={{ width: '100%', boxSizing: 'border-box', marginTop: 6 }}
            placeholder="服务端 token（见启动日志）"
            value={token}
            onChange={(e) => {
              setTokenState(e.target.value);
              setToken(e.target.value);
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
              onClick={() => {
                if (hasPendingAuthorWork && !window.confirm('有未保存正文或未记录反馈，切换章节会放弃这些编辑记录。继续吗？')) return;
                setSelected(ch.file);
                setDraftText('');
                setSavedText('');
                setBaselineText('');
              }}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', background: selected === ch.file ? '#e3f2fd' : undefined }}
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
        <div style={{ padding: 12, borderBottom: '1px solid #ddd', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button disabled={busy !== '' || bookRoot.trim() === '' || dirty} onClick={runGates}>过闸并查看问题</button>
          <button disabled={busy !== '' || bookRoot.trim() === '' || stateQuery.data === undefined} onClick={runPreflight}>
            检查第 {targetChapterNo} 章准备
          </button>
          <button disabled={busy !== '' || bookRoot.trim() === '' || stateQuery.data === undefined || hasPendingAuthorWork} onClick={runGenerate}>
            {selectedEntry ? `收敛第 ${targetChapterNo} 章` : `生成第 ${targetChapterNo} 章`}
          </button>
          <button disabled={busy !== '' || selectedEntry === undefined || !dirty} onClick={saveChapter}>保存正文</button>
          <button disabled={busy !== '' || selectedEntry === undefined || !hasUnrecordedFeedback || dirty} onClick={recordEditFeedback}>
            记录改稿反馈
          </button>
          <button disabled={busy !== '' || selectedEntry === undefined || dirty} onClick={updateSummary}>更新本章摘要</button>
          <span style={{ fontSize: 12, color: dirty ? '#ef6c00' : '#666', alignSelf: 'center' }}>
            {busy || (dirty ? '正文有未保存改动' : notice)}
          </span>
        </div>
        {readiness !== null && readiness.warnings.length > 0 && (
          <div style={{ padding: '8px 16px', background: '#fff8e1', color: '#6d4c00' }}>
            {readiness.warnings.map((warning) => <div key={warning}>• {warning}</div>)}
          </div>
        )}
        <textarea
          aria-label="章节正文编辑器"
          disabled={selected === null || chapterQuery.isLoading || chapterQuery.isError}
          value={selected === null ? '' : draftText}
          onChange={(e) => setDraftText(e.target.value)}
          placeholder={selected === null ? '选择章节后可查看和编辑正文' : '正文加载中…'}
          style={{ flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box', resize: 'none', border: 0, padding: 16, fontFamily: 'inherit', fontSize: 15, lineHeight: 1.8 }}
        />
        {selected !== null && chapterQuery.isError && (
          <div style={{ padding: 12, color: '#c62828' }}>读取失败：{(chapterQuery.error as Error).message}</div>
        )}
        <section style={{ height: 190, overflowY: 'auto', borderTop: '1px solid #ddd', padding: '8px 16px' }}>
          <strong>门禁发现{selected ? ` · ${selected}` : ''}</strong>
          <ul style={{ marginTop: 8, paddingLeft: 22 }}>{reportFindings()}</ul>
        </section>
      </main>
    </div>
  );
}
