/** Source picker (project combobox or board chips) + date-range toolbar. */

import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import type { YouTrackBoard, YouTrackProject } from '../../lib/api';
import { PRESET_LABELS, type RangePreset, type Scope } from './types';

const ALL_PRESETS: RangePreset[] = ['yesterday', 'last-week', 'last-month', 'last-3-months', 'custom'];
const COMBOBOX_LIST_CAP = 100;

export interface FlowToolbarProps {
  scope: Scope;

  projects: YouTrackProject[];
  projectsLoading: boolean;
  selectedProject: YouTrackProject | null;
  onSelectProject: (p: YouTrackProject | null) => void;

  boards: YouTrackBoard[];
  boardsLoading: boolean;
  selectedBoard: YouTrackBoard | null;
  onSelectBoard: (b: YouTrackBoard | null) => void;

  preset: RangePreset;
  onPresetChange: (p: RangePreset) => void;
  customSince: string;
  customUntil: string;
  onCustomSinceChange: (d: string) => void;
  onCustomUntilChange: (d: string) => void;

  since: string;
  until: string;

  loading: boolean;
  hasSelection: boolean;
  onFetch: () => void;
  onCancel: () => void;
}

export function FlowToolbar(props: FlowToolbarProps) {
  return (
    <div className="pf-toolbar">
      {props.scope === 'project'
        ? <ProjectPicker {...props} />
        : <BoardPicker {...props} />}
      <RangeRow {...props} />
    </div>
  );
}

function ProjectPicker({
  projects, projectsLoading, selectedProject, onSelectProject,
}: FlowToolbarProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects.slice(0, COMBOBOX_LIST_CAP);
    return projects
      .filter((p) =>
        p.short_name.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q),
      )
      .slice(0, COMBOBOX_LIST_CAP);
  }, [projects, query]);

  const display = selectedProject
    ? `${selectedProject.short_name} · ${selectedProject.name}`
    : query;

  return (
    <div className="pf-project-picker" ref={ref}>
      <label className="date-range-label">Project</label>
      <div className="pf-combobox">
        <input
          className="input"
          placeholder={projectsLoading ? 'Loading projects…' : `Search ${projects.length} projects…`}
          value={open ? query : display}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          disabled={projectsLoading}
        />
        {open && matches.length > 0 && (
          <div className="pf-combobox-list" role="listbox">
            {matches.map((p) => (
              <button
                type="button"
                key={p.id}
                className={`pf-combobox-item${selectedProject?.id === p.id ? ' selected' : ''}`}
                onClick={() => { onSelectProject(p); setOpen(false); setQuery(''); }}
              >
                <span className="pf-combobox-short">{p.short_name}</span>
                <span className="pf-combobox-name">{p.name}</span>
              </button>
            ))}
            {projects.length > matches.length && (
              <div className="pf-combobox-more">
                Showing {matches.length} of {projects.length} — refine your search.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BoardPicker({
  boards, boardsLoading, selectedBoard, onSelectBoard,
}: FlowToolbarProps) {
  return (
    <div className="pf-project-picker">
      <label className="date-range-label">Board</label>
      <div className="pf-board-picker">
        {boardsLoading ? (
          <span className="form-hint">Loading tracked boards…</span>
        ) : boards.length === 0 ? (
          <span className="form-hint">
            No tracked boards. Add one on the <a href="/boards">Boards page</a>.
          </span>
        ) : (
          boards.map((b) => (
            <button
              type="button"
              key={b.id}
              className={`pf-board-chip${selectedBoard?.id === b.id ? ' active' : ''}`}
              onClick={() => onSelectBoard(b)}
              title={b.board_name || b.board_id}
            >
              {b.board_name || b.board_id}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function RangeRow({
  preset, onPresetChange, customSince, customUntil, onCustomSinceChange, onCustomUntilChange,
  since, until, loading, hasSelection, scope, onFetch, onCancel,
}: FlowToolbarProps) {
  return (
    <div className="pf-range-row">
      <label className="date-range-label">Range</label>
      <div className="pf-preset-row">
        {ALL_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`yt-compare-chip${preset === p ? ' active' : ''}`}
            onClick={() => onPresetChange(p)}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="pf-custom-dates">
          <input
            type="date"
            className="input"
            value={customSince}
            max={customUntil}
            onChange={(e) => { if (e.target.value) onCustomSinceChange(e.target.value); }}
          />
          <span className="pf-range-sep">→</span>
          <input
            type="date"
            className="input"
            value={customUntil}
            max={dayjs().format('YYYY-MM-DD')}
            onChange={(e) => { if (e.target.value) onCustomUntilChange(e.target.value); }}
          />
        </div>
      )}
      <span className="pf-range-hint">
        {dayjs(since).format('MMM D')} → {dayjs(until).format('MMM D, YYYY')}
      </span>
      {loading ? (
        <button className="btn btn-danger" onClick={onCancel}>Cancel</button>
      ) : (
        <button
          className="btn btn-primary"
          onClick={onFetch}
          disabled={!hasSelection}
          title={
            hasSelection
              ? ''
              : (scope === 'board' ? 'Pick a board first' : 'Pick a project first')
          }
        >
          Fetch
        </button>
      )}
    </div>
  );
}
