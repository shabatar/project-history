import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../store';
import { useUrlParams } from '../lib/useUrlParams';
import type { SummaryStyle, Repository } from '../types';
import * as api from '../lib/api';
import {
  useRepositories,
  useOllamaModels,
  useBranches,
  useCommits,
} from '../lib/hooks';
import DateRangePicker from '../components/DateRangePicker';
import CommitTable from '../components/CommitTable';
import GenerationLog, { createLogEntry, type LogEntry } from '../components/GenerationLog';

type SummaryMode = 'date-range' | 'branch-diff';

const STYLE_OPTIONS: { value: SummaryStyle; label: string }[] = [
  { value: 'short', label: 'Brief' },
  { value: 'detailed', label: 'Detailed' },
  { value: 'custom', label: 'Custom' },
];

export default function CommitWorkbench() {
  const { selectedRepoId, setSelectedRepoId, dateRange, setDateRange } = useUrlParams();
  const { summaryStyle, setSummaryStyle, settings } = useAppStore();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: repos = [] } = useRepositories();
  const { data: models = [] } = useOllamaModels();
  const { data: branches = [] } = useBranches(selectedRepoId);
  const { data: runningModels = [] } = useQuery({
    queryKey: ['running-models'],
    queryFn: api.listRunningModels,
    refetchInterval: 5000,
  });

  const runningNames = useMemo(() => new Set(runningModels.map((m) => m.name)), [runningModels]);
  const [mode, setMode] = useState<SummaryMode>('date-range');
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [snapshotSaved, setSnapshotSaved] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [savedSnapshotPath, setSavedSnapshotPath] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef<number>(0);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);
  const selectedModel =
    models.find((m) => m.name === settings.defaultModel)?.name ??
    models[0]?.name ??
    settings.defaultModel;

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    setLogEntries((prev) => {
      const next = [...prev, createLogEntry(message, type)];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  useEffect(() => { setBranch(''); setBaseBranch(''); }, [selectedRepoId]);
  useEffect(() => {
    if (selectedRepo && !baseBranch) setBaseBranch(selectedRepo.default_branch || 'main');
  }, [selectedRepo]);

  const branchOptions = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const b of branches) {
      const name = b.name.replace(/^origin\//, '');
      if (!seen.has(name)) { seen.add(name); result.push(name); }
    }
    return result.sort();
  }, [branches]);

  // Always fetch commits for the selected repo+range — the table IS the preview
  const { data: commits = [], isLoading: commitsLoading } = useCommits(
    selectedRepoId,
    dateRange.from,
    dateRange.to,
  );

  const repoMap = useMemo(() => {
    const m = new Map<string, Repository>();
    for (const r of repos) m.set(r.id, r);
    return m;
  }, [repos]);

  async function handleSaveSnapshot() {
    if (!selectedRepoId || commits.length === 0) return;
    setSnapshotSaving(true);
    setSnapshotSaved(false);
    setSnapshotError(null);
    setSavedSnapshotPath(null);
    try {
      const snapshot = await api.saveCommitSnapshot({
        repository_id: selectedRepoId,
        repo_name: selectedRepo?.name ?? selectedRepoId,
        since: mode === 'date-range' ? dateRange.from : undefined,
        until: mode === 'date-range' ? dateRange.to : undefined,
        branch: mode === 'branch-diff' ? branch : undefined,
        base_branch: mode === 'branch-diff' ? baseBranch || undefined : undefined,
        commits: commits.slice(0, 2000).map((c) => ({
          commit_hash: c.commit_hash,
          author_name: c.author_name,
          author_email: c.author_email,
          committed_at: c.committed_at,
          subject: c.subject,
        })),
      });
      setSnapshotSaved(true);
      setSavedSnapshotPath(`/reports/commit-snapshot/${snapshot.id}`);
      qc.invalidateQueries({ queryKey: ['commit-snapshots'] });
    } catch (e: any) {
      setSnapshotError(e?.response?.data?.detail || 'Failed to save snapshot');
    } finally {
      setSnapshotSaving(false);
    }
  }

  async function handleGenerate() {
    if (!selectedRepoId) return;
    setLogEntries([]);
    setShowLog(true);
    setGenerating(true);
    startTimeRef.current = Date.now();

    const controller = new AbortController();
    abortRef.current = controller;
    addLog(`Starting · ${selectedRepo?.name ?? selectedRepoId} · ${summaryStyle}`, 'step');

    if (!runningNames.has(selectedModel)) {
      addLog(`Loading model ${selectedModel}…`, 'step');
      try {
        await api.loadModel(selectedModel);
        qc.invalidateQueries({ queryKey: ['running-models'] });
      } catch {
        addLog('Could not pre-load model (will try anyway)', 'info');
      }
      if (controller.signal.aborted) { setGenerating(false); return; }
    }

    const customPromptVal = summaryStyle === 'custom' ? customPrompt.trim() || undefined : undefined;
    const body: Parameters<typeof api.createSummary>[0] =
      mode === 'branch-diff'
        ? { repository_id: selectedRepoId, branch, base_branch: baseBranch || undefined, model_name: selectedModel, summary_style: summaryStyle, custom_prompt: customPromptVal }
        : { repository_id: selectedRepoId, start_date: dateRange.from, end_date: dateRange.to, model_name: selectedModel, summary_style: summaryStyle, custom_prompt: customPromptVal };

    try {
      const data = await api.createSummary(body, controller.signal);
      const elapsed = ((Date.now() - startTimeRef.current) / 1000).toFixed(1);
      if (data.status === 'completed' && data.result) {
        addLog(`Done · ${data.result.commit_count} commits · ${elapsed}s`, 'success');
      } else {
        addLog(`Status: ${data.status} · ${elapsed}s`, data.status === 'failed' ? 'error' : 'info');
      }
      qc.invalidateQueries({ queryKey: ['summaries'] });
    } catch (err: any) {
      if (controller.signal.aborted) {
        addLog('Cancelled', 'error');
      } else {
        addLog(`Failed: ${err?.message || 'unknown error'}`, 'error');
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }

  const canGenerate =
    !!selectedRepoId &&
    !generating &&
    (mode === 'date-range' || !!branch) &&
    (summaryStyle !== 'custom' || customPrompt.trim().length > 0);

  const clonedRepos = repos.filter((r) => r.last_synced_at);

  return (
    <div className="cw-root">
      {/* ── Top toolbar ── */}
      <div className="cw-toolbar">
        <div className="cw-toolbar-header">
          <span className="cw-toolbar-title">Browse Commits</span>
          <div className="summary-mode-toggle">
            <button
              className={`btn btn-sm${mode === 'date-range' ? ' btn-primary' : ''}`}
              onClick={() => setMode('date-range')}
            >
              Date range
            </button>
            <button
              className={`btn btn-sm${mode === 'branch-diff' ? ' btn-primary' : ''}`}
              onClick={() => setMode('branch-diff')}
            >
              Branch diff
            </button>
          </div>
        </div>

        <div className="cw-toolbar-body">
          {/* Repo chips */}
          <div className="cw-repo-row">
            <span className="toolbar-label">Repository</span>
            <div className="ce-repo-chips">
              {clonedRepos.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`ce-repo-chip${selectedRepoId === r.id ? ' active' : ''}`}
                  onClick={() => setSelectedRepoId(selectedRepoId === r.id ? null : r.id)}
                >
                  {r.name}
                </button>
              ))}
              {clonedRepos.length === 0 && (
                <span className="ce-no-repos">No cloned repos yet</span>
              )}
            </div>
          </div>

          {/* Date / branch */}
          {mode === 'date-range' ? (
            <DateRangePicker value={dateRange} onChange={setDateRange} />
          ) : (
            <div className="cw-branch-row">
              <div className="toolbar-repo">
                <span className="toolbar-label">Branch</span>
                <select className="input" value={branch} onChange={(e) => setBranch(e.target.value)}>
                  <option value="">— select —</option>
                  {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div className="toolbar-repo">
                <span className="toolbar-label">Base</span>
                <select className="input" value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)}>
                  {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Commit table (always shown when repo selected) ── */}
      {selectedRepoId && (
        <>
          <div className="cw-commits-bar">
            <span className="ce-count">
              {commitsLoading ? 'Loading…' : `${commits.length} commit${commits.length !== 1 ? 's' : ''}`}
            </span>
            <div className="cw-actions">
              <button
                className={`btn btn-sm pf-snapshot-btn${snapshotSaved ? ' pf-snapshot-saved' : ''}`}
                onClick={snapshotSaved && savedSnapshotPath ? () => navigate(savedSnapshotPath) : handleSaveSnapshot}
                disabled={snapshotSaving || (!snapshotSaved && commits.length === 0)}
                title={snapshotSaved ? 'Click to open saved snapshot' : 'Save to Reports for future reference'}
              >
                {snapshotSaved ? '✓ Saved · View →' : snapshotSaving ? 'Saving…' : '↓ Save snapshot'}
              </button>
              {snapshotError && <span className="snapshot-save-error">{snapshotError}</span>}
            </div>
          </div>
          <CommitTable
            commits={commits}
            loading={commitsLoading}
            onSelectionCopy={() => {}}
            showRepoColumn={false}
            repoMap={repoMap}
          />
        </>
      )}

      {!selectedRepoId && (
        <div className="empty-state">
          <p>Select a repository above to browse commits.</p>
        </div>
      )}

      {/* ── Generate report panel ── */}
      {selectedRepoId && (
        <div className="cw-generate-panel">
          <h4 className="cw-generate-heading">Generate AI Report</h4>
          <div className="cw-generate-body">
            <div className="cw-generate-row">
              <div className="toolbar-repo">
                <span className="toolbar-label">Model</span>
                <select
                  className="input"
                  value={selectedModel}
                  onChange={(e) => useAppStore.getState().setSettings({ defaultModel: e.target.value })}
                >
                  {models.length > 0
                    ? models.map((m) => (
                        <option key={m.name} value={m.name}>
                          {runningNames.has(m.name) ? '● ' : '○ '}{m.name}
                        </option>
                      ))
                    : <option value={settings.defaultModel}>{settings.defaultModel}</option>}
                </select>
              </div>
              <div className="toolbar-repo">
                <span className="toolbar-label">Style</span>
                <select
                  className="input"
                  value={summaryStyle}
                  onChange={(e) => setSummaryStyle(e.target.value as SummaryStyle)}
                >
                  {STYLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary" onClick={handleGenerate} disabled={!canGenerate}>
                {generating ? 'Generating…' : 'Generate report'}
              </button>
              {generating && (
                <button className="btn btn-sm btn-danger" onClick={() => abortRef.current?.abort()}>
                  Cancel
                </button>
              )}
            </div>
            {summaryStyle === 'custom' && (
              <textarea
                className="input pf-custom-prompt"
                placeholder="e.g. What were the biggest changes? Any breaking changes?"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                rows={2}
                disabled={generating}
              />
            )}
            <GenerationLog entries={logEntries} visible={showLog} />
            {showLog && !generating && (
              <button className="btn btn-sm" onClick={() => setShowLog(false)}>
                Hide log
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
