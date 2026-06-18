import { useState, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store';
import * as api from '../lib/api';
import type { SummaryJob } from '../types';
import { useRepositories, useSummaries } from '../lib/hooks';
import { renderMarkdown } from '../components/SummaryPanel';
import { ReportContent } from '../components/ReportContent';
import { CommentsSection } from '../components/CommentsSection';
import { ActivityEventsTable } from '../components/ActivityEventsTable';
import { CommitSnapshotTable } from '../components/CommitSnapshotTable';

type ItemType = 'git-summary' | 'git-snapshot' | 'activity-summary' | 'activity-snapshot';
type TypeFilter = 'all' | ItemType;

interface UnifiedItem {
  id: string;
  type: ItemType;
  label: string;          // auto-generated fallback
  userLabel: string | null; // user-set override
  meta: string;
  created_at: string;
  raw: unknown;
}

const TYPE_LABELS: Record<ItemType, string> = {
  'git-summary': 'Commit summary',
  'git-snapshot': 'Commit snapshot',
  'activity-summary': 'Activity summary',
  'activity-snapshot': 'Activity snapshot',
};

const TYPE_COLORS: Record<ItemType, string> = {
  'git-summary': 'blue',
  'git-snapshot': 'blue-muted',
  'activity-summary': 'amber',
  'activity-snapshot': 'amber-muted',
};

export default function Summaries() {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  const { data: features } = useQuery({ queryKey: ['features'], queryFn: api.getFeatures, staleTime: 60_000 });
  const hasYouTrack = !!features?.youtrack;

  const { data: allJobs = [], isLoading: jobsLoading } = useSummaries(null);
  const { data: actSummaries = [], isLoading: actSumLoading } = useQuery({
    queryKey: ['activity-summaries'],
    queryFn: () => api.listActivitySummaries(100),
    enabled: hasYouTrack,
    refetchOnWindowFocus: false,
    // Poll while any activity summary is still generating in the background.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => s.status === 'pending' || s.status === 'running')
        ? 2500
        : false,
  });
  const { data: actSnapshots = [], isLoading: actSnapLoading } = useQuery({
    queryKey: ['activity-snapshots'],
    queryFn: () => api.listActivitySnapshots(100),
    enabled: hasYouTrack,
    refetchOnWindowFocus: false,
  });
  const { data: commitSnapshots = [], isLoading: commitSnapLoading } = useQuery({
    queryKey: ['commit-snapshots'],
    queryFn: () => api.listCommitSnapshots(undefined, 100),
  });

  const { data: repos = [] } = useRepositories();
  const qc = useQueryClient();

  const allItems = useMemo<UnifiedItem[]>(() => {
    const items: UnifiedItem[] = [];

    for (const j of allJobs) {
      const repo = repos.find((r) => r.id === j.repository_id);
      const title = j.branch
        ? `${j.branch} vs ${j.base_branch || 'default'}`
        : j.start_date && j.end_date
          ? `${dayjs(j.start_date).format('MMM D')} – ${dayjs(j.end_date).format('MMM D, YYYY')}`
          : 'Commit summary';
      items.push({
        id: j.id, type: 'git-summary',
        label: repo ? `${repo.name} / ${title}` : title,
        userLabel: j.user_label ?? null,
        meta: `${j.result?.commit_count ?? 0} commits · ${j.model_name} · ${j.status}`,
        created_at: j.created_at, raw: j,
      });
    }
    for (const s of actSummaries) {
      items.push({
        id: s.id, type: 'activity-summary',
        label: s.source_name,
        userLabel: s.user_label ?? null,
        meta: `${s.activity_count} events · ${s.since} → ${s.until} · ${s.model_name}`,
        created_at: s.generated_at, raw: s,
      });
    }
    for (const s of actSnapshots) {
      items.push({
        id: s.id, type: 'activity-snapshot',
        label: s.source_name,
        userLabel: s.user_label ?? null,
        meta: `${s.activity_count} events · ${s.since} → ${s.until}`,
        created_at: s.created_at, raw: s,
      });
    }
    for (const s of commitSnapshots) {
      const title = s.branch
        ? `${s.branch} vs ${s.base_branch || 'default'}`
        : s.since && s.until
          ? `${dayjs(s.since).format('MMM D')} – ${dayjs(s.until).format('MMM D, YYYY')}`
          : 'Commit snapshot';
      items.push({
        id: s.id, type: 'git-snapshot',
        label: `${s.repo_name} / ${title}`,
        userLabel: s.user_label ?? null,
        meta: `${s.commit_count} commits`,
        created_at: s.created_at, raw: s,
      });
    }

    return items
      .filter((i) => typeof i.id === 'string' && i.id.length > 0)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [allJobs, actSummaries, actSnapshots, commitSnapshots, repos]);

  const filteredItems = useMemo(() =>
    typeFilter === 'all' ? allItems : allItems.filter((i) => i.type === typeFilter),
    [allItems, typeFilter],
  );

  const typeCounts = useMemo(() => {
    const counts: Record<ItemType, number> = {
      'git-summary': 0, 'git-snapshot': 0, 'activity-summary': 0, 'activity-snapshot': 0,
    };
    for (const i of allItems) counts[i.type]++;
    return counts;
  }, [allItems]);

  const loading = jobsLoading || actSumLoading || actSnapLoading || commitSnapLoading;

  async function handleDeleteItem(item: UnifiedItem) {
    if (!confirm(`Delete this ${TYPE_LABELS[item.type]}?`)) return;
    try {
      if (item.type === 'git-summary') { await api.deleteSummary(item.id); qc.invalidateQueries({ queryKey: ['summaries'] }); }
      else if (item.type === 'activity-summary') { await api.deleteActivitySummary(item.id); qc.invalidateQueries({ queryKey: ['activity-summaries'] }); }
      else if (item.type === 'activity-snapshot') { await api.deleteActivitySnapshot(item.id); qc.invalidateQueries({ queryKey: ['activity-snapshots'] }); }
      else if (item.type === 'git-snapshot') { await api.deleteCommitSnapshot(item.id); qc.invalidateQueries({ queryKey: ['commit-snapshots'] }); }
    } catch { /* ignore */ }
  }

  return (
    <div className="page summ-page">
      <div className="page-header">
        <h2>Reports</h2>
        <p className="page-subtitle">
          Summaries and snapshots generated from <Link to="/boards">Activity</Link> and commits.
        </p>
      </div>

      {/* Type filter chips */}
      <div className="summ-filter-row">
        <button className={`summ-chip${typeFilter === 'all' ? ' summ-chip-active' : ''}`} onClick={() => setTypeFilter('all')}>
          All <span className="summ-chip-count">{allItems.length}</span>
        </button>
        {(['git-summary', 'git-snapshot', 'activity-summary', 'activity-snapshot'] as ItemType[]).map((t) =>
          typeCounts[t] > 0 && (
            <button
              key={t}
              className={`summ-chip summ-chip-${TYPE_COLORS[t]}${typeFilter === t ? ' summ-chip-active' : ''}`}
              onClick={() => setTypeFilter(t)}
            >
              {TYPE_LABELS[t]} <span className="summ-chip-count">{typeCounts[t]}</span>
            </button>
          )
        )}
      </div>

      {loading && filteredItems.length === 0 ? (
        <div className="empty-state"><p>Loading…</p></div>
      ) : filteredItems.length === 0 ? (
        <div className="empty-state">
          <p>No reports yet.</p>
          <p className="empty-state-hint">
            Go to <Link to="/boards">Activity</Link> to load YouTrack activity or browse commits — then save a snapshot or generate an AI report.
          </p>
        </div>
      ) : (
        <div className="summ-unified-list">
          {filteredItems.map((item, idx) => (
            <UnifiedItemCard
              key={item.id ? `${item.type}-${item.id}` : `${item.type}-${idx}`}
              item={item}
              repos={repos}
              hasYouTrack={hasYouTrack}
              onDelete={() => handleDeleteItem(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UnifiedItemCard({
  item, repos, hasYouTrack, onDelete,
}: {
  item: UnifiedItem;
  repos: { id: string; name: string; remote_url: string }[];
  hasYouTrack: boolean;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const defaultModel = useAppStore((s) => s.settings.defaultModel);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Inline summarize panel (activity-snapshot & commit-snapshot)
  const [summarizeOpen, setSummarizeOpen] = useState(false);
  const [summaryStyle, setSummaryStyle] = useState<'short' | 'detailed' | 'custom'>('detailed');
  const [customPrompt, setCustomPrompt] = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [summaryPhase, setSummaryPhase] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [savedSummaryId, setSavedSummaryId] = useState<string | null>(null);
  // git-snapshot reports generate in the background (vs. activity which streams to completion).
  const [startedInBackground, setStartedInBackground] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Reports generate in the background; surface their live status here.
  const recordStatus: string | null =
    item.type === 'git-summary' ? (item.raw as SummaryJob).status
    : item.type === 'activity-summary' ? ((item.raw as api.ActivitySummaryRecord).status ?? 'completed')
    : null;
  const recordError =
    item.type === 'git-summary' ? (item.raw as SummaryJob).error
    : item.type === 'activity-summary' ? (item.raw as api.ActivitySummaryRecord).error
    : null;
  const jobInFlight = recordStatus === 'pending' || recordStatus === 'running';

  async function handleCancel(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      if (item.type === 'git-summary') await api.cancelSummary(item.id);
      else if (item.type === 'activity-summary') await api.cancelActivitySummary(item.id);
    } finally {
      qc.invalidateQueries({ queryKey: item.type === 'git-summary' ? ['summaries'] : ['activity-summaries'] });
    }
  }

  const canSummarize =
    (hasYouTrack && item.type === 'activity-snapshot') || item.type === 'git-snapshot';
  // Where the saved report lives once generated.
  const savedReportPath = savedSummaryId
    ? item.type === 'activity-snapshot'
      ? `/reports/activity-summary/${savedSummaryId}`
      : `/summaries/${savedSummaryId}`
    : null;

  async function handleSummarize() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSummarizing(true);
    setSummaryError(null);
    setSummaryPhase('Generating…');
    setSavedSummaryId(null);

    const styleInput = {
      model_name: defaultModel,
      ...(summaryStyle === 'custom'
        ? { summary_style: 'custom' as const, custom_prompt: customPrompt }
        : { summary_style: summaryStyle }),
    };

    try {
      if (item.type === 'git-snapshot') {
        // Returns immediately with a "running" job; it generates in the background.
        const job = await api.summarizeCommitSnapshot(item.id, styleInput, ctrl.signal);
        if (!ctrl.signal.aborted) {
          setSavedSummaryId(job.id);
          setStartedInBackground(true);
          qc.invalidateQueries({ queryKey: ['summaries'] });
          setSummaryPhase(null);
        }
      } else {
        // Returns immediately with a "running" summary; it generates in the background.
        const summary = await api.summarizeActivitySnapshot(item.id, styleInput);
        if (!ctrl.signal.aborted) {
          setSavedSummaryId(summary.id);
          setStartedInBackground(true);
          qc.invalidateQueries({ queryKey: ['activity-summaries'] });
          setSummaryPhase(null);
        }
      }
    } catch (err: unknown) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (!isAbort) setSummaryError((err as { message?: string })?.message || 'Failed to summarize');
      setSummaryPhase(null);
    } finally {
      if (abortRef.current === ctrl) {
        setSummarizing(false);
        abortRef.current = null;
      }
    }
  }

  const displayLabel = item.userLabel || item.label;

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setEditValue(item.userLabel ?? item.label);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  async function commitEdit() {
    setEditing(false);
    const trimmed = editValue.trim();
    const next = trimmed || null;
    if (next === (item.userLabel ?? null)) return;
    await api.patchItemLabel(item.type, item.id, next);
    const qKeys: string[][] = [['summaries'], ['activity-summaries'], ['activity-snapshots'], ['commit-snapshots']];
    qKeys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { setEditing(false); }
  }

  return (
    <article className={`summ-item summ-item-${item.type.startsWith('git') ? 'git' : 'activity'}`}>
      <header className="summ-item-head" onClick={() => !editing && setExpanded((v) => !v)} style={{ cursor: editing ? 'default' : 'pointer' }}>
        <span className={`summ-item-badge summ-item-badge-${TYPE_COLORS[item.type]}`}>
          {TYPE_LABELS[item.type]}
        </span>
        {editing ? (
          <input
            ref={inputRef}
            className="summ-item-label-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={onKeyDown}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className={`summ-item-label${item.userLabel ? ' summ-item-label-custom' : ''}`}
            onDoubleClick={startEdit}
            title="Double-click to rename"
          >
            {displayLabel}
          </span>
        )}
        <span className="summ-item-meta">{item.meta}</span>
        {jobInFlight && (
          <span className="summ-status summ-status-running" title="Generating in the background">
            <span className="sai-spinner" /> Generating…
          </span>
        )}
        {(recordStatus === 'failed' || recordStatus === 'cancelled') && (
          <span
            className={`summ-status summ-status-${recordStatus}`}
            title={recordError ?? undefined}
          >
            {recordStatus === 'cancelled' ? 'Cancelled' : 'Failed'}
          </span>
        )}
        {jobInFlight && (
          <button className="sai-cancel-btn" onClick={handleCancel} title="Cancel generation">
            Cancel
          </button>
        )}
        <span className="summ-item-time">{dayjs(item.created_at).fromNow()}</span>
        {canSummarize && (
          <button
            className={`summ-ai-btn${summarizeOpen ? ' active' : ''}`}
            onClick={(e) => { e.stopPropagation(); setSummarizeOpen((v) => !v); setSavedSummaryId(null); setSummaryError(null); }}
            title="Summarise with AI"
          >
            ✦ AI summary
          </button>
        )}
        <span className="summ-item-chevron">{expanded ? '▲' : '▼'}</span>
        <button className="report-delete-btn" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">×</button>
      </header>

      {summarizeOpen && canSummarize && (
        <div className="sai-panel" onClick={(e) => e.stopPropagation()}>
          {savedSummaryId ? (
            <>
              <div className="sai-success">
                <span className="sai-success-icon">{startedInBackground ? '⏳' : '✓'}</span>
                <span className="sai-success-text">
                  {startedInBackground ? 'Generating in the background — appears in your Reports list' : 'AI report saved'}
                </span>
                <button className="sai-open-btn" onClick={() => savedReportPath && navigate(savedReportPath)}>
                  Open report →
                </button>
                <button className="sai-regen-btn" onClick={() => { setSavedSummaryId(null); setStartedInBackground(false); }}>
                  Re-generate
                </button>
              </div>
              {summaryStyle === 'custom' && customPrompt.trim() && (
                <p className="yt-summary-custom-prompt" style={{ marginTop: 8 }}>
                  <em>Prompt:</em> {customPrompt.trim()}
                </p>
              )}
            </>
          ) : summarizing ? (
            // Collapsed while generating: just a compact progress line.
            <div className="sai-row sai-generating">
              <span className="sai-spinner" />
              <span className="sai-phase">{summaryPhase ?? 'Generating…'}</span>
              {summaryStyle === 'custom' && customPrompt.trim() && (
                <span className="sai-generating-prompt" title={customPrompt}>“{customPrompt.trim()}”</span>
              )}
              <button
                className="sai-cancel-btn"
                onClick={() => { abortRef.current?.abort(); setSummarizing(false); setSummaryPhase(null); }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <div className="sai-row">
                <div className="sai-style-chips">
                  {(['detailed', 'short', 'custom'] as const).map((s) => (
                    <button
                      key={s}
                      className={`sai-chip${summaryStyle === s ? ' active' : ''}`}
                      onClick={() => { setSummaryStyle(s); setSavedSummaryId(null); }}
                    >
                      {s === 'detailed' ? 'Detailed' : s === 'short' ? 'Short' : 'Custom…'}
                    </button>
                  ))}
                </div>
                <div className="sai-actions">
                  <button
                    className="sai-generate-btn"
                    onClick={handleSummarize}
                    disabled={summaryStyle === 'custom' && !customPrompt.trim()}
                  >
                    ✦ Generate
                  </button>
                </div>
              </div>
              {summaryStyle === 'custom' && (
                <textarea
                  className="sai-prompt"
                  placeholder="Describe what you want the AI to focus on…"
                  rows={2}
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  autoFocus
                />
              )}
              {summaryError && <p className="sai-error">{summaryError}</p>}
            </>
          )}
        </div>
      )}

      {expanded && <UnifiedItemBody item={item} repos={repos} />}
    </article>
  );
}

function UnifiedItemBody({ item, repos }: {
  item: UnifiedItem;
  repos: { id: string; name: string; remote_url: string }[];
}) {
  const { settings } = useAppStore();
  const ytBaseUrl = settings.issueTrackerUrl?.replace(/\/$/, '') || '';

  if (item.type === 'git-summary') {
    const job = item.raw as any;
    const repo = repos.find((r) => r.id === job.repository_id);
    const ctx = repo ? { remote_url: repo.remote_url, name: repo.name } : null;
    return (
      <div className="summ-item-body">
        <div className="summ-item-actions">
          <Link to={`/summaries/${job.id}`} className="btn btn-sm">Open full report →</Link>
        </div>
        {job.custom_prompt && (
          <p className="yt-summary-custom-prompt"><em>Prompt:</em> {job.custom_prompt}</p>
        )}
        {job.result ? (
          <ReportContent
            className="report-content"
            markdown={job.result.summary_markdown}
            html={renderMarkdown(job.result.summary_markdown, ctx)}
            defaultCollapsed
          />
        ) : job.status === 'pending' || job.status === 'running' ? (
          <p className="summ-item-generating"><span className="sai-spinner" /> Generating report in the background…</p>
        ) : (
          <p className="summ-item-failed">
            Summary {job.status === 'cancelled' ? 'cancelled' : 'failed'}
            {job.error ? `: ${job.error}` : '.'}
          </p>
        )}
        {job.status === 'completed' && <CommentsSection summaryType="git" summaryId={job.id} />}
      </div>
    );
  }

  if (item.type === 'activity-summary') {
    const s = item.raw as api.ActivitySummaryRecord;
    const styleLabel: Record<string, string> = { detailed: 'Detailed', brief: 'Brief', custom: 'Custom' };
    return (
      <div className="sai-panel">
        <div className="summ-item-actions">
          <Link to={`/reports/activity-summary/${s.id}`} className="btn btn-sm">Open full report →</Link>
        </div>
        <div className="sai-panel-meta">
          <span className="sai-chip active" style={{ pointerEvents: 'none' }}>
            {styleLabel[s.summary_style] ?? s.summary_style}
          </span>
          {s.custom_prompt && (
            <span className="yt-summary-custom-prompt" style={{ margin: 0 }}>
              <em>Prompt:</em> {s.custom_prompt}
            </span>
          )}
        </div>
        {s.status === 'pending' || s.status === 'running' ? (
          <p className="summ-item-generating"><span className="sai-spinner" /> Generating report in the background…</p>
        ) : s.status === 'failed' || s.status === 'cancelled' ? (
          <p className="summ-item-failed">
            Summary {s.status === 'cancelled' ? 'cancelled' : 'failed'}
            {s.error ? `: ${s.error}` : '.'}
          </p>
        ) : (
          <ReportContent
            className="summary-markdown"
            markdown={s.summary_markdown}
            html={renderMarkdown(s.summary_markdown, null)}
            defaultCollapsed
          />
        )}
        {(s.status ?? 'completed') === 'completed' && <CommentsSection summaryType="activity" summaryId={s.id} />}
      </div>
    );
  }

  if (item.type === 'activity-snapshot') {
    const s = item.raw as api.ActivitySnapshot;
    return <ActivitySnapshotBody snapshot={s} ytBaseUrl={ytBaseUrl} />;
  }

  if (item.type === 'git-snapshot') {
    const s = item.raw as api.CommitSnapshot;
    return <CommitSnapshotBody snapshot={s} />;
  }

  return null;
}

function ActivitySnapshotBody({ snapshot, ytBaseUrl }: { snapshot: api.ActivitySnapshot; ytBaseUrl: string }) {
  const navigate = useNavigate();
  const [eventsOpen, setEventsOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['snapshot-raw', snapshot.id],
    queryFn: () => api.getActivitySnapshotRaw(snapshot.id),
    enabled: eventsOpen,
    staleTime: Infinity,
  });

  const activities = data?.activities ?? [];

  return (
    <div className="summ-item-body">
      <div className="snap-meta">
        <span className="snap-meta-pill">{snapshot.source_type === 'board' ? 'Board' : snapshot.source_type === 'issue' ? 'Issues' : 'Project'}</span>
        <span className="snap-meta-name">{snapshot.source_name}</span>
        <span className="snap-meta-range">{snapshot.since} → {snapshot.until}</span>
        <span className="snap-meta-count">{snapshot.activity_count} events</span>
      </div>

      <div className="summ-item-actions" style={{ marginBottom: 10 }}>
        <button className="btn btn-sm" onClick={() => navigate(`/reports/snapshot/${snapshot.id}`)}>
          Open full view →
        </button>
      </div>

      <button className="snap-events-toggle" onClick={() => setEventsOpen((v) => !v)}>
        {eventsOpen ? '▲ Hide events' : `▼ Preview ${snapshot.activity_count} events`}
      </button>

      {eventsOpen && (
        isLoading ? (
          <p className="snap-loading">Loading events…</p>
        ) : activities.length === 0 ? (
          <p className="snap-loading">No events found.</p>
        ) : (
          <ActivityEventsTable events={activities} ytBaseUrl={ytBaseUrl} pageSize={50} compact />
        )
      )}

      <CommentsSection summaryType="activity-snapshot" summaryId={snapshot.id} />
    </div>
  );
}

function CommitSnapshotBody({ snapshot }: { snapshot: api.CommitSnapshot }) {
  const navigate = useNavigate();
  const [commitsOpen, setCommitsOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['commit-snapshot-raw', snapshot.id],
    queryFn: () => api.getCommitSnapshotRaw(snapshot.id),
    enabled: commitsOpen,
    staleTime: Infinity,
  });

  const commits = data?.commits ?? [];

  const title = snapshot.branch
    ? `${snapshot.branch} vs ${snapshot.base_branch || 'default'}`
    : snapshot.since && snapshot.until
      ? `${dayjs(snapshot.since).format('MMM D')} – ${dayjs(snapshot.until).format('MMM D, YYYY')}`
      : 'Commit snapshot';

  return (
    <div className="summ-item-body">
      <div className="snap-meta">
        <span className="snap-meta-pill">Commits</span>
        <span className="snap-meta-name">{snapshot.repo_name}</span>
        <span className="snap-meta-range">{title}</span>
        <span className="snap-meta-count">{snapshot.commit_count} commits</span>
      </div>

      <div className="summ-item-actions" style={{ marginBottom: 10 }}>
        <button className="btn btn-sm" onClick={() => navigate(`/reports/commit-snapshot/${snapshot.id}`)}>
          Open full view →
        </button>
      </div>

      <button className="snap-events-toggle" onClick={() => setCommitsOpen((v) => !v)}>
        {commitsOpen ? '▲ Hide commits' : `▼ Preview ${snapshot.commit_count} commits`}
      </button>

      {commitsOpen && (
        isLoading ? (
          <p className="snap-loading">Loading commits…</p>
        ) : commits.length === 0 ? (
          <p className="snap-loading">No commits found.</p>
        ) : (
          <CommitSnapshotTable commits={commits} pageSize={50} />
        )
      )}

      <CommentsSection summaryType="git-snapshot" summaryId={snapshot.id} />
    </div>
  );
}
