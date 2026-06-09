import { useState, useEffect } from 'react';
import dayjs from 'dayjs';
import type { ActivityItem } from '../lib/api';

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  created: 'Created',
  resolved: 'Resolved',
  comment: 'Comment',
  field_change: 'Changed',
};

interface Props {
  events: ActivityItem[];
  ytBaseUrl: string;
  pageSize?: number;
  compact?: boolean;
  extraClass?: string;
}

export function ActivityEventsTable({
  events,
  ytBaseUrl,
  pageSize = 100,
  compact = false,
  extraClass = '',
}: Props) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [events]);

  const pageCount = Math.ceil(events.length / pageSize);
  const visible = events.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <>
      <div className={`snap-events${extraClass ? ' ' + extraClass : ''}`}>
        <table className="snap-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Issue</th>
              <th>Author</th>
              <th>Type</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((ev, i) => (
              <tr key={i} className={`snap-row snap-row-${ev.activity_type}`}>
                <td className="snap-ts">{dayjs(ev.timestamp).format('MMM D, HH:mm')}</td>
                <td className="snap-issue">
                  {ytBaseUrl ? (
                    <a
                      className="snap-issue-id"
                      href={`${ytBaseUrl}/issue/${ev.issue_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {ev.issue_id}
                    </a>
                  ) : (
                    <span className="snap-issue-id">{ev.issue_id}</span>
                  )}
                  {ev.issue_summary && (
                    <span className="snap-issue-title" title={ev.issue_summary}>
                      {compact && ev.issue_summary.length > 50
                        ? ev.issue_summary.slice(0, 48) + '…'
                        : ev.issue_summary}
                    </span>
                  )}
                </td>
                <td className="snap-author">{ev.author}</td>
                <td className="snap-type">
                  <span className={`snap-type-badge snap-type-${ev.activity_type}`}>
                    {ACTIVITY_TYPE_LABELS[ev.activity_type] ?? ev.activity_type}
                  </span>
                </td>
                <td className="snap-detail">
                  {ev.activity_type === 'comment' && ev.comment_text ? (
                    <span className="snap-comment-text">
                      {compact && ev.comment_text.length > 100
                        ? ev.comment_text.slice(0, 100) + '…'
                        : ev.comment_text}
                    </span>
                  ) : ev.activity_type === 'field_change' ? (
                    <span>
                      {ev.field}:{' '}
                      <span className="snap-old">{ev.old_value ?? '—'}</span>
                      {' → '}
                      <span className="snap-new">{ev.new_value ?? '—'}</span>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="snap-pager">
          <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
          <span className="snap-pager-label">{page + 1} / {pageCount} ({events.length} events)</span>
          <button className="btn btn-sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </div>
      )}
    </>
  );
}
