import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import * as api from '../lib/api';
import { CommentsSection } from '../components/CommentsSection';
import { EditableTitle } from '../components/EditableTitle';
import { TimelineView, ByIssueView } from './activity-flow/components';
import { CollapsibleSection } from '../components/ReportContent';
import { MultiTextFilter, matchesTerms } from '../components/MultiTextFilter';
import { activityItemsToText } from '../lib/activityText';
import { usePersistentState } from '../lib/usePersistentState';
import { useAppStore } from '../store';


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

  const [view, setView] = useState<'timeline' | 'by-issue' | null>(null);
  // Filter settings persist per snapshot.
  const [typeFilter, setTypeFilter] = usePersistentState<string>(
    snapshotId ? `snap-type:${snapshotId}` : null, 'all',
  );
  const [terms, setTerms] = usePersistentState<string[]>(
    snapshotId ? `snap-filter:${snapshotId}` : null, [],
  );

  const activities = rawData?.activities ?? [];

  const filtered = activities.filter((ev) => {
    if (typeFilter !== 'all' && ev.activity_type !== typeFilter) return false;
    // OR across include terms, minus any "-" exclusions, over the event's fields.
    const hay = [
      ev.issue_id, ev.issue_summary, ev.author, ev.comment_text, ev.old_value, ev.new_value, ev.field,
    ].filter(Boolean).join(' ');
    return matchesTerms(hay, terms);
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
        <MultiTextFilter
          className="snap-detail-search"
          placeholder="Filter… (Enter to add, -term to exclude)"
          chips={terms}
          onChange={setTerms}
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
        <div className="pf-view-toggle" style={{ marginLeft: 'auto' }}>
          <button
            className={`pf-view-btn${(view ?? snap.view_mode) === 'timeline' ? ' active' : ''}`}
            onClick={() => setView('timeline')}
          >
            Timeline
          </button>
          <button
            className={`pf-view-btn${(view ?? snap.view_mode) === 'by-issue' ? ' active' : ''}`}
            onClick={() => setView('by-issue')}
          >
            By issue
          </button>
        </div>
      </div>

      {rawLoading ? (
        <div className="empty-state"><p>Loading events…</p></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state"><p>No events match the current filter.</p></div>
      ) : (
        <CollapsibleSection
          copyText={activityItemsToText(filtered)}
          collapsedNote={`${filtered.length} event${filtered.length !== 1 ? 's' : ''} collapsed — click Expand to show.`}
        >
          {(view ?? snap.view_mode) === 'by-issue' ? (
            <ByIssueView items={filtered} ytBase={ytBaseUrl} />
          ) : (
            <TimelineView items={filtered} ytBase={ytBaseUrl} />
          )}
        </CollapsibleSection>
      )}

      <div className="snap-detail-comments">
        <CommentsSection
          summaryType="activity-snapshot"
          summaryId={snap.id}
          generateParams={{ filter: terms, type: typeFilter !== 'all' ? typeFilter : undefined }}
        />
      </div>
    </div>
  );
}
