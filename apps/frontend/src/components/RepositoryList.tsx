import type { Repository } from '../types';
import type { RepoStatus } from './RepoCard';
import RepoCard from './RepoCard';

interface Props {
  repositories: Repository[];
  selectedId: string | null;
  repoStatuses: Record<string, RepoStatus>;
  syncLogs: Record<string, string>;
  onSelect: (id: string) => void;
  onClone: (id: string) => void;
  onPull: (id: string) => void;
  onDelete: (id: string) => void;
  onRefresh: (id: string) => void;
  onOpenFolder: (id: string) => void;
  showOpenFolder?: boolean;
  loading?: boolean;
}

function deriveStatus(repo: Repository, overrides: Record<string, RepoStatus>): RepoStatus {
  if (overrides[repo.id]) return overrides[repo.id];
  return repo.last_synced_at ? 'cloned' : 'not_cloned';
}

export default function RepositoryList({
  repositories,
  selectedId,
  repoStatuses,
  syncLogs,
  onSelect,
  onClone,
  onPull,
  onDelete,
  onRefresh,
  onOpenFolder,
  showOpenFolder = true,
  loading,
}: Props) {
  if (loading) {
    return <div className="empty-state">Loading repositories...</div>;
  }

  if (repositories.length === 0) {
    return (
      <div className="empty-state">
        <p>No repositories yet.</p>
        <p className="empty-state-hint">
          Add a Git repository URL above to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="repo-list">
      {repositories.map((repo) => (
        <RepoCard
          key={repo.id}
          repo={repo}
          selected={repo.id === selectedId}
          status={deriveStatus(repo, repoStatuses)}
          syncLog={syncLogs[repo.id] ?? null}
          onSelect={onSelect}
          onClone={onClone}
          onPull={onPull}
          onDelete={onDelete}
          onRefresh={onRefresh}
          onOpenFolder={onOpenFolder}
          showOpenFolder={showOpenFolder}
        />
      ))}
    </div>
  );
}
