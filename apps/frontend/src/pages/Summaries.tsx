import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store';
import { useUrlParams } from '../lib/useUrlParams';
import type { SummaryStyle } from '../types';
import * as api from '../lib/api';
import {
  useRepositories,
  useSummaries,
  useOllamaModels,
  useBranches,
} from '../lib/hooks';
import DateRangePicker from '../components/DateRangePicker';
import SummaryPanel, { renderMarkdown } from '../components/SummaryPanel';
import GenerationLog, {
  createLogEntry,
  type LogEntry,
} from '../components/GenerationLog';

function TSelect({ label, value, onChange, children }: {
  label: string; value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  return (
    <div className="toolbar-repo">
      <span className="toolbar-label">{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </div>
  );
}

const STYLE_OPTIONS: { value: SummaryStyle; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'detailed', label: 'Detailed (engineering)' },
  { value: 'manager', label: 'Briefly' },
];

type SummaryMode = 'date-range' | 'branch-diff';

export default function Summaries() {
  const { selectedRepoId, setSelectedRepoId, dateRange, setDateRange } =
    useUrlParams();
  const { summaryStyle, setSummaryStyle, settings } = useAppStore();

  const qc = useQueryClient();
  const { data: repos = [] } = useRepositories();
  const { data: models = [] } = useOllamaModels();
  const { data: branches = [] } = useBranches(selectedRepoId);
  const { data: runningModels = [] } = useQuery({
    queryKey: ['running-models'],
    queryFn: api.listRunningModels,
    refetchInterval: 5000,
  });

  const runningNames = useMemo(() => new Set(runningModels.map((m) => m.name)), [runningModels]);

  const [generating, setGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [mode, setMode] = useState<SummaryMode>('date-range');
  const [branch, setBranch] = useState('');
  const [historyRepoFilter, setHistoryRepoFilter] = useState<string>('');

  // Fetch all summaries, filter client-side for the history view
  const { data: allJobs = [], isLoading: jobsLoading } = useSummaries(
    historyRepoFilter || null,
  );
  const [baseBranch, setBaseBranch] = useState('');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const startTimeRef = useRef<number>(0);

  const addLog = useCallback(
    (message: string, type: LogEntry['type'] = 'info') => {
      setLogEntries((prev) => {
        const next = [...prev, createLogEntry(message, type)];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    },
    [],
  );

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);
  const selectedModel =
    models.find((m) => m.name === settings.defaultModel)?.name ??
    models[0]?.name ??
    settings.defaultModel;

  // Reset branch selection when repo changes
  useEffect(() => {
    setBranch('');
    setBaseBranch('');
  }, [selectedRepoId]);

  // Auto-set base branch from repo default
  useEffect(() => {
    if (selectedRepo && !baseBranch) {
      setBaseBranch(selectedRepo.default_branch || 'main');
    }
  }, [selectedRepo, baseBranch]);

  async function handleSummarize() {
    if (!selectedRepoId) return;

    setLogEntries([]);
    setShowLog(true);
    setGenerating(true);
    startTimeRef.current = Date.now();

    const controller = new AbortController();
    abortRef.current = controller;

    const repoName = selectedRepo?.name ?? selectedRepoId;

    addLog(`Starting summary for ${repoName}`, 'step');
    addLog(`Model: ${selectedModel} | Style: ${summaryStyle}`);
    if (mode === 'branch-diff') {
      addLog(`Branch: ${branch} vs ${baseBranch || 'default'}`);
    } else {
      addLog(`Date range: ${dateRange.from} to ${dateRange.to}`);
    }

    // Auto-load model if not running
    if (!runningNames.has(selectedModel)) {
      addLog(`Model ${selectedModel} is not loaded, starting it...`, 'step');

      try {
        await api.loadModel(selectedModel);
        addLog(`Model ${selectedModel} loaded`, 'info');
        qc.invalidateQueries({ queryKey: ['running-models'] });
      } catch {
        addLog(`Could not pre-load model (will try anyway)`, 'info');
      }

      if (controller.signal.aborted) {
        setGenerating(false);
        addLog('Cancelled by user', 'error');
        return;
      }
    } else {
      addLog(`Model ${selectedModel} is already running`, 'info');
    }

    addLog('Sending to backend...', 'step');

    const body: Parameters<typeof api.createSummary>[0] =
      mode === 'branch-diff'
        ? {
            repository_id: selectedRepoId,
            branch,
            base_branch: baseBranch || undefined,
            model_name: selectedModel,
            summary_style: summaryStyle,
          }
        : {
            repository_id: selectedRepoId,
            start_date: dateRange.from,
            end_date: dateRange.to,
            model_name: selectedModel,
            summary_style: summaryStyle,
          };

    try {
      const data = await api.createSummary(body, controller.signal);
      const elapsed = ((Date.now() - startTimeRef.current) / 1000).toFixed(1);

      if (data.status === 'completed' && data.result) {
        addLog(`Summarized ${data.result.commit_count} commits`, 'info');
        addLog(`Done in ${elapsed}s`, 'success');
      } else if (data.status === 'failed') {
        addLog(`Failed after ${elapsed}s`, 'error');
      }
      qc.invalidateQueries({ queryKey: ['summaries'] });
    } catch (err: any) {
      if (controller.signal.aborted) {
        addLog('Cancelled by user', 'error');
      } else {
        const elapsed = ((Date.now() - startTimeRef.current) / 1000).toFixed(1);
        addLog(`Request failed after ${elapsed}s`, 'error');
        const msg = err?.message || '';
        if (msg.includes('500')) {
          addLog('Backend error — check if Ollama is running', 'error');
        } else {
          addLog(`Error: ${msg}`, 'error');
        }
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  const canSubmit =
    selectedRepoId &&
    !generating &&
    (mode === 'date-range' || branch);

  const branchOptions = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const b of branches) {
      const name = b.name.replace(/^origin\//, '');
      if (!seen.has(name)) { seen.add(name); result.push(name); }
    }
    return result.sort();
  }, [branches]);

  return (
    <div className="page">
      <div className="page-header">
        <h2>Summaries</h2>
        <p className="page-header-sub">
          {mode === 'date-range'
            ? `Summarize commits from ${dateRange.from} to ${dateRange.to}`
            : branch
              ? `Compare branch ${branch} vs ${baseBranch || 'default'}`
              : 'Select a branch to compare'}
        </p>
      </div>

      {/* ── Mode toggle ── */}
      <div className="summary-mode-toggle">
        <button
          className={`btn btn-sm ${mode === 'date-range' ? 'btn-primary' : ''}`}
          onClick={() => setMode('date-range')}
        >
          Date Range
        </button>
        <button
          className={`btn btn-sm ${mode === 'branch-diff' ? 'btn-primary' : ''}`}
          onClick={() => setMode('branch-diff')}
        >
          Branch Comparison
        </button>
      </div>

      <div className="toolbar">
        <TSelect label="Repository:" value={selectedRepoId ?? ''} onChange={(v) => setSelectedRepoId(v || null)}>
          <option value="">All repositories</option>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </TSelect>

        {mode === 'date-range' ? (
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        ) : (
          <>
            <TSelect label="Branch:" value={branch} onChange={setBranch}>
              <option value="">-- select branch --</option>
              {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
            </TSelect>
            <TSelect label="Base:" value={baseBranch} onChange={setBaseBranch}>
              {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
            </TSelect>
          </>
        )}

        <div className="toolbar-repo">
          <span className="toolbar-label">Model:</span>
          <select className="input" value={selectedModel}
            onChange={(e) => useAppStore.getState().setSettings({ defaultModel: e.target.value })}>
            {models.length > 0 ? (
              models.map((m) => <option key={m.name} value={m.name}>{runningNames.has(m.name) ? '\u25CF ' : '\u25CB '}{m.name}</option>)
            ) : (
              <option value={settings.defaultModel}>{settings.defaultModel} (default)</option>
            )}
          </select>
          {selectedModel && !runningNames.has(selectedModel) && models.length > 0 && (
            <span className="toolbar-hint">not loaded</span>
          )}
        </div>

        <TSelect label="Style:" value={summaryStyle} onChange={(v) => setSummaryStyle(v as SummaryStyle)}>
          {STYLE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </TSelect>

        <button
          className="btn btn-primary"
          onClick={handleSummarize}
          disabled={!canSubmit}
        >
          {generating
            ? 'Generating...'
            : mode === 'branch-diff'
              ? 'Compare Branches'
              : 'Generate Summary'}
        </button>

        {generating && (
          <button className="btn btn-sm btn-danger" onClick={handleCancel}>
            Cancel
          </button>
        )}

        {showLog && !generating && (
          <button
            className="btn btn-sm"
            onClick={() => setShowLog(false)}
          >
            Hide Log
          </button>
        )}
      </div>

      <GenerationLog entries={logEntries} visible={showLog} />

      {generating && (
        <ElapsedTimer startTime={startTimeRef.current} />
      )}

      {/* ── Summary history ── */}
      <div className="summary-history-header">
        <h3>Summary History</h3>
        <TSelect label="Filter:" value={historyRepoFilter} onChange={setHistoryRepoFilter}>
          <option value="">All repositories</option>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </TSelect>
      </div>

      <SummaryPanel
        jobs={allJobs}
        loading={jobsLoading}
        repos={repos}
        repoContext={
          selectedRepo
            ? { remote_url: selectedRepo.remote_url, name: selectedRepo.name }
            : null
        }
      />

      <ActivitySummariesSection />
    </div>
  );
}

function ActivitySummariesSection() {
  const { data: features } = useQuery({ queryKey: ['features'], queryFn: api.getFeatures, staleTime: 60_000 });
  const qc = useQueryClient();
  const enabled = !!features?.youtrack;
  const { data: summaries = [], isLoading } = useQuery({
    queryKey: ['activity-summaries'],
    queryFn: () => api.listActivitySummaries(100),
    enabled,
    refetchOnWindowFocus: false,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!enabled) return null;

  async function handleDelete(id: string) {
    if (!confirm('Delete this activity summary?')) return;
    try {
      await api.deleteActivitySummary(id);
      qc.invalidateQueries({ queryKey: ['activity-summaries'] });
      if (expandedId === id) setExpandedId(null);
    } catch { /* ignore */ }
  }

  return (
    <>
      <div className="summary-history-header" style={{ marginTop: 24 }}>
        <h3>Activity Summaries</h3>
        <span className="page-header-sub">YouTrack board &amp; project flow summaries</span>
      </div>
      {isLoading ? (
        <div className="empty-state"><p>Loading…</p></div>
      ) : summaries.length === 0 ? (
        <div className="empty-state">
          <p>No activity summaries yet. Generate one from the <a href="/activity">Activity</a> page.</p>
        </div>
      ) : (
        <div className="activity-summary-list">
          {summaries.map((s) => (
            <ActivitySummaryRow
              key={s.id}
              summary={s}
              expanded={expandedId === s.id}
              onToggle={() => setExpandedId(expandedId === s.id ? null : s.id)}
              onDelete={() => handleDelete(s.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ActivitySummaryRow({
  summary, expanded, onToggle, onDelete,
}: {
  summary: api.ActivitySummaryRecord;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="activity-summary-card">
      <header className="activity-summary-head" onClick={onToggle} style={{ cursor: 'pointer' }}>
        <span className={`activity-summary-type activity-summary-type-${summary.source_type}`}>
          {summary.source_type}
        </span>
        <span className="activity-summary-name">{summary.source_name}</span>
        <span className={`yt-summary-tag yt-summary-tag-${summary.summary_style}`}>
          {summary.summary_style}
        </span>
        <span className="activity-summary-meta">
          {summary.activity_count} ev · {summary.since} → {summary.until} · {summary.model_name}
        </span>
        {!summary.used_llm && <span className="yt-summary-fallback">fallback</span>}
        <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          Delete
        </button>
      </header>
      {expanded && (
        <div
          className="summary-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.summary_markdown, null) }}
        />
      )}
    </article>
  );
}

function ElapsedTimer({ startTime }: { startTime: number }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <div className="generation-timer">
      <span className="generation-timer-dot" />
      <span>
        Generating summary... {mins > 0 ? `${mins}m ` : ''}{secs}s elapsed
      </span>
    </div>
  );
}
