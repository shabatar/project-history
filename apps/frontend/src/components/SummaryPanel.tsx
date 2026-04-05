import { useState } from 'react';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import type { SummaryJob, Repository } from '../types';
import { linkifyReferences, type RepoContext } from '../lib/linkify';

interface Props {
  jobs: SummaryJob[];
  loading?: boolean;
  repos?: Repository[];
  repoContext?: RepoContext | null;
}

const styleLabels: Record<string, string> = {
  short: 'Short',
  detailed: 'Detailed',
  manager: 'Briefly',
};

const styleIcons: Record<string, string> = {
  short: 'S',
  detailed: 'D',
  manager: 'M',
};

export default function SummaryPanel({ jobs, loading, repos, repoContext }: Props) {
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
        // When showing all repos, resolve context per-job
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
}: {
  job: SummaryJob;
  repoName?: string;
  repoContext: RepoContext | null;
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
 * Converts markdown to HTML with support for headings, bold, italic,
 * inline code, bullet lists, numbered lists, tables, horizontal rules,
 * and paragraphs.
 */
function markdownToHtml(md: string): string {
  // Escape HTML
  md = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = md.split('\n');
  const out: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let inTable = false;
  let tableHeaderDone = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      closeList(); closeTable();
      out.push('<hr/>');
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeList(); closeTable();
      const level = headingMatch[1].length;
      const text = inlineFormat(headingMatch[2]);
      out.push(`<h${level + 1}>${text}</h${level + 1}>`);
      continue;
    }

    // Table row
    if (line.includes('|') && line.trim().startsWith('|')) {
      const cells = line.split('|').filter((c) => c.trim() !== '');
      if (cells.length > 0) {
        // Check if this is a separator row (| --- | --- |)
        if (cells.every((c) => /^[\s:-]+$/.test(c))) {
          tableHeaderDone = true;
          continue;
        }
        if (!inTable) {
          closeList();
          inTable = true;
          tableHeaderDone = false;
          out.push('<div class="report-table-wrap"><table class="report-table">');
        }
        const tag = !tableHeaderDone ? 'th' : 'td';
        const rowHtml = cells
          .map((c) => `<${tag}>${inlineFormat(c.trim())}</${tag}>`)
          .join('');
        if (!tableHeaderDone) {
          out.push(`<thead><tr>${rowHtml}</tr></thead><tbody>`);
          tableHeaderDone = true;
        } else {
          out.push(`<tr>${rowHtml}</tr>`);
        }
        continue;
      }
    } else if (inTable) {
      closeTable();
    }

    // Unordered list
    if (/^[\s]*[-*+]\s+/.test(line)) {
      if (inList !== 'ul') { closeList(); inList = 'ul'; out.push('<ul>'); }
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      const text = inlineFormat(line.replace(/^[\s]*[-*+]\s+/, ''));
      const cls = indent >= 4 ? ' class="nested"' : '';
      out.push(`<li${cls}>${text}</li>`);
      continue;
    }

    // Ordered list
    if (/^[\s]*\d+\.\s+/.test(line)) {
      if (inList !== 'ol') { closeList(); inList = 'ol'; out.push('<ol>'); }
      const text = inlineFormat(line.replace(/^[\s]*\d+\.\s+/, ''));
      out.push(`<li>${text}</li>`);
      continue;
    }

    // Close open list if non-list line
    if (inList && line.trim() !== '') {
      closeList();
    }

    // Empty line
    if (line.trim() === '') {
      continue;
    }

    // Paragraph
    out.push(`<p>${inlineFormat(line)}</p>`);
  }

  closeList();
  closeTable();
  return out.join('\n');

  function closeList() {
    if (inList === 'ul') out.push('</ul>');
    else if (inList === 'ol') out.push('</ol>');
    inList = null;
  }

  function closeTable() {
    if (inTable) {
      out.push('</tbody></table></div>');
      inTable = false;
      tableHeaderDone = false;
    }
  }
}

import DOMPurify from 'dompurify';

const purifyConfig = {
  ALLOWED_TAGS: [
    'a', 'strong', 'em', 'code', 'del', 'p',
    'h2', 'h3', 'h4', 'h5',
    'ul', 'ol', 'li', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'pre',
  ],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'title'],
};

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, purifyConfig);
}

/** Inline formatting: bold, italic, code, strikethrough */
function inlineFormat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');
}
