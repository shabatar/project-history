/**
 * Renders YouTrack text (comments, rich field values like "Affected customers")
 * as markdown. Small text renders synchronously; large text shows raw immediately
 * and swaps in rendered markdown once parsed during idle time, so a long activity
 * timeline doesn't block the initial paint or jank while scrolling.
 */

import { useEffect, useState } from 'react';
import { renderMarkdown } from './SummaryPanel';

// Values above this size get parsed off the initial paint.
const LARGE_MARKDOWN_CHARS = 1500;

/**
 * Does this value carry rich text (markdown / multiline) worth rendering, rather
 * than a short scalar like a state name or assignee? Biased toward rendering:
 * a false positive just wraps a scalar in a <p>, which looks the same.
 */
export function isRichText(v: string | null | undefined): boolean {
  if (!v) return false;
  if (v.length > 80 || v.includes('\n')) return true;
  return (
    // bold / code / strike
    /\*\*|__|~~|`/.test(v) ||
    // single-* or single-_ emphasis (paired, so identifiers like a_b don't match)
    /\*[^*\s][^*]*\*|(?:^|\s)_[^_\s][^_]*_/.test(v) ||
    // links
    /\[[^\]]+\]\([^)]+\)/.test(v) ||
    // headings / list markers / blockquotes / tables at line start
    /(?:^|\s)#{1,6}\s|(?:^|\s)[-*+]\s|(?:^|\s)\d+\.\s|(?:^|\s)>\s|\|/.test(v)
  );
}

type IdleHandle = number;
function requestIdle(cb: () => void): IdleHandle {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  return w.requestIdleCallback
    ? w.requestIdleCallback(cb, { timeout: 800 })
    : window.setTimeout(cb, 0);
}
function cancelIdle(id: IdleHandle): void {
  const w = window as unknown as { cancelIdleCallback?: (id: number) => void };
  if (w.cancelIdleCallback) w.cancelIdleCallback(id);
  else clearTimeout(id);
}

export function MarkdownText({ text }: { text: string }) {
  const isLarge = text.length > LARGE_MARKDOWN_CHARS;
  const [html, setHtml] = useState<string | null>(
    () => (isLarge ? null : renderMarkdown(text, null)),
  );

  useEffect(() => {
    if (!isLarge) {
      setHtml(renderMarkdown(text, null));
      return;
    }
    // Defer the heavy parse so the row paints first.
    setHtml(null);
    let cancelled = false;
    const id = requestIdle(() => {
      if (!cancelled) setHtml(renderMarkdown(text, null));
    });
    return () => { cancelled = true; cancelIdle(id); };
  }, [text, isLarge]);

  if (html === null) {
    return <span className="pf-event-text pf-comment-pending">{text}</span>;
  }
  return (
    <span
      className="pf-comment-md summary-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
