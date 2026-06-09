import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import * as api from '../lib/api';
import { useRepositories } from '../lib/hooks';
import { renderMarkdown } from '../components/SummaryPanel';
import { CommentsSection } from '../components/CommentsSection';
import { EditableTitle } from '../components/EditableTitle';
import type { SummaryJob } from '../types';
import type { RepoContext } from '../lib/linkify';

const styleLabels: Record<string, string> = {
  short: 'Brief',
  detailed: 'Detailed',
  custom: 'Custom',
};

export default function SummaryDetail() {
  const { jobId } = useParams<{ jobId: string }>();
  const qc = useQueryClient();

  const { data: job, isLoading, isError } = useQuery<SummaryJob>({
    queryKey: ['summary', jobId],
    queryFn: () => api.getSummary(jobId!),
    enabled: !!jobId,
  });

  const { data: repos = [] } = useRepositories();
  const repo = job ? repos.find((r) => r.id === job.repository_id) : null;
  const repoContext: RepoContext | null = repo
    ? { remote_url: repo.remote_url, name: repo.name }
    : null;

  if (isLoading) {
    return (
      <div className="page">
        <div className="empty-state">Loading summary...</div>
      </div>
    );
  }

  if (isError || !job) {
    return (
      <div className="page">
        <div className="error-banner">Summary not found.</div>
        <Link to="/summaries" className="btn">
          Back to Summaries
        </Link>
      </div>
    );
  }

  const title = job.branch
    ? `${job.branch} vs ${job.base_branch || 'default'}`
    : job.start_date && job.end_date
      ? `${dayjs(job.start_date).format('MMM D')} – ${dayjs(job.end_date).format('MMM D, YYYY')}`
      : 'Summary';

  return (
    <div className="page">
      <div className="page-header">
        <Link to="/summaries" className="detail-back">
          Back to Summaries
        </Link>
        <EditableTitle
          defaultTitle={title}
          userLabel={job.user_label}
          onSave={async (label) => {
            await api.patchItemLabel('git-summary', job.id, label);
            qc.invalidateQueries({ queryKey: ['summary', jobId] });
            qc.invalidateQueries({ queryKey: ['summaries'] });
          }}
        />
        {repo && <p className="page-header-sub">Repository: {repo.name}</p>}
      </div>

      <div className="detail-meta-bar">
        <span className={`report-status report-status-${job.status}`}>
          {job.status}
        </span>
        <span className="detail-meta-item">
          <strong>Model</strong> {job.model_name}
        </span>
        <span className="detail-meta-item">
          <strong>Style</strong> {styleLabels[job.summary_style] ?? job.summary_style}
        </span>
        {job.result && (
          <span className="detail-meta-item">
            <strong>Commits</strong> {job.result.commit_count}
          </span>
        )}
        <span className="detail-meta-item">
          <strong>Generated</strong> {dayjs(job.created_at).format('MMM D, YYYY [at] HH:mm')}
        </span>
      </div>

      {job.result && (
        <div className="detail-report-body">
          <div
            className="report-content"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(
                job.result.summary_markdown,
                repoContext,
              ),
            }}
          />
        </div>
      )}

      {job.status === 'failed' && (
        <div className="report-error">
          Summary generation failed. Check that Ollama is running and the
          model is available.
        </div>
      )}

      {job.status === 'completed' && (
        <CommentsSection summaryType="git" summaryId={job.id} />
      )}
    </div>
  );
}
