import dayjs from 'dayjs';
import type { Repository } from '../types';

export type RepoStatus = 'not_cloned' | 'cloned' | 'syncing' | 'error';

interface Props {
  repo: Repository;
  selected: boolean;
  status: RepoStatus;
  syncLog: string | null;
  onSelect: (id: string) => void;
  onClone: (id: string) => void;
  onPull: (id: string) => void;
  onDelete: (id: string) => void;
  onRefresh: (id: string) => void;
  onOpenFolder: (id: string) => void;
  showOpenFolder?: boolean;
}

const STATUS_CONFIG: Record<RepoStatus, { label: string; className: string }> = {
  not_cloned: { label: 'Not cloned', className: 'status-pending' },
  cloned: { label: 'Cloned', className: 'status-cloned' },
  syncing: { label: 'Syncing...', className: 'status-syncing' },
  error: { label: 'Error', className: 'status-error' },
};

export default function RepoCard({
  repo,
  selected,
  status,
  syncLog,
  onSelect,
  onClone,
  onPull,
  onDelete,
  onRefresh,
  onOpenFolder,
  showOpenFolder = true,
}: Props) {
  const { label, className } = STATUS_CONFIG[status];
  const synced = repo.last_synced_at != null;
  const isBusy = status === 'syncing';

  return (
    <div
      className={`repo-card${selected ? ' selected' : ''}`}
      onClick={() => onSelect(repo.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect(repo.id);
      }}
    >
      <div className="repo-card-header">
        <span className="repo-card-name">{repo.name}</span>
        <span className={`repo-card-status ${className}`}>{label}</span>
      </div>

      <div className="repo-card-meta">
        <span className="repo-card-url" title={repo.remote_url}>
          {repo.remote_url}
        </span>
        {repo.default_branch && (
          <span>branch: {repo.default_branch}</span>
        )}
        {repo.last_synced_at && (
          <span>Synced {dayjs(repo.last_synced_at).fromNow()}</span>
        )}
        {repo.commit_count > 0 && (
          <span>{repo.commit_count} commits</span>
        )}
      </div>

      {synced && showOpenFolder && (
        <div className="repo-card-path">
          <button
            className="btn btn-sm btn-open-folder"
            onClick={(e) => {
              e.stopPropagation();
              onOpenFolder(repo.id);
            }}
            title="Open in Finder / file manager"
          >
            Open Folder
          </button>
        </div>
      )}

      <div className="repo-card-actions" onClick={(e) => e.stopPropagation()}>
        {!synced && (
          <button
            className="btn btn-sm btn-primary"
            onClick={() => onClone(repo.id)}
            disabled={isBusy}
          >
            {status === 'syncing' ? 'Cloning...' : 'Clone'}
          </button>
        )}
        {synced && (
          <button
            className="btn btn-sm"
            onClick={() => onPull(repo.id)}
            disabled={isBusy}
          >
            {status === 'syncing' ? 'Pulling...' : 'Pull / Update'}
          </button>
        )}
        {synced && showOpenFolder && (
          <button
            className="btn btn-sm btn-open-folder"
            onClick={() => onOpenFolder(repo.id)}
            title="Open in Finder / file manager"
          >
            Open Folder
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={() => onRefresh(repo.id)}
          title="Refresh repository info"
        >
          Refresh
        </button>
        <button
          className="btn btn-sm btn-danger"
          onClick={() => onDelete(repo.id)}
        >
          Remove
        </button>
      </div>

      {syncLog && (
        <div className="repo-sync-log">
          <span className="repo-sync-log-label">Log:</span>
          <span>{syncLog}</span>
        </div>
      )}
    </div>
  );
}
