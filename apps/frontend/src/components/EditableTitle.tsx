import { useState, useRef } from 'react';

interface Props {
  defaultTitle: string;
  userLabel: string | null;
  onSave: (label: string | null) => Promise<void>;
}

export function EditableTitle({ defaultTitle, userLabel, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setValue(userLabel ?? defaultTitle);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  async function commit() {
    const trimmed = value.trim();
    const next = trimmed || null;
    if (next === (userLabel ?? null)) {
      setEditing(false);
      return;
    }
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // keep editor open so user can retry or press Escape to cancel
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="snap-detail-title-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        autoFocus
      />
    );
  }

  return (
    <h2
      className={`snap-detail-title${userLabel ? ' snap-detail-title-custom' : ''}`}
      onDoubleClick={startEdit}
      title="Double-click to rename"
    >
      {userLabel ?? defaultTitle}
    </h2>
  );
}
