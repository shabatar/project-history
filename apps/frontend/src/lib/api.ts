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
  token_configured: boolean;
  token_source: 'env' | 'db' | null;
}

export interface YouTrackConfigInput {
  base_url: string;
  api_token?: string | null;
}

export interface YouTrackTestResult {
  ok: boolean;
  detail: string | null;
  username: string | null;
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
  baseline_synced_at: string | null;
  since: string | null;
}

export async function getYouTrackConfig(): Promise<YouTrackConfig | null> {
  const { data } = await client.get<YouTrackConfig | null>('/youtrack/config');
  return data;
}

export async function setYouTrackConfig(input: YouTrackConfigInput): Promise<YouTrackConfig> {
  const { data } = await client.post<YouTrackConfig>('/youtrack/config', input);
  return data;
}

export async function deleteYouTrackConfig(): Promise<void> {
  await client.delete('/youtrack/config');
}

export async function clearYouTrackToken(): Promise<YouTrackConfig> {
  const { data } = await client.delete<YouTrackConfig>('/youtrack/config/token');
  return data;
}

export async function testYouTrackConnection(input: {
  base_url?: string;
  api_token?: string;
}): Promise<YouTrackTestResult> {
  const { data } = await client.post<YouTrackTestResult>('/youtrack/config/test', input);
  return data;
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

export async function syncYouTrackBoard(
  id: string,
  since?: string | null,
): Promise<BoardSyncResult> {
  const { data } = await client.post<BoardSyncResult>(
    `/youtrack/boards/${id}/sync`,
    { since: since ?? null },
  );
  return data;
}

export async function syncAllYouTrackBoards(
  since?: string | null,
): Promise<BoardSyncResult[]> {
  const { data } = await client.post<BoardSyncResult[]>(
    '/youtrack/sync-all',
    { since: since ?? null },
  );
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
  author_login: string | null;
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
  signal?: AbortSignal,
): Promise<BoardActivityResponse> {
  const { data } = await client.post<BoardActivityResponse>(
    `/youtrack/boards/${boardId}/activity`,
    { since, until },
    { timeout: 600_000, signal },
  );
  return data;
}

export interface ActivitySummaryResponse {
  board_id: string;
  board_name: string;
  since: string;
  until: string;
  summary_style: 'short' | 'detailed' | 'manager';
  model_name: string;
  activity_count: number;
  summary_markdown: string;
  used_llm: boolean;
  generated_at: string;
}

// ── YouTrack Projects (project-level activity) ──

export interface YouTrackProject {
  id: string;
  short_name: string;
  name: string;
  description: string;
  archived: boolean;
}

export interface ProjectActivityResponse {
  project_short_name: string;
  project_name: string;
  since: string;
  until: string;
  activities: ActivityItem[];
}

export interface ProjectActivitySummaryResponse {
  project_short_name: string;
  project_name: string;
  since: string;
  until: string;
  summary_style: 'short' | 'detailed' | 'manager';
  model_name: string;
  activity_count: number;
  summary_markdown: string;
  used_llm: boolean;
  generated_at: string;
}

export async function listYouTrackProjects(
  includeArchived = false,
): Promise<YouTrackProject[]> {
  const { data } = await client.get<YouTrackProject[]>('/youtrack/projects', {
    params: { include_archived: includeArchived },
  });
  return data;
}

export async function fetchProjectActivity(
  shortName: string,
  since: string,
  until: string,
  signal?: AbortSignal,
): Promise<ProjectActivityResponse> {
  const { data } = await client.post<ProjectActivityResponse>(
    `/youtrack/projects/${encodeURIComponent(shortName)}/activity`,
    { since, until },
    { timeout: 600_000, signal },
  );
  return data;
}

export type ActivityStreamEvent =
  | { type: 'status'; phase: string; project_name?: string; short_name?: string }
  | { type: 'progress'; phase: string; done: number; total: number; events_so_far: number }
  | { type: 'done'; response: ProjectActivityResponse }
  | { type: 'error'; detail: string };

/**
 * Read an NDJSON stream: one JSON document per `\n`-terminated line.
 *
 * Emits network-level progress via `onStatus` (fetch, response, per-chunk) and
 * parsed payloads via `onEvent`. Throws only on network / HTTP errors — backend
 * errors are expected to arrive as a terminal `{type:"error"}` line inside the
 * body, so callers do NOT need to wrap this for that case.
 */
async function readNdjsonStream<E>(
  url: string,
  body: Record<string, unknown>,
  opts: {
    onEvent: (event: E) => void;
    onStatus?: (msg: string) => void;
    signal?: AbortSignal;
    tag?: string;
  },
): Promise<void> {
  const tag = opts.tag ?? '[stream]';
  const t0 = performance.now();
  const ms = () => ((performance.now() - t0) / 1000).toFixed(2) + 's';
  const emit = (msg: string) => { console.log(tag, msg); opts.onStatus?.(msg); };

  emit(`fetch → ${url}`);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    emit(`fetch rejected at ${ms()}: ${(e as Error).message}`);
    throw e;
  }
  emit(`response ${resp.status} at ${ms()}`);

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.detail) detail = String(j.detail);
    } catch { /* best-effort */ }
    throw new Error(detail);
  }
  if (!resp.body) throw new Error('No response body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let chunkIx = 0;
  try {
    while (true) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) {
        emit(`reader done at ${ms()} (${chunkIx} chunks)`);
        break;
      }
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      chunkIx++;
      if (chunkIx === 1 || chunkIx % 10 === 0) {
        emit(`chunk #${chunkIx} (${value?.byteLength ?? 0}B) at ${ms()}`);
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          opts.onEvent(JSON.parse(line) as E);
        } catch (e) {
          console.warn(tag, 'bad NDJSON line:', line, e);
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/** Stream project activity as NDJSON events. */
export async function streamProjectActivity(
  shortName: string,
  since: string,
  until: string,
  opts: {
    onEvent: (e: ActivityStreamEvent) => void;
    onStatus?: (msg: string) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  return readNdjsonStream<ActivityStreamEvent>(
    `/youtrack/projects/${encodeURIComponent(shortName)}/activity/stream`,
    { since, until },
    opts,
  );
}

export async function summarizeProjectActivity(
  shortName: string,
  input: {
    since: string;
    until: string;
    summary_style?: 'short' | 'detailed' | 'manager';
    model_name?: string;
  },
  signal?: AbortSignal,
): Promise<ProjectActivitySummaryResponse> {
  const { data } = await client.post<ProjectActivitySummaryResponse>(
    `/youtrack/projects/${encodeURIComponent(shortName)}/activity/summarize`,
    input,
    { timeout: 600_000, signal },
  );
  return data;
}

export type SummaryStreamEvent =
  | { type: 'status'; phase: string; source?: string; model?: string; activity_count?: number }
  | { type: 'progress'; phase: string; done: number; total: number; events_so_far: number }
  | { type: 'done'; response: Record<string, unknown> }
  | { type: 'error'; detail: string };

type SummarizeInput = {
  since: string;
  until: string;
  summary_style?: 'short' | 'detailed' | 'manager';
  model_name?: string;
};

type SummarizeStreamOpts = {
  onEvent: (e: SummaryStreamEvent) => void;
  onStatus?: (msg: string) => void;
  signal?: AbortSignal;
};

/** Stream AI-summary generation for a YouTrack project's activity. */
export async function streamSummarizeProjectActivity(
  shortName: string,
  input: SummarizeInput,
  opts: SummarizeStreamOpts,
): Promise<void> {
  return readNdjsonStream<SummaryStreamEvent>(
    `/youtrack/projects/${encodeURIComponent(shortName)}/activity/summarize/stream`,
    input,
    { ...opts, tag: '[summarize-stream]' },
  );
}

/** Stream AI-summary generation for a tracked YouTrack board's activity. */
export async function streamSummarizeBoardActivity(
  boardId: string,
  input: SummarizeInput,
  opts: SummarizeStreamOpts,
): Promise<void> {
  return readNdjsonStream<SummaryStreamEvent>(
    `/youtrack/boards/${encodeURIComponent(boardId)}/activity/summarize/stream`,
    input,
    { ...opts, tag: '[summarize-stream]' },
  );
}

export interface ActivitySummaryRecord {
  id: string;
  source_type: 'board' | 'project';
  source_id: string;
  source_name: string;
  since: string;
  until: string;
  summary_style: 'short' | 'detailed' | 'manager';
  model_name: string;
  activity_count: number;
  summary_markdown: string;
  used_llm: boolean;
  generated_at: string;
}

export async function listActivitySummaries(limit = 100): Promise<ActivitySummaryRecord[]> {
  const { data } = await client.get<ActivitySummaryRecord[]>('/youtrack/activity-summaries', {
    params: { limit },
  });
  return data;
}

export async function deleteActivitySummary(id: string): Promise<void> {
  await client.delete(`/youtrack/activity-summaries/${id}`);
}

export async function summarizeBoardActivity(
  boardId: string,
  input: {
    since: string;
    until: string;
    summary_style?: 'short' | 'detailed' | 'manager';
    model_name?: string;
  },
  signal?: AbortSignal,
): Promise<ActivitySummaryResponse> {
  const { data } = await client.post<ActivitySummaryResponse>(
    `/youtrack/boards/${boardId}/activity/summarize`,
    input,
    { timeout: 600_000, signal },
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

