/** Presentational components for Activity Flow. Pure props-in/JSX-out. */

import { useMemo } from 'react';
import dayjs from 'dayjs';
import type { ActivityItem } from '../../lib/api';
import { renderMarkdown } from '../../components/SummaryPanel';
import { userUrl, issueUrl } from '../../lib/youtrackLinks';
import {
  classifyItem,
  TYPE_KEYS,
  TYPE_LABEL,
  type FetchProgress,
  type LogEntry,
  type Scope,
  type TypeKey,
  type UnifiedSummary,
} from './types';


export function IssueLink({
  issueId, ytBase, className,
}: {
  issueId: string;
  ytBase: string | null;
  className?: string;
}) {
  const href = issueUrl(ytBase, issueId);
  if (!href) return <span className={className}>{issueId}</span>;
  return (
    <a href={href} target="_blank" rel="noopener" className={className}>
      {issueId}
    </a>
  );
}

export function AuthorLink({
  author, login, ytBase, className,
}: {
  author: string;
  login: string | null;
  ytBase: string | null;
  className?: string;
}) {
  const href = userUrl(ytBase, login);
  if (!href) return <span className={className}>{author}</span>;
  return (
    <a href={href} target="_blank" rel="noopener" className={className}>
      {author}
    </a>
  );
}


export function EventRow({
  item, compact = false, ytBase,
}: {
  item: ActivityItem;
  compact?: boolean;
  ytBase: string | null;
}) {
  const time = dayjs(item.timestamp).format(compact ? 'MMM D · HH:mm' : 'HH:mm');
  const type = classifyItem(item);
  const icon = ICONS[type];

  const body = renderEventBody(item);

  return (
    <div className={`pf-event pf-event-${type}`}>
      <span className="pf-event-time">{time}</span>
      <span className={`pf-event-icon pf-event-icon-${type}`}>{icon}</span>
      {!compact && <IssueLink issueId={item.issue_id} ytBase={ytBase} className="pf-event-issue" />}
      <span className="pf-event-body">{body}</span>
      {item.author && (
        <AuthorLink
          author={item.author}
          login={item.author_login}
          ytBase={ytBase}
          className="pf-event-author"
        />
      )}
    </div>
  );
}

const ICONS: Record<TypeKey, string> = {
  created: '＋',
  resolved: '✓',
  comment: '💬',
  state: '⇌',
  assignee: '👤',
  other: '·',
};

function renderEventBody(item: ActivityItem): React.ReactNode {
  if (item.activity_type === 'created') {
    return <>created: <span className="pf-event-text">{item.issue_summary}</span></>;
  }
  if (item.activity_type === 'resolved') return <>resolved</>;
  if (item.activity_type === 'comment') {
    return (
      <>
        commented{item.comment_text
          ? <>: <span className="pf-event-text">{item.comment_text}</span></>
          : null}
      </>
    );
  }
  if (item.activity_type === 'field_change') {
    const from = item.old_value || '∅';
    const to = item.new_value || '∅';
    return (
      <>
        <span className="pf-event-field">{item.field}</span>:{' '}
        <span className="pf-state-chip pf-state-chip-sm">{from}</span> →{' '}
        <span className="pf-state-chip pf-state-chip-sm">{to}</span>
      </>
    );
  }
  return <>{item.activity_type}</>;
}


export function TimelineView({
  items, ytBase,
}: {
  items: ActivityItem[];
  ytBase: string | null;
}) {
  const groups = useMemo(() => groupByDay(items), [items]);

  return (
    <div className="pf-timeline">
      {groups.map((g) => (
        <div key={g.day} className="pf-day">
          <div className="pf-day-header">
            <span className="pf-day-date">{dayjs(g.day).format('dddd, MMM D')}</span>
            <span className="pf-day-count">
              {g.items.length} event{g.items.length !== 1 ? 's' : ''}
            </span>
          </div>
          {g.items.map((it, i) => <EventRow key={i} item={it} ytBase={ytBase} />)}
        </div>
      ))}
    </div>
  );
}

function groupByDay(items: ActivityItem[]): { day: string; items: ActivityItem[] }[] {
  const m = new Map<string, ActivityItem[]>();
  for (const it of items) {
    const day = dayjs(it.timestamp).format('YYYY-MM-DD');
    const arr = m.get(day);
    if (arr) arr.push(it);
    else m.set(day, [it]);
  }
  return Array.from(m.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, arr]) => ({
      day,
      items: arr.sort((a, b) => b.timestamp - a.timestamp),
    }));
}


