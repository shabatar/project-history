import { useState } from 'react';

/** Small copy-to-clipboard button with transient "Copied ✓" feedback. */
export function CopyButton({
  text,
  label = 'Copy',
  className = 'report-block-btn',
  title = 'Copy to clipboard',
}: {
  text: string;
  label?: string;
  className?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <button type="button" className={className} onClick={copy} title={title}>
      {copied ? 'Copied ✓' : label}
    </button>
  );
}
