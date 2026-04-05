import { useState, useMemo, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUrlParams } from '../lib/useUrlParams';
import { useRepositories, useCommits } from '../lib/hooks';
import * as api from '../lib/api';
import DateRangePicker from '../components/DateRangePicker';
import CommitTable from '../components/CommitTable';
import type { Commit, Repository } from '../types';

type ViewMode = 'merged' | 'side-by-side';

/**
 * Fire-and-forget: parse commits from git for a repo+date range.
 * Tracked by a ref so each combo only fires once.
 * On completion, invalidates the commits query so useCommits refetches.
 */
function useAutoParseOnce(
  repoId: string | null,
  dateRange: { from: string; to: string },
) {
  const qc = useQueryClient();
  const parsedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!repoId) return;
    const key = `${repoId}:${dateRange.from}:${dateRange.to}`;
    if (parsedRef.current.has(key)) return;
    if (parsedRef.current.size >= 100) {
      // Drop the oldest entry to prevent unbounded growth
      const oldest = parsedRef.current.values().next().value;
      parsedRef.current.delete(oldest!);
    }
    parsedRef.current.add(key);

    api
      .parseCommits(repoId, dateRange.from, dateRange.to)
      .then(() => {
        qc.invalidateQueries({ queryKey: ['commits'] });
        qc.invalidateQueries({ queryKey: ['repositories'] });
      })
      .catch(() => {
        // silently ignore — user will see empty commits
      });
  }, [repoId, dateRange.from, dateRange.to]);
}

export default function CommitExplorer() {
  const { selectedRepoId, setSelectedRepoId, dateRange, setDateRange } =
    useUrlParams();

  const { data: repos = [] } = useRepositories();
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(() =>
    selectedRepoId ? new Set([selectedRepoId]) : new Set(),
  );
  const [viewMode, setViewMode] = useState<ViewMode>('merged');
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup copy timeout on unmount
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (selectedRepoId && selectedRepoIds.size === 0) {
      setSelectedRepoIds(new Set([selectedRepoId]));
    }
  }, [selectedRepoId]);

  const isMultiRepo = selectedRepoIds.size > 1;

  const repoMap = useMemo(() => {
    const m = new Map<string, Repository>();
    for (const r of repos) m.set(r.id, r);
    return m;
  }, [repos]);

  function toggleRepo(id: string) {
    setSelectedRepoIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      const first = Array.from(next)[0];
      setSelectedRepoId(first ?? null);
      return next;
    });
  }

  function handleCopy() {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    setCopyMsg('Copied!');
    copyTimerRef.current = setTimeout(() => setCopyMsg(null), 1500);
  }

  const clonedRepos = useMemo(() => repos.filter((r) => r.last_synced_at), [repos]);
  const selectedIds = useMemo(() => Array.from(selectedRepoIds), [selectedRepoIds]);

  return (
    <div className="page">
      <div className="page-header">
        <h2>Commits</h2>
      </div>

      <div className="toolbar">
        <div className="ce-repo-picker">
          <span className="toolbar-label">Repos</span>
          <div className="ce-repo-chips">
            {clonedRepos.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`ce-repo-chip${selectedRepoIds.has(r.id) ? ' active' : ''}`}
                onClick={() => toggleRepo(r.id)}
              >
                {r.name}
              </button>
            ))}
            {clonedRepos.length === 0 && (
              <span className="ce-no-repos">No cloned repos</span>
            )}
          </div>
        </div>

        <DateRangePicker value={dateRange} onChange={setDateRange} />

        {isMultiRepo && (
          <div className="ce-view-toggle">
            <button
              className={`btn btn-sm${viewMode === 'merged' ? ' btn-primary' : ''}`}
              onClick={() => setViewMode('merged')}
            >
              Merged
            </button>
            <button
              className={`btn btn-sm${viewMode === 'side-by-side' ? ' btn-primary' : ''}`}
              onClick={() => setViewMode('side-by-side')}
            >
              Side by side
            </button>
          </div>
        )}
      </div>

      {copyMsg && <div className="success-banner">{copyMsg}</div>}

      {selectedRepoIds.size === 0 ? (
        <div className="empty-state">
          <p>Pick one or more repositories above.</p>
        </div>
      ) : isMultiRepo && viewMode === 'side-by-side' ? (
        <div className="ce-side-by-side">
          {selectedIds.map((id) => (
            <SideBySidePanel
              key={id}
              repoId={id}
              repoName={repoMap.get(id)?.name ?? id.slice(0, 8)}
              dateRange={dateRange}
              onCopy={handleCopy}
            />
          ))}
        </div>
      ) : (
        <MergedView
          repoIds={selectedIds}
          repoMap={repoMap}
          dateRange={dateRange}
          onCopy={handleCopy}
        />
      )}
    </div>
  );
}

