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

export default function Settings() {
  const qc = useQueryClient();
  const { settings, setSettings, summaryStyle, setSummaryStyle } = useAppStore();
  const { data: models = [], isError: modelsError } = useOllamaModels();

  useEffect(() => {
    configureIssueTracker(settings.issueTrackerType, settings.issueTrackerUrl);
  }, [settings.issueTrackerType, settings.issueTrackerUrl]);

  const activeTracker = TRACKER_OPTIONS.find((t) => t.value === settings.issueTrackerType);
  const showUrlField = settings.issueTrackerType === 'youtrack' || settings.issueTrackerType === 'jira';

  return (
    <div className="page">
      <div className="page-header"><h2>Settings</h2></div>

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
                onChange={(e) => setSummaryStyle(e.target.value as 'short' | 'detailed' | 'manager')}>
                <option value="short">Short</option>
                <option value="detailed">Detailed (engineering)</option>
                <option value="manager">Briefly</option>
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
    </div>
  );
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
      setSuccess(`${name}: ${action} done`);
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
              const isBusy = busy?.endsWith(`:${m.name}`);
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
                      <button className="btn btn-sm" onClick={() => onSetDefault(m.name)}>
                        Set default
                      </button>
                    )}
                    {isRunning ? (
                      <button className="btn btn-sm" disabled={!!isBusy}
                        onClick={() => act('stop', m.name, () => api.unloadModel(m.name))}>
                        {busy === `stop:${m.name}` ? 'Stopping...' : 'Stop'}
                      </button>
                    ) : (
                      <button className="btn btn-sm btn-primary" disabled={!!isBusy}
                        onClick={() => act('start', m.name, () => api.loadModel(m.name))}>
                        {busy === `start:${m.name}` ? 'Starting...' : 'Start'}
                      </button>
                    )}
                    <button className="btn btn-sm btn-danger" disabled={!!isBusy}
                      onClick={() => act('delete', m.name, () => api.deleteModel(m.name))}>
                      {busy === `delete:${m.name}` ? '...' : 'Delete'}
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
          .filter((s) => !models.some((m) => m.name.startsWith(s.name)))
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
        <input className="input" placeholder="Model name..." value={pullName}
          onChange={(e) => setPullName(e.target.value)} disabled={busy !== null} />
        {busy?.startsWith('download:') && busy.endsWith(`:${pullName.trim()}`) ? (
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
          Downloading... this may take a few minutes.
          <button className="btn btn-sm btn-danger" onClick={handleCancel} style={{ marginLeft: 8 }}>Cancel</button>
        </div>
      )}
    </div>
  );
}
