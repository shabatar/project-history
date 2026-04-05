import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import * as api from './api';
import type { Repository, Commit, SummaryJob, BranchInfo, OllamaModel } from '../types';

// ── Repositories ──

export function useRepositories() {
  return useQuery<Repository[]>({
    queryKey: ['repositories'],
    queryFn: api.listRepositories,
  });
}

export function useAddRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (remoteUrl: string) => api.addRepository(remoteUrl),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

export function useAddLocalRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (localPath: string) => api.addLocalRepository(localPath),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

export function useOpenInFileManager() {
  return useMutation({
    mutationFn: (id: string) => api.openInFileManager(id),
  });
}

export function useCloneRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cloneRepository(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

export function usePullRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.pullRepository(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

export function useDeleteRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRepository(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repositories'] }),
  });
}

// ── Branches ──

export function useBranches(repositoryId: string | null) {
  return useQuery<BranchInfo[]>({
    queryKey: ['branches', repositoryId],
    queryFn: () => api.listBranches(repositoryId!),
    enabled: !!repositoryId,
  });
}

// ── Commits ──

export function useCommits(
  repositoryId: string | null,
  since?: string,
  until?: string,
) {
  return useQuery<Commit[]>({
    queryKey: ['commits', repositoryId, since, until],
    queryFn: () => api.listCommits(repositoryId!, since, until),
    enabled: !!repositoryId,
  });
}

// ── Summaries ──

export function useSummaries(repositoryId?: string | null) {
  return useQuery<SummaryJob[]>({
    queryKey: ['summaries', repositoryId ?? 'all'],
    queryFn: () => api.listSummaries(repositoryId ?? undefined),
  });
}

// ── Ollama models ──

export function useOllamaModels() {
  return useQuery<OllamaModel[]>({
    queryKey: ['ollama-models'],
    queryFn: api.listOllamaModels,
    retry: false,
    staleTime: 60_000,
  });
}
