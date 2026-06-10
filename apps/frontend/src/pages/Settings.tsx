import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store';
import { useOllamaModels } from '../lib/hooks';
import * as api from '../lib/api';
import { configureIssueTracker } from '../lib/linkify';
import type { IssueTrackerType } from '../types';

const TRACKER_OPTIONS: { value: IssueTrackerType; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'PROJECT-123 references are not linked' },
  { value: 'youtrack', label: 'YouTrack', hint: 'Links to {url}/issue/PROJECT-123' },
  { value: 'jira', label: 'Jira', hint: 'Links to {url}/browse/PROJECT-123' },
  { value: 'github', label: 'GitHub Issues', hint: '#N references use the repo context (PROJECT-N not linked)' },
];

const SUGGESTED_MODELS = [
  { name: 'llama3.1', desc: 'General purpose, 8B' },
  { name: 'qwen2.5-coder', desc: 'Code-focused, 7B' },
  { name: 'mistral', desc: 'Fast, 7B' },
  { name: 'gemma2', desc: 'Google, 9B' },
  { name: 'qwen2.5:0.5b', desc: 'Tiny, low RAM' },
];

const ACTION_PAST: Record<string, string> = {
  download: 'downloaded',
  start: 'started',
  stop: 'stopped',
  delete: 'deleted',
};

type SettingsTab = 'general' | 'logs';

export default function Settings() {
  const qc = useQueryClient();
  const { settings, setSettings, summaryStyle, setSummaryStyle } = useAppStore();
  const { data: models = [], isError: modelsError } = useOllamaModels();
  const [tab, setTab] = useState<SettingsTab>('general');

  useEffect(() => {
    configureIssueTracker(settings.issueTrackerType, settings.issueTrackerUrl);
  }, [settings.issueTrackerType, settings.issueTrackerUrl]);

  const activeTracker = TRACKER_OPTIONS.find((t) => t.value === settings.issueTrackerType);
  const showUrlField = settings.issueTrackerType === 'youtrack' || settings.issueTrackerType === 'jira';

  return (
    <div className="page">
      <div className="page-header"><h2>Settings</h2></div>

      <div className="act-section-tabs">
        <button className={`act-section-tab${tab === 'general' ? ' active' : ''}`} onClick={() => setTab('general')}>General</button>
        <button className={`act-section-tab${tab === 'logs' ? ' active' : ''}`} onClick={() => setTab('logs')}>Logs</button>
      </div>

      {tab === 'general' && (
        <div className="settings-sections">
          <section className="settings-section">
            <h3>Models</h3>
            <form className="settings-form" onSubmit={(e) => e.preventDefault()}>
              <div className="form-group">
                <label className="form-label" htmlFor="ollamaUrl">Server URL</label>
                <input id="ollamaUrl" type="text" className="input" value={settings.ollamaBaseUrl}
                  onChange={(e) => setSettings({ ollamaBaseUrl: e.target.value })} placeholder="http://localhost:11434" />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="summaryStyle">Default Summary Style</label>
                <select id="summaryStyle" className="input" value={summaryStyle}
                  onChange={(e) => setSummaryStyle(e.target.value as 'short' | 'detailed' | 'custom')}>
                  <option value="short">Brief</option>
                  <option value="detailed">Detailed</option>
                  <option value="custom">Custom prompt</option>
                </select>
              </div>
            </form>

            <ModelManager
              models={models}
              modelsError={modelsError}
              defaultModel={settings.defaultModel}
              onSetDefault={(name) => setSettings({ defaultModel: name })}
              onRefresh={() => qc.invalidateQueries({ queryKey: ['ollama-models'] })}
            />
          </section>

          <SavedQuestionsSection />

          <section className="settings-section">
            <h3>Issue Tracker</h3>
            <form className="settings-form" onSubmit={(e) => e.preventDefault()}>
              <div className="form-group">
                <label className="form-label" htmlFor="trackerType">Tracker Type</label>
                <select id="trackerType" className="input" value={settings.issueTrackerType}
                  onChange={(e) => setSettings({ issueTrackerType: e.target.value as IssueTrackerType })}>
                  {TRACKER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                {activeTracker && <span className="form-hint">{activeTracker.hint}</span>}
              </div>
              {showUrlField && (
                <div className="form-group">
                  <label className="form-label" htmlFor="trackerUrl">
                    {settings.issueTrackerType === 'youtrack' ? 'YouTrack URL' : 'Jira URL'}
                  </label>
                  <input id="trackerUrl" type="text" className="input" value={settings.issueTrackerUrl}
                    onChange={(e) => setSettings({ issueTrackerUrl: e.target.value })}
                    placeholder={settings.issueTrackerType === 'youtrack' ? 'https://youtrack.example.com' : 'https://jira.example.com'} />
                  <span className="form-hint">References like PROJ-123 in summaries will link to this instance.</span>
                </div>
              )}
            </form>
          </section>
        </div>
      )}

      {tab === 'logs' && <LogsPanel />}
    </div>
  );
}

function SavedQuestionsSection() {
  const { settings, setSettings } = useAppStore();
  const questions = settings.savedQuestions ?? [];
  const [draft, setDraft] = useState('');
  const dragIdx = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  function add() {
    const q = draft.trim();
    if (!q || questions.includes(q)) return;
    setSettings({ savedQuestions: [...questions, q] });
    setDraft('');
  }

  function remove(idx: number) {
    setSettings({ savedQuestions: questions.filter((_, i) => i !== idx) });
  }

  function onDragStart(idx: number) {
    dragIdx.current = idx;
  }

  function onDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    setDragOver(idx);
  }

  function onDrop(targetIdx: number) {
    const from = dragIdx.current;
    if (from === null || from === targetIdx) { setDragOver(null); return; }
    const next = [...questions];
    const [moved] = next.splice(from, 1);
    next.splice(targetIdx, 0, moved);
    setSettings({ savedQuestions: next });
    dragIdx.current = null;
    setDragOver(null);
  }

  function onDragEnd() {
    dragIdx.current = null;
    setDragOver(null);
  }

  return (
    <section className="settings-section">
      <h3>Saved Questions</h3>
      <p className="form-hint sq-hint">
        These appear as quick suggestions in the Notes &amp; Follow-ups panel on every report.
      </p>
      <div className="sq-list">
        {questions.map((q, i) => (
          <div
            key={q}
            className={`sq-item${dragOver === i ? ' sq-item-over' : ''}`}
            draggable
            onDragStart={() => onDragStart(i)}
            onDragOver={(e) => onDragOver(e, i)}
            onDrop={() => onDrop(i)}
            onDragEnd={onDragEnd}
          >
            <span className="sq-grip">⠿</span>
            <span className="sq-text">{q}</span>
            <button className="sq-remove" onClick={() => remove(i)} title="Remove">×</button>
          </div>
        ))}
        {questions.length === 0 && (
          <div className="sq-empty">No saved questions yet.</div>
        )}
      </div>
      <div className="sq-add-row">
        <input
          className="input sq-input"
          placeholder="Type a question and press Enter…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <button className="btn btn-sm sq-add-btn" onClick={add} disabled={!draft.trim()}>Add</button>
      </div>
    </section>
  );
}

