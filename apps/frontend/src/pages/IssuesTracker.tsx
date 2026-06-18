import { useState, useMemo, useRef } from 'react';
import dayjs from 'dayjs';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import type { ActivityItem, TrackedIssue } from '../lib/api';
import type { Commit } from '../types';
import {
  TimelineView,
  ByIssueView,
  TypeFilterChips,
} from './activity-flow/components';
import { classifyItem, TYPE_KEYS, type TypeKey, type RangePreset, presetToDate } from './activity-flow/types';
import { issueUrl } from '../lib/youtrackLinks';

/** Issue ID rendered as a clickable tracker link when a base URL is configured. */
function IssueIdCell({ issueId, base }: { issueId: string; base: string | null }) {
  const href = issueUrl(base, issueId);
  if (!href) return <span className="it-issue-id">{issueId}</span>;
  return (
    <a
      className="it-issue-id yt-issue-id"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Open ${issueId} in tracker`}
    >
      {issueId}
    </a>
  );
}

const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last-week', label: 'Last week' },
  { key: 'last-month', label: 'Last month' },
  { key: 'custom', label: 'Custom' },
];

export default function IssuesTracker() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: ytConfig } = useQuery({
    queryKey: ['yt-config'],
    queryFn: api.getYouTrackConfig,
    staleTime: 60_000,
  });
  const ytBase = ytConfig?.base_url || null;

  const { data: tracked = [], isLoading: trackedLoading } = useQuery({
    queryKey: ['tracked-issues'],
    queryFn: api.listTrackedIssues,
  });

  const addMut = useMutation({
    mutationFn: (issue: Omit<TrackedIssue, 'id' | 'added_at' | 'last_refreshed_at'>) =>
      api.addTrackedIssue(issue),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tracked-issues'] }),
  });

  const removeMut = useMutation({
    mutationFn: api.removeTrackedIssue,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tracked-issues'] }),
  });

  const refreshMut = useMutation({
    mutationFn: api.refreshTrackedIssue,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tracked-issues'] }),
  });

  // ── Search ──
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<api.IssueSearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  async function handleSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await api.searchYouTrackIssues(q);
      setSearchResults(res);
    } catch (e: unknown) {
      setSearchError((e as { message?: string })?.message || 'Search failed');
    } finally {
      setSearchLoading(false);
    }
  }

  const trackedIds = useMemo(() => new Set(tracked.map((t) => t.issue_id)), [tracked]);

  // ── Activity ──
  const [actPreset, setActPreset] = useState<RangePreset>('last-week');
  const [customSince, setCustomSince] = useState(() => dayjs().subtract(7, 'day').format('YYYY-MM-DD'));
  const [customUntil, setCustomUntil] = useState(() => dayjs().format('YYYY-MM-DD'));
  const since = actPreset === 'custom' ? customSince : presetToDate(actPreset as Exclude<RangePreset, 'custom'>);
  const until = actPreset === 'custom' ? customUntil : dayjs().format('YYYY-MM-DD');

  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(new Set());
  const effectiveIssueIds = useMemo(
    () => (selectedIssueIds.size === 0 ? tracked.map((t) => t.issue_id) : [...selectedIssueIds]),
    [selectedIssueIds, tracked],
  );

  const [activities, setActivities] = useState<ActivityItem[] | null>(null);
  const [actLoading, setActLoading] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const [actView, setActView] = useState<'timeline' | 'by-issue'>('timeline');
  const [enabledTypes, setEnabledTypes] = useState<Set<TypeKey>>(new Set(TYPE_KEYS));
  const abortRef = useRef<AbortController | null>(null);

  const [snapshotSaving, setSnapshotSaving] = useState(false);
  const [snapshotSaved, setSnapshotSaved] = useState(false);
  const [savedSnapshotPath, setSavedSnapshotPath] = useState<string | null>(null);

  const typeCounts = useMemo<Record<TypeKey, number>>(() => {
    const m: Record<TypeKey, number> = { created: 0, resolved: 0, comment: 0, state: 0, assignee: 0, other: 0 };
    if (!activities) return m;
    for (const a of activities) m[classifyItem(a)]++;
    return m;
  }, [activities]);

  const filtered = useMemo(() => {
    if (!activities) return [];
    return activities.filter((a) => enabledTypes.has(classifyItem(a)));
  }, [activities, enabledTypes]);

  async function handleFetchActivity() {
    if (effectiveIssueIds.length === 0) return;
    abortRef.current?.abort();
    setActLoading(true);
    setActError(null);
    setActivities(null);
    setSnapshotSaved(false);
    setSavedSnapshotPath(null);
    try {
      const items = await api.fetchIssuesActivity(effectiveIssueIds, since, until);
      setActivities(items);
    } catch (e: unknown) {
      setActError((e as { message?: string })?.message || 'Failed to fetch activity');
    } finally {
      setActLoading(false);
    }
  }

  async function handleSaveSnapshot() {
    if (!activities || activities.length === 0) return;
    const label = effectiveIssueIds.join(', ');
    setSnapshotSaving(true);
    try {
      const snap = await api.saveActivitySnapshot({
        source_type: 'issue',
        source_id: effectiveIssueIds[0],
        source_name: label,
        since,
        until,
        view_mode: actView,
        activities,
      });
      setSnapshotSaved(true);
      setSavedSnapshotPath(`/reports/snapshot/${snap.id}`);
      qc.invalidateQueries({ queryKey: ['activity-snapshots'] });
    } catch { /* ignore */ }
    finally { setSnapshotSaving(false); }
  }

  // ── Commits multi-search ──
  const [commitSearchIds, setCommitSearchIds] = useState<Set<string>>(new Set());
  const [customCommitId, setCustomCommitId] = useState('');
  const [foundCommits, setFoundCommits] = useState<CommitWithIssues[] | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [commitSnapSaving, setCommitSnapSaving] = useState(false);
  const [commitSnapSaved, setCommitSnapSaved] = useState(false);
  const [savedCommitSnapPath, setSavedCommitSnapPath] = useState<string | null>(null);

  function toggleCommitIssue(id: string) {
    setCommitSearchIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function addCustomCommitId() {
    const id = customCommitId.trim().toUpperCase();
    if (!id) return;
    setCommitSearchIds((prev) => new Set([...prev, id]));
    setCustomCommitId('');
  }

  async function handleSearchCommits() {
    const ids = [...commitSearchIds];
    if (ids.length === 0) return;
    setCommitsLoading(true);
    setCommitsError(null);
    setFoundCommits(null);
    setCommitSnapSaved(false);
    setSavedCommitSnapPath(null);
    try {
      const groups = await Promise.all(
        ids.map((id) => api.getCommitsForIssue(id).then((commits) => ({ id, commits }))),
      );
      const byHash = new Map<string, CommitWithIssues>();
      for (const { id, commits } of groups) {
        for (const c of commits) {
          const existing = byHash.get(c.commit_hash);
          if (existing) {
            if (!existing.matched_issues.includes(id)) existing.matched_issues.push(id);
          } else {
            byHash.set(c.commit_hash, { ...c, matched_issues: [id] });
          }
        }
      }
      const merged = [...byHash.values()].sort(
        (a, b) => new Date(b.committed_at).getTime() - new Date(a.committed_at).getTime(),
      );
      setFoundCommits(merged);
    } catch (e: unknown) {
      setCommitsError((e as { message?: string })?.message || 'Search failed');
    } finally {
      setCommitsLoading(false);
    }
  }

  async function handleSaveCommitSnapshot() {
    if (!foundCommits || foundCommits.length === 0) return;
    setCommitSnapSaving(true);
    try {
      const snap = await api.saveCommitSnapshot({
        repository_id: 'issue-search',
        repo_name: [...commitSearchIds].join(', '),
        commits: foundCommits.map((c) => ({
          commit_hash: c.commit_hash,
          author_name: c.author_name,
          author_email: c.author_email,
          committed_at: c.committed_at,
          subject: c.subject,
        })),
      });
      setCommitSnapSaved(true);
      setSavedCommitSnapPath(`/reports/commit-snapshot/${snap.id}`);
      qc.invalidateQueries({ queryKey: ['commit-snapshots'] });
    } catch { /* ignore */ }
    finally { setCommitSnapSaving(false); }
  }

  function toggleIssueSelection(issueId: string) {
    setSelectedIssueIds((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) next.delete(issueId); else next.add(issueId);
      return next;
    });
  }

  if (tracked.length === 0 && !trackedLoading) {
    // Still show search even if no tracked issues yet
  }

  return (
    <div className="it-root">

      {/* ── Search ── */}
      <section className="it-section">
        <h3 className="it-section-title">Search Issues</h3>
        <form
          className="it-search-row"
          onSubmit={(e) => { e.preventDefault(); handleSearch(); }}
        >
          <input
            className="input it-search-input"
            placeholder="Issue ID or keywords, e.g. PROJ-123 or login bug"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            className="btn btn-primary"
            type="submit"
            disabled={!searchQuery.trim() || searchLoading}
          >
            {searchLoading ? 'Searching…' : 'Search'}
          </button>
        </form>

        {searchError && <div className="error-banner">{searchError}</div>}

        {searchResults !== null && (
          <div className="it-search-results">
            {searchResults.length === 0 ? (
              <p className="it-empty-hint">No results for "{searchQuery}"</p>
            ) : (
              searchResults.map((r) => (
                <div key={r.issue_id} className="it-result-row">
                  <IssueIdCell issueId={r.issue_id} base={ytBase} />
                  <span className="it-issue-summary">{r.summary}</span>
                  <div className="it-result-meta">
                    {r.state && <span className="it-state-chip">{r.state}</span>}
                    {r.assignee && <span className="it-assignee">{r.assignee}</span>}
                  </div>
                  {trackedIds.has(r.issue_id) ? (
                    <span className="it-tracked-badge">Tracked</span>
                  ) : (
                    <button
                      className="btn btn-sm it-track-btn"
                      onClick={() => addMut.mutate({
                        issue_id: r.issue_id,
                        summary: r.summary,
                        state: r.state,
                        assignee: r.assignee,
                        project_short_name: r.project_short_name,
                      })}
                      disabled={addMut.isPending}
                    >
                      + Track
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {/* ── Tracked Issues ── */}
      <section className="it-section">
        <div className="it-section-header">
          <h3 className="it-section-title">
            Tracked Issues
            {tracked.length > 0 && <span className="it-count-badge">{tracked.length}</span>}
          </h3>
          {tracked.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => tracked.forEach((t) => refreshMut.mutate(t.id))}
              disabled={refreshMut.isPending}
            >
              Refresh all
            </button>
          )}
        </div>

        {trackedLoading && <p className="it-empty-hint">Loading…</p>}
        {!trackedLoading && tracked.length === 0 && (
          <p className="it-empty-hint">No issues tracked yet. Search above and click "+ Track".</p>
        )}

        {tracked.length > 0 && (
          <div className="it-tracked-list">
            {tracked.map((t) => {
              const isSelected = selectedIssueIds.size === 0 || selectedIssueIds.has(t.issue_id);
              return (
                <div
                  key={t.id}
                  className={`it-tracked-row${isSelected ? ' it-selected' : ''}`}
                  onClick={() => toggleIssueSelection(t.issue_id)}
                  title="Click to toggle inclusion in activity fetch"
                >
                  <IssueIdCell issueId={t.issue_id} base={ytBase} />
                  <span className="it-issue-summary">{t.summary || '—'}</span>
                  <div className="it-result-meta">
                    {t.state && <span className="it-state-chip">{t.state}</span>}
                    {t.assignee && <span className="it-assignee">{t.assignee}</span>}
                  </div>
                  {t.last_refreshed_at && (
                    <span className="it-refreshed-at" title={t.last_refreshed_at}>
                      {dayjs(t.last_refreshed_at).fromNow()}
                    </span>
                  )}
                  <div className="it-row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn btn-sm it-refresh-btn"
                      onClick={() => refreshMut.mutate(t.id)}
                      disabled={refreshMut.isPending}
                      title="Refresh from tracker"
                    >↻</button>
                    <button
                      className="btn btn-sm btn-danger it-remove-btn"
                      onClick={() => removeMut.mutate(t.id)}
                      title="Stop tracking"
                    >×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tracked.length > 0 && selectedIssueIds.size > 0 && (
          <p className="it-selection-hint">
            {selectedIssueIds.size} issue{selectedIssueIds.size !== 1 ? 's' : ''} selected for activity.{' '}
            <button className="it-clear-selection" onClick={() => setSelectedIssueIds(new Set())}>
              Show all
            </button>
          </p>
        )}
      </section>

      {/* ── Activity ── */}
      {tracked.length > 0 && (
        <section className="it-section">
          <h3 className="it-section-title">Activity</h3>

          <div className="it-period-row">
            <div className="it-presets">
              {RANGE_PRESETS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`yt-compare-chip${actPreset === key ? ' active' : ''}`}
                  onClick={() => setActPreset(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            {actPreset === 'custom' && (
              <div className="it-custom-range">
                <input type="date" className="input" value={customSince} max={customUntil} onChange={(e) => setCustomSince(e.target.value)} />
                <span className="it-range-sep">→</span>
                <input type="date" className="input" value={customUntil} min={customSince} max={dayjs().format('YYYY-MM-DD')} onChange={(e) => setCustomUntil(e.target.value)} />
              </div>
            )}
          </div>

          <div className="it-fetch-row">
            <span className="it-fetch-label">
              {selectedIssueIds.size === 0
                ? `All ${tracked.length} tracked issue${tracked.length !== 1 ? 's' : ''}`
                : `${selectedIssueIds.size} selected issue${selectedIssueIds.size !== 1 ? 's' : ''}`}
              {' · '}{since} → {until}
            </span>
            <button
              className="btn btn-primary"
              onClick={handleFetchActivity}
              disabled={actLoading || tracked.length === 0}
            >
              {actLoading ? 'Fetching…' : 'Fetch activity'}
            </button>
            {actLoading && (
              <button className="btn btn-sm btn-danger" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            )}
          </div>

          {actError && <div className="error-banner">{actError}</div>}

          {activities !== null && (
            <>
              <div className="it-act-toolbar">
                <div className="pf-view-toggle">
                  <button className={`pf-view-btn${actView === 'timeline' ? ' active' : ''}`} onClick={() => setActView('timeline')}>Timeline</button>
                  <button className={`pf-view-btn${actView === 'by-issue' ? ' active' : ''}`} onClick={() => setActView('by-issue')}>By Issue</button>
                </div>
                <span className="ce-count">{activities.length} event{activities.length !== 1 ? 's' : ''}</span>
                <button
                  className={`btn btn-sm pf-snapshot-btn${snapshotSaved ? ' pf-snapshot-saved' : ''}`}
                  onClick={snapshotSaved && savedSnapshotPath ? () => navigate(savedSnapshotPath!) : handleSaveSnapshot}
                  disabled={snapshotSaving || activities.length === 0}
                >
                  {snapshotSaved ? '✓ Saved · View →' : snapshotSaving ? 'Saving…' : '↓ Save snapshot'}
                </button>
              </div>

              <TypeFilterChips
                counts={typeCounts}
                enabled={enabledTypes}
                onToggle={(k) => setEnabledTypes((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; })}
                onAll={() => setEnabledTypes(new Set(TYPE_KEYS))}
                onNone={() => setEnabledTypes(new Set())}
              />

              {filtered.length === 0 ? (
                <div className="empty-state">
                  {activities.length === 0
                    ? <p>No activity in this range for the selected issues.</p>
                    : <p>All events hidden by the current filter.</p>}
                </div>
              ) : actView === 'timeline' ? (
                <TimelineView items={filtered} ytBase={ytBase} />
              ) : (
                <ByIssueView items={filtered} ytBase={ytBase} />
              )}
            </>
          )}
        </section>
      )}

      {/* ── Commits ── */}
      <section className="it-section">
        <h3 className="it-section-title">Commits mentioning issues</h3>

        {/* Issue chips */}
        <div className="it-commit-chips-area">
          {tracked.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`it-commit-chip${commitSearchIds.has(t.issue_id) ? ' active' : ''}`}
              onClick={() => toggleCommitIssue(t.issue_id)}
            >
              {t.issue_id}
            </button>
          ))}
        </div>

        {/* Custom issue ID input */}
        <form
          className="it-custom-id-row"
          onSubmit={(e) => { e.preventDefault(); addCustomCommitId(); }}
        >
          <input
            className="input it-custom-id-input"
            placeholder="Add custom ID, e.g. PROJ-999"
            value={customCommitId}
            onChange={(e) => setCustomCommitId(e.target.value)}
          />
          <button className="btn btn-sm" type="submit" disabled={!customCommitId.trim()}>
            Add
          </button>
        </form>

        {/* Show any extra (custom) IDs that aren't tracked issues */}
        {[...commitSearchIds].filter((id) => !trackedIds.has(id)).length > 0 && (
          <div className="it-commit-chips-area" style={{ marginTop: 4 }}>
            {[...commitSearchIds].filter((id) => !trackedIds.has(id)).map((id) => (
              <button
                key={id}
                type="button"
                className="it-commit-chip active it-commit-chip-custom"
                onClick={() => toggleCommitIssue(id)}
                title="Click to remove"
              >
                {id} ×
              </button>
            ))}
          </div>
        )}

        <div className="it-fetch-row" style={{ marginTop: 10 }}>
          <button
            className="btn btn-primary"
            onClick={handleSearchCommits}
            disabled={commitsLoading || commitSearchIds.size === 0}
          >
            {commitsLoading ? 'Searching…' : `Search commits${commitSearchIds.size > 0 ? ` (${commitSearchIds.size})` : ''}`}
          </button>
          {commitSearchIds.size > 0 && (
            <button className="it-clear-selection" onClick={() => setCommitSearchIds(new Set())}>
              Clear
            </button>
          )}
        </div>

        {commitsError && <div className="error-banner">{commitsError}</div>}

        {foundCommits !== null && (
          <>
            <div className="it-act-toolbar" style={{ marginTop: 10 }}>
              <span className="ce-count">
                {foundCommits.length} commit{foundCommits.length !== 1 ? 's' : ''}
              </span>
              {foundCommits.length > 0 && (
                <button
                  className={`btn btn-sm pf-snapshot-btn${commitSnapSaved ? ' pf-snapshot-saved' : ''}`}
                  onClick={commitSnapSaved && savedCommitSnapPath ? () => navigate(savedCommitSnapPath!) : handleSaveCommitSnapshot}
                  disabled={commitSnapSaving}
                >
                  {commitSnapSaved ? '✓ Saved · View →' : commitSnapSaving ? 'Saving…' : '↓ Save snapshot'}
                </button>
              )}
            </div>

            {foundCommits.length === 0 ? (
              <p className="it-empty-hint">
                No commits found mentioning {[...commitSearchIds].join(', ')} in local repositories.
              </p>
            ) : (
              <CommitMentions commits={foundCommits} />
            )}
          </>
        )}
      </section>
    </div>
  );
}

interface CommitWithIssues extends Commit {
  matched_issues: string[];
}

function CommitMentions({ commits }: { commits: CommitWithIssues[] }) {
  const repoCount = useMemo(
    () => new Set(commits.map((c) => c.repository_id)).size,
    [commits],
  );

  return (
    <div className="it-commits-list">
      <p className="it-count-line">
        {commits.length} commit{commits.length !== 1 ? 's' : ''} across {repoCount} repo{repoCount !== 1 ? 's' : ''}
      </p>
      {commits.map((c) => (
        <CommitRow key={c.id} commit={c} />
      ))}
    </div>
  );
}

function CommitRow({ commit }: { commit: CommitWithIssues }) {
  const subject = highlightAll(commit.subject, commit.matched_issues);
  return (
    <div className="it-commit-row">
      <code className="it-commit-hash">{commit.commit_hash.slice(0, 8)}</code>
      <span className="it-commit-subject" dangerouslySetInnerHTML={{ __html: subject }} />
      <div className="it-commit-issues">
        {commit.matched_issues.map((id) => (
          <span key={id} className="it-state-chip">{id}</span>
        ))}
      </div>
      <span className="it-commit-author">{commit.author_name}</span>
      <span className="it-commit-date">{dayjs(commit.committed_at).format('MMM D, YYYY')}</span>
    </div>
  );
}

function highlightAll(text: string, ids: string[]): string {
  let result = escapeHtml(text);
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="it-highlight">$1</mark>');
  }
  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