/* ── Merged view ── */

function MergedView({
  repoIds,
  repoMap,
  dateRange,
  onCopy,
}: {
  repoIds: string[];
  repoMap: Map<string, Repository>;
  dateRange: { from: string; to: string };
  onCopy: () => void;
}) {
  const MAX_SLOTS = 6;
  const slots: (string | null)[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    slots.push(repoIds[i] ?? null);
  }

  // Fire-and-forget parse for each slot
  useAutoParseOnce(slots[0], dateRange);
  useAutoParseOnce(slots[1], dateRange);
  useAutoParseOnce(slots[2], dateRange);
  useAutoParseOnce(slots[3], dateRange);
  useAutoParseOnce(slots[4], dateRange);
  useAutoParseOnce(slots[5], dateRange);

  // Query commits (only loading state that matters)
  const r0 = useCommits(slots[0], dateRange.from, dateRange.to);
  const r1 = useCommits(slots[1], dateRange.from, dateRange.to);
  const r2 = useCommits(slots[2], dateRange.from, dateRange.to);
  const r3 = useCommits(slots[3], dateRange.from, dateRange.to);
  const r4 = useCommits(slots[4], dateRange.from, dateRange.to);
  const r5 = useCommits(slots[5], dateRange.from, dateRange.to);
  const results = [r0, r1, r2, r3, r4, r5];

  const allCommits = useMemo(() => {
    const merged: Commit[] = [];
    for (let i = 0; i < repoIds.length && i < MAX_SLOTS; i++) {
      if (results[i].data) merged.push(...results[i].data!);
    }
    return merged;
  }, [repoIds.length, r0.data, r1.data, r2.data, r3.data, r4.data, r5.data]);

  const loading = results.some((r, i) => i < repoIds.length && r.isLoading);
  const showRepoColumn = repoIds.length > 1;

  return (
    <>
      {allCommits.length > 0 && !loading && (
        <div className="ce-actions-row">
          <span className="ce-count">{allCommits.length} commits</span>
        </div>
      )}

      <CommitTable
        commits={allCommits}
        loading={loading}
        onSelectionCopy={onCopy}
        showRepoColumn={showRepoColumn}
        repoMap={repoMap}
      />
    </>
  );
}

/* ── Side-by-side panel ── */

function SideBySidePanel({
  repoId,
  repoName,
  dateRange,
  onCopy,
}: {
  repoId: string;
  repoName: string;
  dateRange: { from: string; to: string };
  onCopy: () => void;
}) {
  useAutoParseOnce(repoId, dateRange);
  const { data: commits = [], isLoading } = useCommits(
    repoId,
    dateRange.from,
    dateRange.to,
  );

  return (
    <div className="ce-panel">
      <div className="ce-panel-header">
        <span className="ce-panel-name">{repoName}</span>
        <span className="ce-count">{isLoading ? '...' : commits.length}</span>
      </div>
      <CommitTable
        commits={commits}
        loading={isLoading}
        onSelectionCopy={onCopy}
        compact
      />
    </div>
  );
}
