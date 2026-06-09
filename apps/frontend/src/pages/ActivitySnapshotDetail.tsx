import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import * as api from '../lib/api';
import { CommentsSection } from '../components/CommentsSection';
import { EditableTitle } from '../components/EditableTitle';
import { ActivityEventsTable } from '../components/ActivityEventsTable';
import { useAppStore } from '../store';

const PAGE_SIZE = 100;

export default function ActivitySnapshotDetail() {
  const { snapshotId } = useParams<{ snapshotId: string }>();
  const qc = useQueryClient();
  const { settings } = useAppStore();
  const ytBaseUrl = settings.issueTrackerUrl?.replace(/\/$/, '') || '';

  const { data: snap, isLoading: snapLoading } = useQuery({
    queryKey: ['activity-snapshots'],
    queryFn: () => api.listActivitySnapshots(500),
    select: (list) => list.find((s) => s.id === snapshotId),
  });

  const { data: rawData, isLoading: rawLoading } = useQuery({
    queryKey: ['snapshot-raw', snapshotId],
    queryFn: () => api.getActivitySnapshotRaw(snapshotId!),
    enabled: !!snapshotId,
    staleTime: Infinity,
  });

  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const activities = rawData?.activities ?? [];

  const filtered = activities.filter((ev) => {
    if (typeFilter !== 'all' && ev.activity_type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        ev.issue_id.toLowerCase().includes(q) ||
        ev.issue_summary?.toLowerCase().includes(q) ||
        ev.author.toLowerCase().includes(q) ||
        ev.comment_text?.toLowerCase().includes(q) ||
        ev.new_value?.toLowerCase().includes(q) ||
        ev.field?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const typeCounts = activities.reduce<Record<string, number>>((acc, ev) => {
    acc[ev.activity_type] = (acc[ev.activity_type] ?? 0) + 1;
    return acc;
  }, {});

  const ACTIVITY_TYPE_LABELS: Record<string, string> = {
    created: 'Created', resolved: 'Resolved', comment: 'Comment', field_change: 'Changed',
  };

  if (snapLoading) return <div className="page"><p>Loading…</p></div>;
  if (!snap) return (
    <div className="page">
      <p>Snapshot not found. <Link to="/summaries">Back to Reports</Link></p>
    </div>
  );

  return (
    <div className="page snap-detail-page">
      <div className="page-header">
        <Link to="/summaries" className="snap-detail-back">← Reports</Link>
        <EditableTitle
          defaultTitle={snap.source_name}
          userLabel={snap.user_label}
          onSave={async (label) => {
            await api.patchItemLabel('activity-snapshot', snap.id, label);
            qc.invalidateQueries({ queryKey: ['activity-snapshots'] });
          }}
        />
      </div>

      <div className="snap-detail-meta">
        <span className="snap-meta-pill">{snap.source_type === 'board' ? 'Board' : 'Project'}</span>
        <span>{snap.since} → {snap.until}</span>
        <span className="snap-detail-count">{snap.activity_count} events</span>
        <span className="snap-detail-saved">Saved {dayjs(snap.created_at).fromNow()}</span>
      </div>

      <div className="snap-detail-filters">
        <input
          className="input snap-detail-search"
          placeholder="Search issue, author, field…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
        />
        <div className="snap-type-chips">
          {['all', 'created', 'resolved', 'field_change', 'comment'].map((t) => {
            const count = t === 'all' ? activities.length : (typeCounts[t] ?? 0);
            if (t !== 'all' && count === 0) return null;
            return (
              <button
                key={t}
                className={`summ-chip${typeFilter === t ? ' summ-chip-active' : ''} snap-chip-${t}`}
                onClick={() => { setTypeFilter(t); }}
              >
                {t === 'all' ? 'All' : ACTIVITY_TYPE_LABELS[t] ?? t}
                <span className="summ-chip-count">{count}</span>
              </button>
            );
          })}
        </div>
        {filtered.length !== activities.length && (
          <span className="snap-detail-filtered">{filtered.length} matching</span>
        )}
      </div>

      {rawLoading ? (
        <div className="empty-state"><p>Loading events…</p></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state"><p>No events match the current filter.</p></div>
      ) : (
        <ActivityEventsTable
          events={filtered}
          ytBaseUrl={ytBaseUrl}
          pageSize={PAGE_SIZE}
          extraClass="snap-detail-events"
        />
      )}

      <div className="snap-detail-comments">
        <CommentsSection summaryType="activity-snapshot" summaryId={snap.id} />
      </div>
    </div>
  );
}
