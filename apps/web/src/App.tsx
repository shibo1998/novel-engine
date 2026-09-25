import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchChapter, fetchState, fetchTasks, getToken, postCancel, postJson, putJson, setToken } from './api.js';
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
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ display: 'inline-block', minWidth: 56, textAlign: 'center', padding: '2px 8px', borderRadius: 10, fontSize: 12, color: '#fff', background: color }}>
        {worst}{ch.gateStatus !== null && ch.gateStatus.count > 0 ? ` ${ch.gateStatus.count}` : ''}
      </span>
      {/* needsReview（B-13）：判据出了 unsure、或收敛停在 human-needed → 这章要人看。
          单独一枚标记，不并进 gateStatus——两者来源不同，混在一起就分不清
          「机器没过」还是「机器判不出来」了。 */}
      {ch.needsReview ? (
        <span title="需要人工过目：判据不确定，或机器改不动了" style={{ fontSize: 12, color: '#ef6c00' }}>👁 待人看</span>
      ) : null}
    </span>
  );
}

export function App(): React.JSX.Element {
  const [bookRoot, setBookRoot] = useState<string>(() => localStorage.getItem('novel.bookRoot') ?? '');
  // 服务端现在强制鉴权；token 存本地，改它即触发上面的 query 重拉（key 里带上 token）
  const [token, setTokenState] = useState<string>(() => getToken());
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>('');
  /** 本次请求的起始时刻（F20-1）：「忙」和「卡」在界面上必须长得不一样 */
  const [busySince, setBusySince] = useState<number | null>(null);
  const [tick, setTick] = useState<number>(() => Date.now());
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
    // F20-5：解析失败（含读到半写文件的瞬时窗口）就重拉，**不要**渲染成空态——
    // 空态看起来像「数据丢了」，而它其实只是「这一次没读全」。
    retry: 2,
    retryDelay: 400,
  });

  const chapterQuery = useQuery({
    queryKey: ['chapter', bookRoot, selected, token],
    queryFn: () => fetchChapter(bookRoot, selected!),
    enabled: bookRoot.trim() !== '' && selected !== null,
    retry: 2,
    retryDelay: 400,
  });

  // 服务端在跑什么（F20-1）：本地 busy 只能说明「这个标签页在等」，
  // 不能说明后端还在推进——卡死与正常长跑在只有本地状态时看起来一模一样。
  const tasksQuery = useQuery({
    queryKey: ['tasks', token],
    queryFn: fetchTasks,
    enabled: token.trim() !== '',
    // 忙的时候密一点（要能立刻看到「服务端确实在跑」），空闲时几乎不打
    refetchInterval: busy !== '' ? 1500 : 8000,
  });
  const serverTask = tasksQuery.data?.tasks.find((t) => t.bookRoot === bookRoot);

  // 每秒走一格：让等待时长可见。没有这个，超过三五秒的请求与卡死无法区分。
  useEffect(() => {
    if (busy === '') return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [busy]);
  const elapsedSec = busySince === null ? 0 : Math.max(0, Math.round((tick - busySince) / 1000));
  /** 阈值：超过它就把「已等待 N 秒」显示出来，而不是继续只转圈 */
  const SLOW_THRESHOLD_SEC = 5;

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
    setBusySince(Date.now());
    setTick(Date.now());
    setNotice('');
    try {
      await fn();
      await refreshState();
    } catch (e) {
      alert(`${label} 失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
      setBusySince(null);
      // 任务刚结束就刷一次任务表，别让「取消」按钮多留一会儿显得后端还在跑
      void queryClient.invalidateQueries({ queryKey: ['tasks', token] });
    }
  };

  /**
   * 取消**后端**任务（F20-2）。
   * 这里刻意不走 runAction：取消是射向服务端的信号，不是一个「本地在忙」的请求，
   * 把它塞进 busy 态会让「取消」本身看起来像另一个卡住的请求。
   */
  const cancelTask = (): void => {
    void (async () => {
      try {
        const r = await postCancel(bookRoot);
        setNotice(r.cancelled ? `已发出取消信号：${r.label ?? ''}` : r.note);
      } catch (e) {
        alert(`取消失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await queryClient.invalidateQueries({ queryKey: ['tasks', token] });
        await refreshState();
      }
    })();
  };

  const runGates = (): void => {
    void runAction('过闸', async () => {
      const report = await postJson<GateReport>('/gates', { bookRoot, write: true });
      if (report.cancelled === true) {
        // ★取消不产出结果：这里绝不能顺手去读 report.findings（它压根不在），
        // 清掉旧结果并说明，比留着一份「上一次的绿」安全。
        setGateFindings(null);
        setNotice('本次过闸已被取消，未产出结果（不是「查了没问题」）。');
        return;
      }
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
      if (report.cancelled === true) {
        setGateFindings(null);
        setNotice('本次生成已被取消，未产出结果。');
        return;
      }
      const updatedChapter = await fetchChapter(bookRoot, report.generation.file);
      setGateFindings(report.findings);
      setReadiness(report.readiness);
      setDraftText(updatedChapter.text);
      setSavedText(updatedChapter.text);
      setBaselineText(updatedChapter.text);
      setLoadedKey(`${bookRoot}\0${updatedChapter.file}`);
      queryClient.setQueryData(['chapter', bookRoot, updatedChapter.file, token], updatedChapter);
      setSelected(report.generation.file);
      setNotice(
        `第 ${targetChapterNo} 章：${report.generation.stopped}，门禁发现 ${report.findings.length} 项，`
          + `LLM 请求 ${report.generation.llmCalls} 次。`,
      );
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

  /**
   * 状态行（F20-1）。要回答的问题只有一个：现在是「在忙」还是「卡住了」。
   * 判据分开摆：本地等了多久 + 服务端有没有在跑的任务。
   * 两者对不上（本地等很久、服务端说没任务）本身就是最值得报警的一种状态。
   */
  const statusLine = (): string => {
    if (busy === '') return dirty ? '正文有未保存改动' : notice;
    const waited = elapsedSec >= SLOW_THRESHOLD_SEC ? `已等待 ${elapsedSec} 秒` : '';
    const server = serverTask !== undefined
      ? `服务端在跑「${serverTask.label}」${Math.round(serverTask.elapsedMs / 1000)}s`
      : (elapsedSec >= SLOW_THRESHOLD_SEC ? '⚠️ 服务端未报告在跑的任务（连接断了？后端异常退出？）' : '');
    return [`${busy}中…`, waited, server].filter((s) => s !== '').join(' · ');
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
          <button
            disabled={serverTask === undefined && busy === ''}
            onClick={cancelTask}
            title="取消服务端正在跑的长任务。前端 abort 只能断开这条连接——server 无状态、每次现读，spawn 出去的检查器会照跑到底。"
          >
            取消后端任务
          </button>
          <span style={{ fontSize: 12, color: dirty ? '#ef6c00' : '#666', alignSelf: 'center' }}>
            {statusLine()}
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
