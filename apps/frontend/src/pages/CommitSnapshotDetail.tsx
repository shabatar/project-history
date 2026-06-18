import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import * as api from '../lib/api';
import { CommentsSection } from '../components/CommentsSection';
import { EditableTitle } from '../components/EditableTitle';
import { CommitSnapshotTable } from '../components/CommitSnapshotTable';
import { CollapsibleSection } from '../components/ReportContent';
import { MultiTextFilter, matchesTerms } from '../components/MultiTextFilter';
import { usePersistentState } from '../lib/usePersistentState';

export default function CommitSnapshotDetail() {
  const { snapshotId } = useParams<{ snapshotId: string }>();
  const qc = useQueryClient();

  const { data: snap, isLoading: snapLoading } = useQuery({
    queryKey: ['commit-snapshots'],
    queryFn: () => api.listCommitSnapshots(undefined, 500),
    select: (list) => list.find((s) => s.id === snapshotId),
  });

  const { data: rawData, isLoading: rawLoading } = useQuery({
    queryKey: ['commit-snapshot-raw', snapshotId],
    queryFn: () => api.getCommitSnapshotRaw(snapshotId!),
    enabled: !!snapshotId,
    staleTime: Infinity,
  });

  const [terms, setTerms] = usePersistentState<string[]>(
    snapshotId ? `commit-snap-filter:${snapshotId}` : null, [],
  );

  const commits = rawData?.commits ?? [];

  const filtered = commits.filter((c) =>
    matchesTerms(
      // Include the date (ISO + display formats) so a date substring filters too.
      `${c.subject} ${c.author_name} ${c.commit_hash} ${c.committed_at ? dayjs(c.committed_at).format('YYYY-MM-DD MMM D, YYYY HH:mm') : ''}`,
      terms,
    ),
  );

  if (snapLoading) return <div className="page"><p>Loading…</p></div>;
  if (!snap) return (
    <div className="page">
      <p>Snapshot not found. <Link to="/summaries">Back to Reports</Link></p>
    </div>
  );

  const title = snap.branch
    ? `${snap.branch} vs ${snap.base_branch || 'default'}`
    : snap.since && snap.until
      ? `${dayjs(snap.since).format('MMM D')} – ${dayjs(snap.until).format('MMM D, YYYY')}`
      : 'Commit snapshot';

  return (
    <div className="page snap-detail-page">
      <div className="page-header">
        <Link to="/summaries" className="snap-detail-back">← Reports</Link>
        <EditableTitle
          defaultTitle={snap.repo_name}
          userLabel={snap.user_label}
          onSave={async (label) => {
            await api.patchItemLabel('git-snapshot', snap.id, label);
            qc.invalidateQueries({ queryKey: ['commit-snapshots'] });
          }}
        />
      </div>

      <div className="snap-detail-meta">
        <span className="snap-meta-pill">Commit snapshot</span>
        <span>{title}</span>
        <span className="snap-detail-count">{snap.commit_count} commits</span>
        <span className="snap-detail-saved">Saved {dayjs(snap.created_at).fromNow()}</span>
      </div>

      <div className="snap-detail-filters">
        <MultiTextFilter
          className="snap-detail-search"
          placeholder="Filter… (Enter to add, -term to exclude)"
          chips={terms}
          onChange={setTerms}
        />
        {filtered.length !== commits.length && (
          <span className="snap-detail-filtered">{filtered.length} matching</span>
        )}
      </div>

      {rawLoading ? (
        <div className="empty-state"><p>Loading commits…</p></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state"><p>No commits match the current filter.</p></div>
      ) : (
        <CollapsibleSection
          copyText={filtered
            .map((c) => `- ${c.commit_hash.slice(0, 7)} ${c.subject} (${c.author_name}, ${dayjs(c.committed_at).format('YYYY-MM-DD')})`)
            .join('\n')}
          collapsedNote={`${filtered.length} commit${filtered.length !== 1 ? 's' : ''} collapsed — click Expand to show.`}
        >
          <CommitSnapshotTable
            commits={filtered}
            extraClass="snap-detail-events"
          />
        </CollapsibleSection>
      )}

      <div className="snap-detail-comments">
        <CommentsSection
          summaryType="git-snapshot"
          summaryId={snap.id}
          generateParams={{ filter: terms }}
        />
      </div>
    </div>
  );
}
