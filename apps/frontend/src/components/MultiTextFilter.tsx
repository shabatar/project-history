import { useState } from 'react';

/**
 * Match a haystack against a list of filter terms.
 *
 * A term prefixed with "-" is an exclusion. A row is kept when it matches NONE
 * of the exclusions and (when any include terms exist) at least ONE include
 * term (OR). With only exclusions, everything not excluded is kept.
 */
export function matchesTerms(haystack: string, terms: string[]): boolean {
  const hay = haystack.toLowerCase();
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    if (!t || t === '-') continue;
    if (t.startsWith('-')) excludes.push(t.slice(1).toLowerCase());
    else includes.push(t.toLowerCase());
  }
  if (excludes.some((e) => hay.includes(e))) return false;
  if (includes.length === 0) return true;
  return includes.some((i) => hay.includes(i));
}

/**
 * A search box that accumulates multiple text filters as removable chips: type a
 * term and press Enter to pin it; prefix with "-" to exclude. The pinned chips
 * are controlled by the parent (`chips` / `onChange`) so they can be persisted.
 * Backspace on an empty input removes the last chip.
 */
export function MultiTextFilter({
  chips,
  onChange,
  placeholder,
  className,
}: {
  chips: string[];
  onChange: (chips: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const [input, setInput] = useState('');

  function addChip() {
    const t = input.trim();
    setInput('');
    if (t && !chips.includes(t)) onChange([...chips, t]);
  }

  function removeChip(c: string) {
    onChange(chips.filter((x) => x !== c));
  }

  return (
    <div className={`mtf${className ? ' ' + className : ''}`}>
      {chips.map((c) => (
        <span key={c} className={`mtf-chip${c.startsWith('-') ? ' mtf-chip-exclude' : ''}`}>
          {c}
          <button
            type="button"
            className="mtf-chip-x"
            onClick={() => removeChip(c)}
            title={`Remove filter "${c}"`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="input mtf-input"
        placeholder={chips.length ? 'Add filter…' : placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            addChip();
          } else if (e.key === 'Backspace' && !input && chips.length) {
            removeChip(chips[chips.length - 1]);
          }
        }}
      />
    </div>
  );
}
