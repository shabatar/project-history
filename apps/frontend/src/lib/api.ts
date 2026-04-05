import axios from 'axios';
import type {
  Repository,
  Commit,
  SummaryJob,
  BranchInfo,
  OllamaModel,
  SummaryStyle,
} from '../types';

const client = axios.create({
  baseURL: '/',
  headers: { 'Content-Type': 'application/json' },
});

// ── Repositories ──

export async function listRepositories(): Promise<Repository[]> {
  const { data } = await client.get<Repository[]>('/repositories');
  return data;
}

export async function addRepository(remoteUrl: string): Promise<Repository> {
  const { data } = await client.post<Repository>('/repositories', {
    remote_url: remoteUrl,
  });
  return data;
}

export async function addLocalRepository(localPath: string): Promise<Repository> {
  const { data } = await client.post<Repository>('/repositories/local', {
    local_path: localPath,
  });
  return data;
}

export async function deleteRepository(id: string): Promise<void> {
  await client.delete(`/repositories/${id}`);
}

export async function openInFileManager(id: string): Promise<void> {
  await client.post(`/repositories/${id}/open`);
}

export async function cloneRepository(id: string): Promise<Repository> {
  const { data } = await client.post<Repository>(`/repositories/${id}/clone`);
  return data;
}

export async function pullRepository(id: string): Promise<Repository> {
  const { data } = await client.post<Repository>(`/repositories/${id}/pull`);
  return data;
}

// ── Branches ──

export async function listBranches(
  repositoryId: string,
): Promise<BranchInfo[]> {
  const { data } = await client.get<BranchInfo[]>(
    `/repositories/${repositoryId}/branches`,
  );
  return data;
}

// ── Commits ──

export async function listCommits(
  repositoryId: string,
  since?: string,
  until?: string,
  limit?: number,
): Promise<Commit[]> {
  const params: Record<string, string | number> = {};
  if (since) params.since = since;
  if (until) params.until = until;
  if (limit) params.limit = limit;
  const { data } = await client.get<Commit[]>(
    `/repositories/${repositoryId}/commits`,
    { params },
  );
  return data;
}

export async function parseCommits(
  repositoryId: string,
  since?: string,
  until?: string,
): Promise<Commit[]> {
  const { data } = await client.post<Commit[]>(
    `/repositories/${repositoryId}/commits/parse`,
    { since: since || null, until: until || null },
  );
  return data;
}

// ── Summaries ──

export async function createSummary(
  body: {
    repository_id: string;
    start_date?: string;
    end_date?: string;
    branch?: string;
    base_branch?: string;
    model_name?: string;
    summary_style?: SummaryStyle;
  },
  signal?: AbortSignal,
): Promise<SummaryJob> {
  const { data } = await client.post<SummaryJob>('/summaries', body, { signal });
  return data;
}

export async function listSummaries(
  repositoryId?: string,
): Promise<SummaryJob[]> {
  const params: Record<string, string> = {};
  if (repositoryId) params.repository_id = repositoryId;
  const { data } = await client.get<SummaryJob[]>('/summaries', { params });
  return data;
}

export async function getSummary(jobId: string): Promise<SummaryJob> {
  const { data } = await client.get<SummaryJob>(`/summaries/${jobId}`);
  return data;
}

export interface RunningModel {
  name: string;
  size: number | null;
  size_vram: number | null;
  expires_at: string | null;
}

export async function listRunningModels(): Promise<RunningModel[]> {
  const { data } = await client.get<RunningModel[]>('/summaries/models/running');
  return data;
}

export async function loadModel(name: string): Promise<void> {
  await client.post('/summaries/models/load', { name }, { timeout: 120_000 });
}

export async function unloadModel(name: string): Promise<void> {
  await client.post('/summaries/models/unload', { name }, { timeout: 30_000 });
}

export async function deleteModel(name: string): Promise<void> {
  await client.delete(`/summaries/models/${encodeURIComponent(name)}`);
}

export async function pullModel(name: string, signal?: AbortSignal): Promise<void> {
  await client.post('/summaries/models/pull', { name }, { timeout: 600_000, signal });
}

export async function listOllamaModels(): Promise<OllamaModel[]> {
  const { data } = await client.get<OllamaModel[]>(
    '/summaries/models/available',
  );
  return data;
}

// ── YouTrack ──

export interface YouTrackConfig {
  id: string;
  base_url: string;
  created_at: string;
}

export interface YouTrackBoard {
  id: string;
  config_id: string;
  board_id: string;
  board_name: string;
  board_url: string;
  last_synced_at: string | null;
}

export interface YouTrackIssue {
  id: string;
  board_id: string;
  issue_id: string;
  summary: string;
  state: string;
  assignee: string | null;
  updated_at: string | null;
  synced_at: string;
}

export interface IssueChange {
  issue_id: string;
  summary: string;
  change_type: 'added' | 'removed' | 'updated';
  old_state: string | null;
  new_state: string | null;
  old_assignee: string | null;
  new_assignee: string | null;
}

export interface BoardSyncResult {
  board_id: string;
  board_name: string;
  total_issues: number;
  changes: IssueChange[];
}

export async function getYouTrackConfig(): Promise<YouTrackConfig | null> {
  const { data } = await client.get<YouTrackConfig | null>('/youtrack/config');
  return data;
}

export async function setYouTrackConfig(base_url: string): Promise<YouTrackConfig> {
  const { data } = await client.post<YouTrackConfig>('/youtrack/config', { base_url });
  return data;
}

export async function deleteYouTrackConfig(): Promise<void> {
  await client.delete('/youtrack/config');
}

export async function listYouTrackBoards(): Promise<YouTrackBoard[]> {
  const { data } = await client.get<YouTrackBoard[]>('/youtrack/boards');
  return data;
}

export async function addYouTrackBoard(board_url: string): Promise<YouTrackBoard> {
  const { data } = await client.post<YouTrackBoard>('/youtrack/boards', { board_url });
  return data;
}

export async function removeYouTrackBoard(id: string): Promise<void> {
  await client.delete(`/youtrack/boards/${id}`);
}

export async function syncYouTrackBoard(id: string): Promise<BoardSyncResult> {
  const { data } = await client.post<BoardSyncResult>(`/youtrack/boards/${id}/sync`);
  return data;
}

export async function syncAllYouTrackBoards(): Promise<BoardSyncResult[]> {
  const { data } = await client.post<BoardSyncResult[]>('/youtrack/sync-all');
  return data;
}

export async function listBoardIssues(boardId: string): Promise<YouTrackIssue[]> {
  const { data } = await client.get<YouTrackIssue[]>(`/youtrack/boards/${boardId}/issues`);
  return data;
}

export interface ActivityItem {
  timestamp: number;
  issue_id: string;
  issue_summary: string;
  author: string;
  activity_type: 'created' | 'resolved' | 'comment' | 'field_change';
  field: string;
  old_value: string | null;
  new_value: string | null;
  comment_text: string | null;
}

export interface BoardActivityResponse {
  board_id: string;
  board_name: string;
  since: string;
  until: string;
  activities: ActivityItem[];
}

export async function fetchBoardActivity(
  boardId: string,
  since: string,
  until: string,
): Promise<BoardActivityResponse> {
  const { data } = await client.post<BoardActivityResponse>(
    `/youtrack/boards/${boardId}/activity`,
    { since, until },
  );
  return data;
}

// ── Features ──

export interface Features {
  youtrack: boolean;
  open_folder: boolean;
}

export async function getFeatures(): Promise<Features> {
  const { data } = await client.get<Features>('/features');
  return data;
}