export function ByIssueView({
  items, ytBase,
}: {
  items: ActivityItem[];
  ytBase: string | null;
}) {
  const issues = useMemo(() => groupByIssue(items), [items]);

  return (
    <div className="pf-issues">
      {issues.map((iss) => {
        const stateFlow = iss.items
          .filter((it) =>
            it.activity_type === 'field_change' &&
            (it.field || '').toLowerCase() === 'state',
          )
          .map((it) => ({ from: it.old_value, to: it.new_value }));
        return (
          <div key={iss.id} className="pf-issue-card">
            <div className="pf-issue-head">
              <IssueLink issueId={iss.id} ytBase={ytBase} className="pf-issue-id" />
              <span className="pf-issue-summary">{iss.summary}</span>
              <span className="pf-issue-count">
                {iss.items.length} event{iss.items.length !== 1 ? 's' : ''}
              </span>
            </div>
            {stateFlow.length > 0 && (
              <div className="pf-state-flow">
                <span className="pf-state-flow-label">Flow:</span>
                {renderStateFlow(stateFlow)}
              </div>
            )}
            <div className="pf-issue-timeline">
              {iss.items.map((it, i) => (
                <EventRow key={i} item={it} compact ytBase={ytBase} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function groupByIssue(items: ActivityItem[]) {
  const m = new Map<string, ActivityItem[]>();
  for (const it of items) {
    const arr = m.get(it.issue_id);
    if (arr) arr.push(it);
    else m.set(it.issue_id, [it]);
  }
  return Array.from(m.entries())
    .map(([id, arr]) => ({
      id,
      summary: arr[0]?.issue_summary || '',
      items: arr.sort((a, b) => a.timestamp - b.timestamp), // oldest-first for lifecycle
      lastTs: Math.max(...arr.map((a) => a.timestamp)),
    }))
    .sort((a, b) => b.lastTs - a.lastTs);
}

function renderStateFlow(
  flow: { from: string | null; to: string | null }[],
): React.ReactNode {
  if (flow.length === 0) return null;
  const nodes: React.ReactNode[] = [];
  nodes.push(<span key="s0" className="pf-state-chip">{flow[0].from || '∅'}</span>);
  flow.forEach((step, i) => {
    nodes.push(<span key={`a${i}`} className="pf-state-arrow">→</span>);
    nodes.push(
      <span key={`s${i + 1}`} className="pf-state-chip">{step.to || '∅'}</span>,
    );
  });
  return nodes;
}


export function SummaryStrip({
  total, issuesTouched, created, resolved, since, until, label, scope,
}: {
  total: number;
  issuesTouched: number;
  created: number;
  resolved: number;
  since: string;
  until: string;
  label: string;
  scope: Scope;
}) {
  // No "top contributor" metric: activity is team progress, not ranking.
  return (
    <div className="pf-strip">
      <div className="pf-strip-title">
        <span className={`pf-strip-scope pf-strip-scope-${scope}`}>
          {scope === 'board' ? 'Board' : 'Project'}
        </span>
        <strong>{label}</strong>
        <span className="pf-strip-period">
          {dayjs(since).format('MMM D')} – {dayjs(until).format('MMM D, YYYY')}
        </span>
      </div>
      <div className="pf-strip-metrics">
        <StripMetric label="Events" value={total} />
        <StripMetric label="Issues touched" value={issuesTouched} />
        <StripMetric label="Created" value={created} tone="added" />
        <StripMetric label="Resolved" value={resolved} tone="resolved" />
      </div>
    </div>
  );
}

function StripMetric({
  label, value, tone,
}: {
  label: string;
  value: number | string;
  tone?: 'added' | 'resolved';
}) {
  return (
    <div className={`pf-metric${tone ? ' pf-metric-' + tone : ''}`}>
      <div className="pf-metric-value">{value}</div>
      <div className="pf-metric-label">{label}</div>
    </div>
  );
}


export function TypeFilterChips({
  counts, enabled, onToggle, onAll, onNone,
}: {
  counts: Record<TypeKey, number>;
  enabled: Set<TypeKey>;
  onToggle: (k: TypeKey) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  return (
    <div className="pf-filters">
      <span className="pf-filters-label">Show:</span>
      {TYPE_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className={`pf-filter-chip pf-filter-${k}${enabled.has(k) ? ' active' : ''}`}
          onClick={() => onToggle(k)}
          disabled={counts[k] === 0}
          title={counts[k] === 0
            ? 'No events of this type'
            : `${counts[k]} event${counts[k] !== 1 ? 's' : ''}`}
        >
          {TYPE_LABEL[k]} <span className="pf-filter-count">{counts[k]}</span>
        </button>
      ))}
      <div className="pf-filters-actions">
        <button type="button" className="pf-filter-link" onClick={onAll}>all</button>
        <span className="pf-filter-sep">/</span>
        <button type="button" className="pf-filter-link" onClick={onNone}>none</button>
      </div>
    </div>
  );
}


export function FetchProgressBar({
  progress, label, onCancel,
}: {
  progress: FetchProgress | null;
  label: string | null;
  onCancel: () => void;
}) {
  const phase = progress?.phase ?? 'starting';
  const phaseLabel = describePhase(phase, progress);
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;

  return (
    <div className="pf-progress">
      <div className="pf-progress-line">
        <span className="pf-progress-spinner" aria-hidden />
        <span className="pf-progress-label">
          {label ? <><strong>{label}</strong> · </> : null}
          {phaseLabel}
          {progress && progress.events_so_far > 0 ? (
            <span className="pf-progress-sub"> · {progress.events_so_far} events so far</span>
          ) : null}
        </span>
        <button className="btn btn-sm btn-danger" onClick={onCancel}>Cancel</button>
      </div>
      <div className="pf-progress-track">
        <div
          className={`pf-progress-fill${pct === null ? ' indeterminate' : ''}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      {pct !== null && <div className="pf-progress-pct">{pct}%</div>}
    </div>
  );
}

function describePhase(phase: string, progress: FetchProgress | null): string {
  switch (phase) {
    case 'starting': return 'Contacting YouTrack…';
    case 'listing_issues': return 'Listing issues…';
    case 'fetching_activities':
      return progress && progress.total > 0
        ? `Gathering activity · ${progress.done} of ${progress.total} issues`
        : 'Gathering activity…';
    case 'generating': return 'Generating summary…';
    case 'cancelled': return 'Cancelling…';
    default: return `Working… (${phase})`;
  }
}


export function SummaryCard({ summary }: { summary: UnifiedSummary }) {
  return (
    <article className="yt-summary-card">
      <header className="yt-summary-header">
        <div className="yt-summary-meta">
          <span className={`yt-summary-tag yt-summary-tag-${summary.summary_style}`}>
            {summary.summary_style}
          </span>
          <span className="yt-summary-sub">
            {summary.label} · {summary.activity_count} event{summary.activity_count !== 1 ? 's' : ''}
            {' · '}{summary.since} → {summary.until} · {summary.model_name}
          </span>
        </div>
        {!summary.used_llm && (
          <span
            className="yt-summary-fallback"
            title="Ollama was unreachable — deterministic fallback summary"
          >
            fallback
          </span>
        )}
      </header>
      <div
        className="summary-markdown"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.summary_markdown, null) }}
      />
    </article>
  );
}


export function RequestLog({
  logs, open, onToggle, onClear,
}: {
  logs: LogEntry[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
}) {
  if (logs.length === 0 && !open) return null;
  return (
    <div className={`pf-log${open ? ' open' : ''}`}>
      <button type="button" className="pf-log-header" onClick={onToggle}>
        <span className="pf-log-chevron">{open ? '▾' : '▸'}</span>
        <span className="pf-log-title">Request log</span>
        <span className="pf-log-count">
          {logs.length} event{logs.length !== 1 ? 's' : ''}
        </span>
        {logs.length > 0 && (
          <span
            className="pf-log-clear"
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                onClear();
              }
            }}
          >
            clear
          </span>
        )}
      </button>
      {open && (
        <div className="pf-log-body">
          {logs.length === 0 ? (
            <div className="pf-log-empty">
              No events yet. Pick a source and press <strong>Fetch</strong>.
            </div>
          ) : (
            logs.map((entry, i) => (
              <div key={i} className={`pf-log-row pf-log-${entry.level}`}>
                <span className="pf-log-ts">{formatTs(entry.ts)}</span>
                <span className="pf-log-level">{entry.level}</span>
                <span className="pf-log-msg">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad2 = (n: number) => n.toString().padStart(2, '0');
  const pad3 = (n: number) => n.toString().padStart(3, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}