const LEVEL_CLASS: Record<string, string> = {
  ERROR: 'log-level-error',
  CRITICAL: 'log-level-error',
  WARNING: 'log-level-warn',
  WARN: 'log-level-warn',
  INFO: 'log-level-info',
  DEBUG: 'log-level-debug',
  RAW: 'log-level-debug',
};

function LogsPanel() {
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['app-logs'],
    queryFn: () => api.getLogs(50),
    refetchInterval: 8_000,
    staleTime: 4_000,
  });
  const { data: features } = useQuery({
    queryKey: ['features'],
    queryFn: api.getFeatures,
    staleTime: 60_000,
  });

  const [openError, setOpenError] = useState<string | null>(null);

  async function handleOpenFolder() {
    setOpenError(null);
    try {
      await api.openLogsFolder();
    } catch (e: any) {
      setOpenError(e?.response?.data?.detail || 'Failed to open folder');
    }
  }

  const entries = data?.entries ?? [];

  return (
    <div className="log-panel">
      <div className="log-toolbar">
        <div className="log-toolbar-left">
          <button className="btn btn-sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {features?.open_folder && (
          <button className="btn btn-sm" onClick={handleOpenFolder}>
            Open logs folder ↗
          </button>
        )}
      </div>
      {openError && <div className="error-banner" style={{ marginBottom: 8 }}>{openError}</div>}

      {entries.length === 0 ? (
        <div className="log-empty">No log entries yet.</div>
      ) : (
        <div className="log-list">
          {entries.map((e, i) => (
            <div key={i} className={`log-entry log-entry-${(e.level || 'INFO').toLowerCase()}`}>
              <span className="log-ts">{e.ts}</span>
              <span className={`log-level-badge ${LEVEL_CLASS[e.level] ?? 'log-level-info'}`}>{e.level}</span>
              <span className="log-source">{shortName(e.name)}</span>
              <span className="log-msg">{e.msg}</span>
            </div>
          ))}
        </div>
      )}
      {entries.length > 0 && (
        <div className="log-footer">Showing last {entries.length} events · auto-refreshes every 8 s</div>
      )}
    </div>
  );
}

function shortName(name: string): string {
  // app.services.ollama_service → ollama_service
  const parts = name.split('.');
  return parts[parts.length - 1] ?? name;
}

