import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import * as api from '../lib/api';
import { CommentsSection } from '../components/CommentsSection';
import { EditableTitle } from '../components/EditableTitle';
import { CommitSnapshotTable } from '../components/CommitSnapshotTable';

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

  const [search, setSearch] = useState('');

  const commits = rawData?.commits ?? [];

  const filtered = search
    ? commits.filter((c) => {
        const q = search.toLowerCase();
        return (
          c.subject.toLowerCase().includes(q) ||
          c.author_name.toLowerCase().includes(q) ||
          c.commit_hash.toLowerCase().includes(q)
        );
      })
    : commits;

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
        <input
          className="input snap-detail-search"
          placeholder="Search commit, author, hash…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
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
        <CommitSnapshotTable
          commits={filtered}
          extraClass="snap-detail-events"
        />
      )}

      <div className="snap-detail-comments">
        <CommentsSection summaryType="git-snapshot" summaryId={snap.id} />
      </div>
    </div>
  );
}
