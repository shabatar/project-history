import { useState, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import type { Commit, Repository } from '../types';

// ── Category inference ──

type CommitCategory = 'feature' | 'fix' | 'refactor' | 'docs' | 'chore';

const CATEGORY_RULES: [RegExp, CommitCategory][] = [
  [/^fix[\s(:]/i, 'fix'],
  [/^bug[\s(:]/i, 'fix'],
  [/^hotfix[\s(:]/i, 'fix'],
  [/^feat[\s(:]/i, 'feature'],
  [/^add[\s]/i, 'feature'],
  [/^implement[\s]/i, 'feature'],
  [/^refactor[\s(:]/i, 'refactor'],
  [/^restructur/i, 'refactor'],
  [/^clean[\s]?up/i, 'refactor'],
  [/^docs?[\s(:]/i, 'docs'],
  [/^readme/i, 'docs'],
  [/^update[\s]?doc/i, 'docs'],
  [/^chore[\s(:]/i, 'chore'],
  [/^ci[\s(:]/i, 'chore'],
  [/^build[\s(:]/i, 'chore'],
  [/^deps?[\s(:]/i, 'chore'],
  [/^bump[\s]/i, 'chore'],
  [/^test[\s(:]/i, 'chore'],
  [/^style[\s(:]/i, 'chore'],
];

function inferCategory(subject: string): CommitCategory | null {
  for (const [re, cat] of CATEGORY_RULES) {
    if (re.test(subject)) return cat;
  }
  return null;
}

const CATEGORY_CONFIG: Record<CommitCategory, { label: string; className: string }> = {
  feature: { label: 'feat', className: 'badge-feature' },
  fix: { label: 'fix', className: 'badge-fix' },
  refactor: { label: 'refac', className: 'badge-refactor' },
  docs: { label: 'docs', className: 'badge-docs' },
  chore: { label: 'chore', className: 'badge-chore' },
};

// ── Sort ──

type SortKey = 'hash' | 'subject' | 'author' | 'date' | 'repo';
type SortDir = 'asc' | 'desc';

function compareCommits(a: Commit, b: Commit, key: SortKey, dir: SortDir): number {
  let cmp = 0;
  switch (key) {
    case 'hash':
      cmp = a.commit_hash.localeCompare(b.commit_hash);
      break;
    case 'subject':
      cmp = a.subject.localeCompare(b.subject);
      break;
    case 'author':
      cmp = a.author_name.localeCompare(b.author_name);
      break;
    case 'date':
      cmp = a.committed_at.localeCompare(b.committed_at);
      break;
    case 'repo':
      cmp = a.repository_id.localeCompare(b.repository_id);
      break;
  }
  return dir === 'asc' ? cmp : -cmp;
}

// ── Day grouping ──

interface DayGroup {
  day: string;
  commits: Commit[];
}

function groupByDay(commits: Commit[]): DayGroup[] {
  const map = new Map<string, Commit[]>();
  for (const c of commits) {
    const day = dayjs(c.committed_at).format('YYYY-MM-DD');
    const arr = map.get(day);
    if (arr) arr.push(c);
    else map.set(day, [c]);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, cs]) => ({ day, commits: cs }));
}

// ── Component ──

interface Props {
  commits: Commit[];
  loading?: boolean;
  onSelectionCopy?: (text: string) => void;
  showRepoColumn?: boolean;
  repoMap?: Map<string, Repository>;
  compact?: boolean;
}

export default function CommitTable({
  commits,
  loading,
  onSelectionCopy,
  showRepoColumn,
  repoMap,
  compact,
}: Props) {
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set());

  const colSpan = (showRepoColumn ? 3 : 2); // checkbox + repo? + main

  // Filter
  const filtered = useMemo(() => {
    if (!searchText.trim()) return commits;
    const q = searchText.trim().toLowerCase();
    return commits.filter(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.body.toLowerCase().includes(q) ||
        c.commit_hash.toLowerCase().startsWith(q) ||
        c.author_name.toLowerCase().includes(q),
    );
  }, [commits, searchText]);

  // Sort
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => compareCommits(a, b, sortKey, sortDir)),
    [filtered, sortKey, sortDir],
  );

  // Day groups
  const dayGroups = useMemo(() => groupByDay(sorted), [sorted]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'date' ? 'desc' : 'asc');
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  }

  // Selection
  const toggleSelect = useCallback((hash: string) => {
    setSelectedHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }, []);

  function handleCopySelection() {
    const selected = sorted.filter((c) => selectedHashes.has(c.commit_hash));
    if (selected.length === 0) return;
    const text = selected
      .map(
        (c) =>
          `- [${c.commit_hash.slice(0, 7)}] ${c.subject} (${c.author_name}, ${dayjs(c.committed_at).format('YYYY-MM-DD')})`,
      )
      .join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
    onSelectionCopy?.(text);
  }

  if (loading) {
    return <div className="empty-state">Loading...</div>;
  }

  if (commits.length === 0) {
    return (
      <div className="empty-state">
        <p>No commits found.</p>
      </div>
    );
  }

  return (
    <div className={compact ? 'ct-compact' : ''}>
      {/* ── Search ── */}
      <div className="ct-search-row">
        <input
          type="text"
          className="input ct-search"
          placeholder="Search commits..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />
        {searchText && (
          <span className="ce-count">{filtered.length}/{commits.length}</span>
        )}
      </div>

      {/* ── Selection bar ── */}
      {selectedHashes.size > 0 && (
        <div className="commit-selection-bar">
          <span>{selectedHashes.size} selected</span>
          <button className="btn btn-sm btn-primary" onClick={handleCopySelection}>
            Copy
          </button>
          <button className="btn btn-sm" onClick={() => setSelectedHashes(new Set())}>
            Clear
          </button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="commit-table-wrapper">
        <table className="commit-table">
          <thead>
            <tr>
              <th className="commit-col-select">
                <input
                  type="checkbox"
                  checked={sorted.length > 0 && selectedHashes.size === sorted.length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedHashes(new Set(sorted.map((c) => c.commit_hash)));
                    } else {
                      setSelectedHashes(new Set());
                    }
                  }}
                  title="Select all"
                />
              </th>
              {showRepoColumn && (
                <th className="commit-col-sortable" onClick={() => handleSort('repo')}>
                  Repo{sortIndicator('repo')}
                </th>
              )}
              <th className="ct-header-main">
                <span className="commit-col-sortable" onClick={() => handleSort('date')}>
                  Date{sortIndicator('date')}
                </span>
                <span className="commit-col-sortable" onClick={() => handleSort('subject')}>
                  Message{sortIndicator('subject')}
                </span>
                <span className="commit-col-sortable" onClick={() => handleSort('author')}>
                  Author{sortIndicator('author')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {dayGroups.map((group) => (
              <DayGroupRows
                key={group.day}
                group={group}
                expandedSha={expandedSha}
                selectedHashes={selectedHashes}
                onToggleExpand={setExpandedSha}
                onToggleSelect={toggleSelect}
                showRepoColumn={showRepoColumn}
                repoMap={repoMap}
                colSpan={colSpan}
              />
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={colSpan} style={{ textAlign: 'center', padding: 20, color: 'var(--text)' }}>
                  No matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Day group ──

function DayGroupRows({
  group,
  expandedSha,
  selectedHashes,
  onToggleExpand,
  onToggleSelect,
  showRepoColumn,
  repoMap,
  colSpan,
}: {
  group: DayGroup;
  expandedSha: string | null;
  selectedHashes: Set<string>;
  onToggleExpand: (sha: string | null) => void;
  onToggleSelect: (hash: string) => void;
  showRepoColumn?: boolean;
  repoMap?: Map<string, Repository>;
  colSpan: number;
}) {
  return (
    <>
      <tr className="day-group-header">
        <td colSpan={colSpan}>
          <span className="day-group-label">
            {dayjs(group.day).format('ddd, MMM D')}
          </span>
          <span className="day-group-count">{group.commits.length}</span>
        </td>
      </tr>
      {group.commits.map((commit) => {
        const isExpanded = expandedSha === commit.commit_hash;
        const isSelected = selectedHashes.has(commit.commit_hash);
        const category = inferCategory(commit.subject);

        return (
          <tr
            key={commit.commit_hash}
            className={`ct-row${isExpanded ? ' commit-expanded' : ''}${isSelected ? ' commit-selected' : ''}`}
            onClick={() => onToggleExpand(isExpanded ? null : commit.commit_hash)}
          >
            <td className="commit-col-select" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggleSelect(commit.commit_hash)}
              />
            </td>
            {showRepoColumn && (
              <td className="ct-repo-cell">
                {repoMap?.get(commit.repository_id)?.name ?? '?'}
              </td>
            )}
            <td className="ct-main-cell">
              <div className="ct-commit-line">
                <span className="commit-sha">{commit.commit_hash.slice(0, 7)}</span>
                {category && (
                  <span className={`commit-badge ${CATEGORY_CONFIG[category].className}`}>
                    {CATEGORY_CONFIG[category].label}
                  </span>
                )}
                <span className="commit-message" title={commit.subject}>
                  {commit.subject}
                </span>
                <span className="commit-author">{commit.author_name}</span>
                <span className="commit-date">{dayjs(commit.committed_at).format('HH:mm')}</span>
              </div>
              {isExpanded && (
                <div className="commit-detail">
                  {commit.body && (
                    <pre className="commit-body">{commit.body}</pre>
                  )}
                  <div className="commit-detail-meta">
                    <span><code>{commit.commit_hash}</code></span>
                    <span>{commit.author_email}</span>
                  </div>
                </div>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}