function ModelManager({
  models,
  modelsError,
  defaultModel,
  onSetDefault,
  onRefresh,
}: {
  models: { name: string; size: number | null }[];
  modelsError: boolean;
  defaultModel: string;
  onSetDefault: (name: string) => void;
  onRefresh: () => void;
}) {
  const { data: running = [], refetch: refetchRunning } = useQuery({
    queryKey: ['running-models'],
    queryFn: api.listRunningModels,
    refetchInterval: 5000,
  });

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pullName, setPullName] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const runningNames = useMemo(() => new Set(running.map((m) => m.name)), [running]);

  async function act(action: string, name: string, fn: () => Promise<any>) {
    setBusy(`${action}:${name}`);
    setError(null);
    setSuccess(null);
    try {
      await fn();
      if (action === 'delete' && name === defaultModel) {
        const remaining = models.filter((m) => m.name !== name);
        onSetDefault(remaining.length > 0 ? remaining[0].name : '');
      }
      if (action === 'download') setPullName('');
      setSuccess(`${name} ${ACTION_PAST[action] ?? action + 'd'}`);
      onRefresh();
      refetchRunning();
    } catch (e: any) {
      if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') {
        setError(`${name}: download cancelled`);
      } else {
        setError(e?.response?.data?.detail || `Failed to ${action} ${name}`);
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  const hasModels = models.length > 0;

  return (
    <div className="mdl-manager">
      {hasModels && (
        <>
          <div className="mdl-header">
            <span className="mdl-header-title">Installed</span>
            <span className="ce-count">{models.length} installed, {running.length} running</span>
          </div>
          <div className="mdl-list">
            {models.map((m) => {
              const isRunning = runningNames.has(m.name);
              const isDefault = m.name === defaultModel;
              const isBusy = busy === `start:${m.name}` || busy === `stop:${m.name}` || busy === `delete:${m.name}`;
              return (
                <div key={m.name} className={`mdl-row${isRunning ? ' mdl-running' : ''}${isDefault ? ' mdl-default' : ''}`}>
                  <div className="mdl-info">
                    <span className="mdl-name">
                      {m.name}
                      {isDefault && <span className="mdl-default-badge">default</span>}
                    </span>
                    <span className="mdl-meta">
                      {m.size != null ? `${(m.size / 1e9).toFixed(1)} GB` : ''}
                      {isRunning && <span className="mdl-status-dot" title="Running" />}
                    </span>
                  </div>
                  <div className="mdl-actions">
                    {!isDefault && (
                      <button className="btn btn-sm" disabled={busy !== null}
                        onClick={() => onSetDefault(m.name)}>
                        Set default
                      </button>
                    )}
                    {isRunning ? (
                      <button className="btn btn-sm" disabled={isBusy}
                        onClick={() => act('stop', m.name, () => api.unloadModel(m.name))}>
                        {busy === `stop:${m.name}` ? 'Stopping…' : 'Stop'}
                      </button>
                    ) : (
                      <button className="btn btn-sm btn-primary" disabled={isBusy}
                        onClick={() => act('start', m.name, () => api.loadModel(m.name))}>
                        {busy === `start:${m.name}` ? 'Starting…' : 'Start'}
                      </button>
                    )}
                    <button className="btn btn-sm btn-danger" disabled={isBusy || isRunning}
                      title={isRunning ? 'Stop the model before deleting' : undefined}
                      onClick={() => act('delete', m.name, () => api.deleteModel(m.name))}>
                      {busy === `delete:${m.name}` ? '…' : 'Delete'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="mdl-header" style={{ marginTop: hasModels ? 12 : 0 }}>
        <span className="mdl-header-title">
          {hasModels ? 'Download' : modelsError ? 'Ollama not reachable' : 'No models — download one to start'}
        </span>
      </div>
      <div className="mdl-list">
        {SUGGESTED_MODELS
          .filter((s) => !models.some((m) => m.name === s.name || m.name.startsWith(s.name + ':')))
          .map((s) => (
            <div key={s.name} className="mdl-row">
              <div className="mdl-info">
                <span className="mdl-name">{s.name}</span>
                <span className="mdl-meta">{s.desc}</span>
              </div>
              {busy === `download:${s.name}` ? (
                <button className="btn btn-sm btn-danger" onClick={handleCancel}>Cancel</button>
              ) : (
                <button className="btn btn-sm btn-primary" disabled={busy !== null}
                  onClick={() => { const c = new AbortController(); abortRef.current = c; act('download', s.name, () => api.pullModel(s.name, c.signal)); }}>
                  Download
                </button>
              )}
            </div>
          ))}
      </div>
      <form className="mdl-pull-form" onSubmit={(e) => {
        e.preventDefault();
        if (pullName.trim()) { const c = new AbortController(); abortRef.current = c; act('download', pullName.trim(), () => api.pullModel(pullName.trim(), c.signal)); }
      }}>
        <input className="input" placeholder="Model name…" value={pullName}
          onChange={(e) => setPullName(e.target.value)} disabled={busy !== null} />
        {busy === `download:${pullName.trim()}` ? (
          <button className="btn btn-sm btn-danger" type="button" onClick={handleCancel}>Cancel</button>
        ) : (
          <button className="btn btn-sm btn-primary" type="submit"
            disabled={!pullName.trim() || busy !== null}>Download</button>
        )}
      </form>

      {error && <div className="error-banner">{error}</div>}
      {success && <div className="success-banner">{success}</div>}
      {busy?.startsWith('download:') && (
        <div className="mdl-progress">
          Downloading… this may take a few minutes.
          <button className="btn btn-sm btn-danger" onClick={handleCancel} style={{ marginLeft: 8 }}>Cancel</button>
        </div>
      )}
    </div>
  );
}
