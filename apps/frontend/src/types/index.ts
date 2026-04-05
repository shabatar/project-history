// Aligned with backend app/schemas.py

export interface Repository {
  id: string;
  name: string;
  remote_url: string;
  default_branch: string;
  last_synced_at: string | null;
  is_active: boolean;
  commit_count: number;
}

export interface Commit {
  id: string;
  repository_id: string;
  commit_hash: string;
  author_name: string;
  author_email: string;
  committed_at: string;
  subject: string;
  body: string;
}

export interface SummaryJob {
  id: string;
  repository_id: string;
  start_date: string | null;
  end_date: string | null;
  branch: string | null;
  base_branch: string | null;
  model_name: string;
  summary_style: SummaryStyle;
  status: 'pending' | 'running' | 'completed' | 'failed';
  created_at: string;
  result: SummaryResult | null;
}

export interface BranchInfo {
  name: string;
  short_hash: string;
  last_commit_date: string;
  is_remote: boolean;
}

export interface SummaryResult {
  id: string;
  summary_job_id: string;
  summary_markdown: string;
  commit_count: number;
  generated_at: string;
}

export interface OllamaModel {
  name: string;
  size: number | null;
  modified_at: string | null;
}

export type SummaryStyle = 'short' | 'detailed' | 'manager';

export interface DateRange {
  from: string;
  to: string;
}

export type IssueTrackerType = 'youtrack' | 'jira' | 'github' | 'none';

export interface LocalSettings {
  ollamaBaseUrl: string;
  defaultModel: string;
  issueTrackerType: IssueTrackerType;
  issueTrackerUrl: string;  // e.g. https://youtrack.example.com or https://jira.example.com
}

