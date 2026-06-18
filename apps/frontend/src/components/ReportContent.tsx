import { useState, type ReactNode } from 'react';
import { CopyButton } from './CopyButton';

/**
 * Wraps any report content with a small toolbar: a user-controlled
 * collapse/expand toggle and an optional copy-to-clipboard button. When
 * collapsed, a placeholder note is shown in place of the content.
 */
export function CollapsibleSection({
  children,
  copyText,
  collapsedNote = 'Content collapsed — click Expand to show.',
  defaultCollapsed = false,
}: {
  children: ReactNode;
  copyText?: string;
  collapsedNote?: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div className="report-block">
      <div className="report-block-toolbar">
        <button
          type="button"
          className="report-block-btn"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand content' : 'Collapse content'}
        >
          {collapsed ? 'Expand ▼' : 'Collapse ▲'}
        </button>
        {copyText != null && <CopyButton text={copyText} />}
      </div>
      {collapsed ? (
        <div className="report-collapsed-note">{collapsedNote}</div>
      ) : (
        children
      )}
    </div>
  );
}

/** Collapsible markdown report body (copies the raw markdown source). */
export function ReportContent({
  html,
  markdown,
  className,
  defaultCollapsed = false,
}: {
  html: string;
  markdown: string;
  className?: string;
  defaultCollapsed?: boolean;
}) {
  return (
    <CollapsibleSection
      copyText={markdown}
      collapsedNote="Report collapsed — click Expand to show."
      defaultCollapsed={defaultCollapsed}
    >
      <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
    </CollapsibleSection>
  );
}
