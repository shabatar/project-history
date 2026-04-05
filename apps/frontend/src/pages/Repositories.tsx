import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store';
import type { RepoStatus } from '../components/RepoCard';
import * as api from '../lib/api';
import {
  useRepositories,
  useAddRepository,
  useAddLocalRepository,
  useOpenInFileManager,
  useCloneRepository,
  usePullRepository,
  useDeleteRepository,
} from '../lib/hooks';
import AddRepositoryForm from '../components/AddRepositoryForm';
import RepositoryList from '../components/RepositoryList';

export default function Repositories() {
  const qc = useQueryClient();
  const { selectedRepoId, setSelectedRepoId } = useAppStore();
  const { data: repos = [], isLoading } = useRepositories();
  const { data: features } = useQuery({ queryKey: ['features'], queryFn: api.getFeatures, staleTime: 60_000 });
  const showOpenFolder = features?.open_folder ?? true;

  const addMut = useAddRepository();
  const addLocalMut = useAddLocalRepository();
  const openFolderMut = useOpenInFileManager();
  const cloneMut = useCloneRepository();
  const pullMut = usePullRepository();
  const deleteMut = useDeleteRepository();

  const [statuses, setStatuses] = useState<Record<string, RepoStatus>>({});
  const [syncLogs, setSyncLogs] = useState<Record<string, string>>({});
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  const setStatus = useCallback(
    (id: string, s: RepoStatus) =>
      setStatuses((prev) => ({ ...prev, [id]: s })),
    [],
  );
  const setLog = useCallback(
    (id: string, msg: string) =>
      setSyncLogs((prev) => ({ ...prev, [id]: msg })),
    [],
  );
  const clearStatus = useCallback(
    (id: string) =>
      setStatuses((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      }),
    [],
  );

  function handleClone(id: string) {
    setStatus(id, 'syncing');
    setLog(id, 'Cloning repository...');
    cloneMut.mutate(id, {
      onSuccess: () => {
        setLog(id, 'Clone complete.');
        clearStatus(id);
      },
      onError: (err) => {
        setStatus(id, 'error');
        setLog(id, `Clone failed: ${(err as Error).message}`);
      },
    });
  }

  function handlePull(id: string) {
    setStatus(id, 'syncing');
    setLog(id, 'Pulling latest changes...');
    pullMut.mutate(id, {
      onSuccess: () => {
        setLog(id, 'Pull complete.');
        clearStatus(id);
      },
      onError: (err) => {
        setStatus(id, 'error');
        setLog(id, `Pull failed: ${(err as Error).message}`);
      },
    });
  }

  function handleDelete(id: string) {
    deleteMut.mutate(id);
    if (selectedRepoId === id) setSelectedRepoId(null);
  }

  function handleRefresh(id: string) {
    setLog(id, 'Refreshing...');
    qc.invalidateQueries({ queryKey: ['repositories'] }).then(() => {
      setLog(id, 'Refreshed.');
      refreshTimerRef.current = setTimeout(() => setSyncLogs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      }), 2000);
    });
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Repositories</h2>
      </div>

      <AddRepositoryForm
        onAddRemote={(url) => addMut.mutate(url)}
        onAddLocal={(path) => addLocalMut.mutate(path)}
        disabled={addMut.isPending || addLocalMut.isPending}
      />

      {addMut.isError && (
        <div className="error-banner">
          Failed to add repository. Check the URL and try again.
        </div>
      )}
      {addLocalMut.isError && (
        <div className="error-banner">
          Failed to add local repository. {(addLocalMut.error as Error)?.message?.includes('422')
            ? 'Path is not a valid git repository.'
            : 'Check the path and try again.'}
        </div>
      )}

      <RepositoryList
        repositories={repos}
        selectedId={selectedRepoId}
        repoStatuses={statuses}
        syncLogs={syncLogs}
        onSelect={setSelectedRepoId}
        onClone={handleClone}
        onPull={handlePull}
        onDelete={handleDelete}
        onRefresh={handleRefresh}
        onOpenFolder={(id) => openFolderMut.mutate(id)}
        showOpenFolder={showOpenFolder}
        loading={isLoading}
      />
    </div>
  );
}
