import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import * as api from '../lib/api';
import type { ActivityItem } from '../lib/api';
import { isAbortError } from '../lib/abortable';
import { StorageKeys } from '../lib/storageKeys';

import {
  classifyItem,
  presetToDate,
  TYPE_KEYS,
  LOG_CAP,
  type FetchProgress,
  type LogEntry,
  type RangePreset,
  type Scope,
  type SummaryStyle,
  type TypeKey,
  type UnifiedSummary,
  type ViewMode,
} from './activity-flow/types';
import {
  cacheKey,
  loadActivityCache,
  saveActivityCache,
} from './activity-flow/cache';
import {
  ByIssueView,
  FetchProgressBar,
  RequestLog,
  SummaryCard,
  SummaryStrip,
  TimelineView,
  TypeFilterChips,
} from './activity-flow/components';
import { FlowToolbar } from './activity-flow/FlowToolbar';

const LOG_PREFIX = '[activity-flow]';

interface ActivityFlowProps {
  fixedBoard?: api.YouTrackBoard;
  fixedScope?: 'project';
}

export default function ActivityFlow({ fixedBoard, fixedScope }: ActivityFlowProps = {}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [scopeState, setScopeState] = useState<Scope>(() => {
    if (fixedBoard) return 'board';
    if (fixedScope) return fixedScope;
    try {
      const s = localStorage.getItem(StorageKeys.scope);
      return s === 'board' ? 'board' : 'project';
    } catch { return 'project'; }
  });
  const scope: Scope = fixedBoard ? 'board' : fixedScope ?? scopeState;
  const scopeIsFixed = !!(fixedBoard || fixedScope);

  const [selected, setSelected] = useState<api.YouTrackProject | null>(null);
  const [pendingShortName, setPendingShortName] = useState<string | null>(() => {
    if (fixedBoard || fixedScope) return null;
    try { return localStorage.getItem(StorageKeys.selectedProjectShortName); } catch { return null; }
  });

  const [selectedBoard, setSelectedBoard] = useState<api.YouTrackBoard | null>(null);
  const [pendingBoardId, setPendingBoardId] = useState<string | null>(() => {
    if (fixedBoard || fixedScope) return null;
    try { return localStorage.getItem(StorageKeys.selectedBoardId); } catch { return null; }
  });

  const effectiveBoard = fixedBoard ?? selectedBoard;

  const [preset, setPreset] = useState<RangePreset>('last-month');
  const [customSince, setCustomSince] = useState(() => dayjs().subtract(1, 'month').format('YYYY-MM-DD'));
  const [customUntil, setCustomUntil] = useState(() => dayjs().format('YYYY-MM-DD'));

  const since = preset === 'custom' ? customSince : presetToDate(preset);
  const until = preset === 'custom' ? customUntil : dayjs().format('YYYY-MM-DD');

  const [activities, setActivities] = useState<ActivityItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<FetchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [enabledTypes, setEnabledTypes] = useState<Set<TypeKey>>(new Set(TYPE_KEYS));
  const [view, setView] = useState<ViewMode>('timeline');

  const [summaryStyle, setSummaryStyle] = useState<SummaryStyle>('detailed');
  const [customPrompt, setCustomPrompt] = useState('');
  const [summary, setSummary] = useState<UnifiedSummary | null>(null);
  const [summaryProgress, setSummaryProgress] = useState<FetchProgress | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [snapshotSaved, setSnapshotSaved] = useState(false);
  const [savedSnapshotPath, setSavedSnapshotPath] = useState<string | null>(null);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  function log(level: LogEntry['level'], message: string): void {
    const entry: LogEntry = { ts: Date.now(), level, message };
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > LOG_CAP ? next.slice(-LOG_CAP) : next;
    });
    if (level === 'error') console.error(LOG_PREFIX, message);
    else if (level === 'warn') console.warn(LOG_PREFIX, message);
    else console.log(LOG_PREFIX, message);
  }

  const fetchAbortRef = useRef<AbortController | null>(null);
  const summaryAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    fetchAbortRef.current?.abort();
    summaryAbortRef.current?.abort();
  }, []);

  const { data: projects = [], isLoading: projectsLoading, error: projectsError } = useQuery({
    queryKey: ['yt-projects'],
    queryFn: () => api.listYouTrackProjects(false),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: scope === 'project',
  });

  const { data: config } = useQuery({
    queryKey: ['yt-config'],
    queryFn: api.getYouTrackConfig,
    staleTime: 5 * 60_000,
  });
  const ytBase = config?.base_url || null;

  const { data: boards = [], isLoading: boardsLoading } = useQuery({
    queryKey: ['yt-boards'],
    queryFn: api.listYouTrackBoards,
    staleTime: 2 * 60_000,
    enabled: scope === 'board' && !fixedBoard,
  });

  useEffect(() => {
    if (!pendingShortName || projects.length === 0 || selected) return;
    const match = projects.find((p) => p.short_name === pendingShortName);
    if (match) setSelected(match);
    setPendingShortName(null);
  }, [pendingShortName, projects, selected]);

  useEffect(() => {
    if (fixedBoard || !pendingBoardId || boards.length === 0 || selectedBoard) return;
    const match = boards.find((b) => b.id === pendingBoardId);
    if (match) setSelectedBoard(match);
    setPendingBoardId(null);
  }, [fixedBoard, pendingBoardId, boards, selectedBoard]);

  useEffect(() => {
    if (fixedBoard || fixedScope) return;
    try {
      if (selected) localStorage.setItem(StorageKeys.selectedProjectShortName, selected.short_name);
      else if (pendingShortName === null) localStorage.removeItem(StorageKeys.selectedProjectShortName);
    } catch { /* ignore */ }
  }, [fixedBoard, fixedScope, selected, pendingShortName]);

  useEffect(() => {
    if (fixedBoard || fixedScope) return;
    try {
      if (selectedBoard) localStorage.setItem(StorageKeys.selectedBoardId, selectedBoard.id);
      else if (pendingBoardId === null) localStorage.removeItem(StorageKeys.selectedBoardId);
    } catch { /* ignore */ }
  }, [fixedBoard, fixedScope, selectedBoard, pendingBoardId]);

  useEffect(() => {
    if (scopeIsFixed) return;
    try { localStorage.setItem(StorageKeys.scope, scope); } catch { /* ignore */ }
  }, [scopeIsFixed, scope]);

  useEffect(() => {
    setActivities(null);
    setSummary(null);
    setError(null);
    setSummaryError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  useEffect(() => {
    if (activities !== null) return;
    const id = scope === 'project' ? selected?.short_name : effectiveBoard?.id;
    if (!id) return;
    const cached = loadActivityCache(cacheKey(scope, id, since, until));
    if (cached) {
      setActivities(cached.activities);
      log('info',
        `Restored ${cached.activities.length} event${cached.activities.length !== 1 ? 's' : ''} from cache (${dayjs(cached.cachedAt).fromNow()})`,
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, selected?.short_name, effectiveBoard?.id, since, until]);

  const hasSelection = fixedBoard
    ? true
    : scope === 'project' ? !!selected : !!effectiveBoard;

  const selectionLabel = fixedBoard
    ? (fixedBoard.board_name || fixedBoard.board_id)
    : scope === 'project'
      ? (selected ? `${selected.short_name} · ${selected.name}` : null)
      : (effectiveBoard ? effectiveBoard.board_name || effectiveBoard.board_id : null);

  const typeCounts = useMemo<Record<TypeKey, number>>(() => {
    const m: Record<TypeKey, number> = {
      created: 0, resolved: 0, comment: 0, state: 0, assignee: 0, other: 0,
    };
    if (!activities) return m;
    for (const a of activities) m[classifyItem(a)]++;
    return m;
  }, [activities]);

  const filtered = useMemo(() => {
    if (!activities) return [];
    return activities.filter((a) => enabledTypes.has(classifyItem(a)));
  }, [activities, enabledTypes]);

  const touchedIssues = useMemo(() => {
    if (!activities) return 0;
    return new Set(activities.map((a) => a.issue_id)).size;
  }, [activities]);

  async function handleFetch(override?: { since: string; until: string }) {
    if (!hasSelection) {
      log('warn', `Fetch clicked without selection (scope=${scope})`);
      return;
    }
    const s = override?.since ?? since;
    const u = override?.until ?? until;

    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;

    setLoading(true);
    setProgress({ phase: 'starting', done: 0, total: 0, events_so_far: 0 });
    setError(null);
    setSummary(null);
    setSummaryError(null);
    setSnapshotSaved(false);
    setLogs([]);
    setLogOpen(true);

    const t0 = performance.now();
    log('info', `Fetch · ${selectionLabel || '(no selection)'} · ${s} → ${u}`);

    try {
      if (scope === 'project' && selected) {
        await runProjectFetch(selected.short_name, s, u, ctrl);
      } else if (scope === 'board' && effectiveBoard) {
        await runBoardFetch(effectiveBoard.id, s, u, ctrl);
      }
      log('info', `Done in ${secondsSince(t0)}s`);
    } catch (e: unknown) {
      if (isAbortError(e)) {
        log('warn', `Aborted after ${secondsSince(t0)}s`);
        return;
      }
      const axiosDetail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      const msg = axiosDetail || (e as Error)?.message || 'Failed to fetch activity';
      log('error', `Fetch failed: ${msg}`);
      setError(msg);
      setActivities(null);
    } finally {
      if (fetchAbortRef.current === ctrl) {
        setLoading(false);
        setProgress(null);
        fetchAbortRef.current = null;
      }
    }
  }

  async function runProjectFetch(
    shortName: string, s: string, u: string, ctrl: AbortController,
  ): Promise<void> {
    log('info', `POST /youtrack/projects/${shortName}/activity/stream`);
    let streamError: string | null = null;
    await api.streamProjectActivity(shortName, s, u, {
      signal: ctrl.signal,
      onStatus: (msg) => log('info', msg),
      onEvent: (event) => {
        if (ctrl.signal.aborted) return;
        if (event.type === 'status') {
          log('info', `phase=${event.phase}${event.project_name ? ` · ${event.short_name}` : ''}`);
          setProgress((prev) => ({
            phase: event.phase,
            done: prev?.done ?? 0,
            total: prev?.total ?? 0,
            events_so_far: prev?.events_so_far ?? 0,
          }));
        } else if (event.type === 'progress') {
          logProgressOccasionally(event);
          setProgress({ phase: event.phase, done: event.done, total: event.total, events_so_far: event.events_so_far });
        } else if (event.type === 'done') {
          const n = event.response.activities.length;
          log('info', `${n} event${n !== 1 ? 's' : ''}`);
          setActivities(event.response.activities);
          saveActivityCache(cacheKey('project', shortName, s, u), { activities: event.response.activities, cachedAt: Date.now() });
        } else if (event.type === 'error') {
          log('error', event.detail);
          streamError = event.detail;
        }
      },
    });
    if (streamError) setError(streamError);
  }

  async function runBoardFetch(
    boardId: string, s: string, u: string, ctrl: AbortController,
  ): Promise<void> {
    log('info', `POST /youtrack/boards/${boardId}/activity`);
    setProgress({ phase: 'fetching_activities', done: 0, total: 0, events_so_far: 0 });
    const resp = await api.fetchBoardActivity(boardId, s, u, ctrl.signal);
    if (ctrl.signal.aborted) return;
    log('info', `${resp.activities.length} event${resp.activities.length !== 1 ? 's' : ''}`);
    setActivities(resp.activities);
    saveActivityCache(cacheKey('board', boardId, s, u), { activities: resp.activities, cachedAt: Date.now() });
  }

  function handleCancelFetch() {
    if (fetchAbortRef.current) log('warn', 'Cancelled');
    fetchAbortRef.current?.abort();
    setLoading(false);
    setProgress(null);
  }

  async function handleSaveSnapshot() {
    if (!activities || !hasSelection) return;
    const sourceType = scope === 'board' ? 'board' : 'project';
    const sourceId = scope === 'board'
      ? (effectiveBoard?.id ?? '')
      : (selected?.short_name ?? '');
    const sourceName = selectionLabel ?? sourceId;

    setSnapshotSaving(true);
    setSavedSnapshotPath(null);
    try {
      const snapshot = await api.saveActivitySnapshot({
        source_type: sourceType,
        source_id: sourceId,
        source_name: sourceName,
        since,
        until,
        activities,
      });
      setSnapshotSaved(true);
      setSavedSnapshotPath(`/reports/snapshot/${snapshot.id}`);
      qc.invalidateQueries({ queryKey: ['activity-snapshots'] });
      log('info', `Snapshot saved · ${activities.length} events`);
    } catch (e) {
      log('error', `Snapshot save failed: ${(e as Error)?.message}`);
    } finally {
      setSnapshotSaving(false);
    }
  }

  async function handleSummarize() {
    if (!hasSelection) return;
    summaryAbortRef.current?.abort();
    const ctrl = new AbortController();
    summaryAbortRef.current = ctrl;

    setSummarizing(true);
    setSummaryError(null);
    setSummaryProgress({ phase: 'starting', done: 0, total: 0, events_so_far: 0 });
    setLogOpen(true);
    const t0 = performance.now();
    log('info', `Summarize · style=${summaryStyle}`);

    const onEvent = (event: api.SummaryStreamEvent) => {
      if (ctrl.signal.aborted) return;
      if (event.type === 'status') {
        const phaseMsg = event.phase === 'generating'
          ? `LLM · model=${event.model}`
          : `phase=${event.phase}${event.source ? ` · ${event.source}` : ''}`;
        log('info', phaseMsg);
        setSummaryProgress((prev) => ({
          phase: event.phase,
          done: prev?.done ?? 0,
          total: prev?.total ?? 0,
          events_so_far: prev?.events_so_far ?? 0,
        }));
      } else if (event.type === 'progress') {
        logProgressOccasionally(event);
        setSummaryProgress({ phase: event.phase, done: event.done, total: event.total, events_so_far: event.events_so_far });
      } else if (event.type === 'done') {
        setSummary(toUnifiedSummary(event.response));
        const r = event.response as { activity_count: number; model_name: string; used_llm: boolean };
        log('info', `${r.activity_count} events · model=${r.model_name}${r.used_llm ? '' : ' · fallback'}`);
      } else if (event.type === 'error') {
        log('error', event.detail);
        setSummaryError(event.detail);
      }
    };
    const onStatus = (msg: string) => log('info', msg);

    const summarizeInput = summaryStyle === 'custom'
      ? { since, until, summary_style: summaryStyle as 'custom', custom_prompt: customPrompt }
      : { since, until, summary_style: summaryStyle };

    try {
      if (scope === 'project' && selected) {
        await api.streamSummarizeProjectActivity(
          selected.short_name,
          summarizeInput,
          { signal: ctrl.signal, onEvent, onStatus },
        );
      } else if (scope === 'board' && effectiveBoard) {
        await api.streamSummarizeBoardActivity(
          effectiveBoard.id,
          summarizeInput,
          { signal: ctrl.signal, onEvent, onStatus },
        );
      }
      log('info', `Done in ${secondsSince(t0)}s`);
    } catch (e: unknown) {
      if (isAbortError(e)) {
        log('warn', `Aborted after ${secondsSince(t0)}s`);
        return;
      }
      const msg = (e as Error)?.message || 'Failed to summarize activity';
      log('error', `Summarize failed: ${msg}`);
      setSummaryError(msg);
    } finally {
      if (summaryAbortRef.current === ctrl) {
        setSummarizing(false);
        setSummaryProgress(null);
        summaryAbortRef.current = null;
      }
    }
  }

  function handleCancelSummarize() {
    summaryAbortRef.current?.abort();
    setSummarizing(false);
    setSummaryProgress(null);
  }

  function logProgressOccasionally(e: { phase: string; done: number; total: number; events_so_far: number }) {
    if (e.done === 0 || e.done === e.total || e.done % 50 === 0) {
      log('info', `${e.phase} · ${e.done}/${e.total} · ${e.events_so_far} events`);
    }
  }

  return (
    <div className="activity-flow-panel">
      {!scopeIsFixed && (
        <div className="pf-scope-tabs" style={{ marginBottom: 16 }}>
          <button
            className={`pf-scope-tab${scope === 'board' ? ' active' : ''}`}
            onClick={() => setScopeState('board')}
          >
            Board
          </button>
          <button
            className={`pf-scope-tab${scope === 'project' ? ' active' : ''}`}
            onClick={() => setScopeState('project')}
          >
            Project
          </button>
        </div>
      )}

      {projectsError && scope === 'project' && (
        <div className="error-banner">
          Could not load projects. Check your YouTrack connection.
        </div>
      )}

      <FlowToolbar
        scope={scope}
        projects={projects}
        projectsLoading={projectsLoading}
        selectedProject={selected}
        onSelectProject={(p) => {
          setSelected(p);
          setActivities(null);
          setSummary(null);
          if (p) log('info', `Project · ${p.short_name}`);
        }}
        boards={boards}
        boardsLoading={boardsLoading}
        selectedBoard={effectiveBoard}
        onSelectBoard={(b) => {
          setSelectedBoard(b);
          setActivities(null);
          setSummary(null);
          if (b) log('info', `Board · ${b.board_name || b.board_id}`);
        }}
        preset={preset}
        onPresetChange={setPreset}
        customSince={customSince}
        customUntil={customUntil}
        onCustomSinceChange={setCustomSince}
        onCustomUntilChange={setCustomUntil}
        since={since}
        until={until}
        onFetch={() => handleFetch()}
        onCancel={handleCancelFetch}
        loading={loading}
        hasSelection={hasSelection}
        hidePicker={!!fixedBoard}
      />

      {loading && (
        <FetchProgressBar
          progress={progress}
          label={selectionLabel}
          onCancel={handleCancelFetch}
        />
      )}

      {error && <div className="error-banner">{error}</div>}

      <RequestLog
        logs={logs}
        open={logOpen}
        onToggle={() => setLogOpen((v) => !v)}
        onClear={() => setLogs([])}
      />

      {activities && (
        <>
          <SummaryStrip
            total={activities.length}
            issuesTouched={touchedIssues}
            created={typeCounts.created}
            resolved={typeCounts.resolved}
            since={since}
            until={until}
            label={selectionLabel || ''}
            scope={scope}
          />

          <TypeFilterChips
            counts={typeCounts}
            enabled={enabledTypes}
            onToggle={(k) => {
              setEnabledTypes((prev) => {
                const next = new Set(prev);
                if (next.has(k)) next.delete(k); else next.add(k);
                return next;
              });
            }}
            onAll={() => setEnabledTypes(new Set(TYPE_KEYS))}
            onNone={() => setEnabledTypes(new Set())}
          />

          <div className="pf-view-toolbar">
            <div className="pf-view-toggle">
              <button className={`pf-view-btn${view === 'timeline' ? ' active' : ''}`} onClick={() => setView('timeline')}>
                Timeline
              </button>
              <button className={`pf-view-btn${view === 'by-issue' ? ' active' : ''}`} onClick={() => setView('by-issue')}>
                By Issue
              </button>
            </div>
            <div className="pf-summary-trigger">
              <button
                className={`btn btn-sm pf-snapshot-btn${snapshotSaved ? ' pf-snapshot-saved' : ''}`}
                onClick={snapshotSaved && savedSnapshotPath ? () => navigate(savedSnapshotPath) : handleSaveSnapshot}
                disabled={snapshotSaving || (!snapshotSaved && activities.length === 0)}
                title={snapshotSaved ? 'Click to open saved snapshot' : 'Save these raw events to Reports so you can revisit them later'}
              >
                {snapshotSaved ? '✓ Saved · View →' : snapshotSaving ? 'Saving…' : '↓ Save snapshot'}
              </button>
              <select
                className="input"
                value={summaryStyle}
                onChange={(e) => setSummaryStyle(e.target.value as SummaryStyle)}
                disabled={summarizing}
              >
                <option value="short">Brief</option>
                <option value="detailed">Detailed</option>
                <option value="custom">Custom</option>
              </select>
              {summaryStyle === 'custom' && (
                <textarea
                  className="input pf-custom-prompt"
                  placeholder="e.g. What was the biggest change? Which issues are blocked?"
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  rows={2}
                  disabled={summarizing}
                />
              )}
              {summarizing ? (
                <button className="btn btn-sm btn-danger" onClick={handleCancelSummarize}>Cancel</button>
              ) : (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleSummarize}
                  disabled={activities.length === 0 || (summaryStyle === 'custom' && !customPrompt.trim())}
                >
                  Summarize with AI
                </button>
              )}
            </div>
          </div>

          {summarizing && (
            <FetchProgressBar
              progress={summaryProgress}
              label={`AI summary · ${selectionLabel || ''}`}
              onCancel={handleCancelSummarize}
            />
          )}

          {summaryError && <div className="error-banner">{summaryError}</div>}
          {summary && <SummaryCard summary={summary} />}

          {filtered.length === 0 ? (
            <div className="empty-state">
              {activities.length === 0 ? (
                <>
                  <p>No activity in this range for <strong>{selectionLabel}</strong>.</p>
                  <p className="form-hint">Try a wider range:</p>
                  <div className="pf-widen-row">
                    <button className="btn btn-sm" onClick={() => { setPreset('last-month'); handleFetch({ since: presetToDate('last-month'), until: dayjs().format('YYYY-MM-DD') }); }}>
                      Last month
                    </button>
                    <button className="btn btn-sm" onClick={() => { setPreset('last-3-months'); handleFetch({ since: presetToDate('last-3-months'), until: dayjs().format('YYYY-MM-DD') }); }}>
                      3 months
                    </button>
                  </div>
                </>
              ) : (
                <p>All events are hidden by the current type filter.</p>
              )}
            </div>
          ) : view === 'timeline' ? (
            <TimelineView items={filtered} ytBase={ytBase} />
          ) : (
            <ByIssueView items={filtered} ytBase={ytBase} />
          )}
        </>
      )}

      {!activities && !error && !loading && (
        <div className="empty-state">
          {hasSelection
            ? <p>Choose a date range and press <strong>Fetch</strong>.</p>
            : scope === 'board'
              ? <p>Pick a tracked board above.</p>
              : <p>Pick a YouTrack project to see how its tickets are flowing.</p>}
        </div>
      )}
    </div>
  );
}

function secondsSince(t0: number): string {
  return ((performance.now() - t0) / 1000).toFixed(1);
}

function toUnifiedSummary(response: Record<string, unknown>): UnifiedSummary {
  const r = response as {
    id?: string;
    activity_count: number;
    model_name: string;
    used_llm: boolean;
    summary_markdown: string;
    summary_style: SummaryStyle;
    custom_prompt?: string;
    since: string;
    until: string;
    project_name?: string;
    project_short_name?: string;
    board_name?: string;
  };
  const label = r.project_short_name
    ? `${r.project_name} · ${r.project_short_name}`
    : (r.board_name || '');
  return {
    id: r.id,
    label,
    since: r.since,
    until: r.until,
    summary_style: r.summary_style,
    custom_prompt: r.custom_prompt,
    model_name: r.model_name,
    activity_count: r.activity_count,
    summary_markdown: r.summary_markdown,
    used_llm: r.used_llm,
  };
}
