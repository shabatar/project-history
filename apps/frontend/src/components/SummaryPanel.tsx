import { useState } from 'react';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import type { SummaryJob, Repository } from '../types';
import { marked } from 'marked';
import { linkifyReferences, type RepoContext } from '../lib/linkify';

// GitHub-flavored markdown; single newlines become <br> to match how comments
// and YouTrack field values are typically written. Output is sanitized below.
marked.setOptions({ gfm: true, breaks: true });

interface Props {
  jobs: SummaryJob[];
  loading?: boolean;
  repos?: Repository[];
  repoContext?: RepoContext | null;
  onDelete?: (jobId: string) => void;
}

const styleLabels: Record<string, string> = {
  short: 'Brief',
  detailed: 'Detailed',
  custom: 'Custom',
};

const styleIcons: Record<string, string> = {
  short: 'B',
  detailed: 'D',
  custom: 'C',
};

export default function SummaryPanel({ jobs, loading, repos, repoContext, onDelete }: Props) {
  if (loading) {
    return <div className="empty-state">Loading summaries...</div>;
  }

  if (jobs.length === 0) {
    return (
      <div className="empty-state">
        <p>No summaries yet.</p>
        <p className="empty-state-hint">
          Select a repository and date range, then click "Generate Summary".
        </p>
      </div>
    );
  }

  return (
    <div className="summary-list">
      {jobs.map((job) => {
        const repo = repos?.find((r) => r.id === job.repository_id);
        const ctx = repoContext ?? (repo
          ? { remote_url: repo.remote_url, name: repo.name }
          : null);
        return (
          <SummaryCard
            key={job.id}
            job={job}
            repoName={repo?.name}
            repoContext={ctx}
            onDelete={onDelete ? () => onDelete(job.id) : undefined}
          />
        );
      })}
    </div>
  );
}

function SummaryCard({
  job,
  repoName,
  repoContext,
  onDelete,
}: {
  job: SummaryJob;
  repoName?: string;
  repoContext: RepoContext | null;
  onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = job.result && job.result.summary_markdown.length > 0;
  const isLong = hasContent && job.result!.summary_markdown.length > 400;

  const title = job.branch
    ? `${job.branch} vs ${job.base_branch || 'default'}`
    : job.start_date && job.end_date
      ? `${dayjs(job.start_date).format('MMM D')} – ${dayjs(job.end_date).format('MMM D, YYYY')}`
      : 'Summary';

  return (
    <article className={`report-card ${job.status === 'failed' ? 'report-card-failed' : ''}`}>
      {/* Header */}
      <div className="report-header">
        <div className="report-header-left">
          <span className={`report-style-badge report-style-${job.summary_style}`}>
            {styleIcons[job.summary_style] ?? 'S'}
          </span>
          <div>
            <h3 className="report-title">
              {repoName && <span className="report-repo-name">{repoName} / </span>}
              {title}
            </h3>
            <div className="report-meta">
              {job.result && (
                <span className="report-meta-pill">{job.result.commit_count} commits</span>
              )}
              <span className="report-meta-pill">{job.model_name}</span>
              <span className="report-meta-pill">
                {styleLabels[job.summary_style] ?? job.summary_style}
              </span>
              <span className="report-meta-time">{dayjs(job.created_at).fromNow()}</span>
            </div>
          </div>
        </div>
        <div className="report-header-right">
          <Link
            to={`/summaries/${job.id}`}
            className="report-open-btn"
            title="Open full report"
          >
            Open full report
          </Link>
          <span className={`report-status report-status-${job.status}`}>
            {job.status}
          </span>
          {onDelete && (
            <button
              className="report-delete-btn"
              title="Delete this summary"
              onClick={() => {
                if (confirm('Delete this summary?')) onDelete();
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {hasContent && (
        <div className="report-body">
          <div
            className={`report-content ${!expanded && isLong ? 'report-content-collapsed' : ''}`}
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(
                job.result!.summary_markdown,
                repoContext,
              ),
            }}
          />
          {isLong && (
            <div className="report-expand-bar">
              <button
                className="report-expand-btn"
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? 'Show less' : 'Read full report'}
              </button>
            </div>
          )}
        </div>
      )}

      {job.status === 'failed' && (
        <div className="report-error">
          Summary generation failed. Check that Ollama is running.
        </div>
      )}
    </article>
  );
}

/** Markdown → HTML with proper structure, then resolve references to links. */
export function renderMarkdown(
  md: string,
  repoContext: RepoContext | null,
): string {
  let html = markdownToHtml(md);
  html = linkifyReferences(html, repoContext);
  html = sanitizeHtml(html);
  return html;
}

/**
 * Converts markdown to HTML using `marked` (GFM): headings, bold/italic, inline
 * and fenced code, blockquotes, ordered/unordered + nested lists, tables,
 * horizontal rules, autolinks, and links. Output is sanitized by sanitizeHtml.
 */
function markdownToHtml(md: string): string {
  // marked.parse is synchronous here (no async extensions configured).
  return marked.parse(md) as string;
}

import DOMPurify from 'dompurify';

const purifyConfig = {
  ALLOWED_TAGS: [
    'a', 'strong', 'em', 'code', 'del', 'p', 'br',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'hr', 'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'pre', 'span',
  ],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'title'],
};

// Open all rendered links in a new tab (marked emits bare <a href>).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, purifyConfig);
}
