import type { ReactNode } from 'react';
import { issueTrackerUrl } from './linkify';

// PROJECT-123 style issue references.
const ISSUE_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;

/**
 * Render plain text with PROJECT-123 issue references turned into links to the
 * configured issue tracker (per user settings). Refs are left as plain text when
 * no tracker is configured. Safe for use inside clickable rows — link clicks
 * stop propagation.
 */
export function renderWithIssueLinks(text: string | null | undefined): ReactNode {
  if (!text) return text ?? null;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  ISSUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ISSUE_RE.exec(text)) !== null) {
    const url = issueTrackerUrl(m[1], m[2]);
    if (!url) continue;
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
    parts.push(
      <a
        key={key++}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="issue-ref-link"
        onClick={(e) => e.stopPropagation()}
      >
        {m[0]}
      </a>,
    );
    lastIndex = m.index + m[0].length;
  }

  if (parts.length === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}
