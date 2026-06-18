import { useState, useEffect } from 'react';
import dayjs from 'dayjs';
import { renderWithIssueLinks } from '../lib/issueLinks';

interface SnapshotCommit {
  commit_hash: string;
  committed_at: string;
  author_name: string;
  subject: string;
}

interface Props {
  commits: SnapshotCommit[];
  pageSize?: number;
  extraClass?: string;
}

export function CommitSnapshotTable({ commits, pageSize = 100, extraClass = '' }: Props) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [commits]);

  const pageCount = Math.ceil(commits.length / pageSize);
  const visible = commits.slice(page * pageSize, (page + 1) * pageSize);

  return (
    <>
      <div className={`snap-events${extraClass ? ' ' + extraClass : ''}`}>
        <table className="snap-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Hash</th>
              <th>Author</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.commit_hash} className="snap-row">
                <td className="snap-ts">{dayjs(c.committed_at).format('MMM D, HH:mm')}</td>
                <td className="snap-issue">
                  <span className="snap-commit-hash">{c.commit_hash.slice(0, 7)}</span>
                </td>
                <td className="snap-author">{c.author_name}</td>
                <td className="snap-detail snap-commit-subject">{renderWithIssueLinks(c.subject)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="snap-pager">
          <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
          <span className="snap-pager-label">{page + 1} / {pageCount} ({commits.length} commits)</span>
          <button className="btn btn-sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </div>
      )}
    </>
  );
}
