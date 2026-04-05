import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import * as api from '../lib/api';
import type { BoardSyncResult, IssueChange, ActivityItem } from '../lib/api';

type BoardTab = 'issues' | 'activity';

export default function Boards() {
  const qc = useQueryClient();

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ['yt-config'],
    queryFn: api.getYouTrackConfig,
  });

  const [baseUrl, setBaseUrl] = useState('');
  const [showEditUrl, setShowEditUrl] = useState(false);

  useEffect(() => {
    if (config) setBaseUrl(config.base_url);
  }, [config]);

  const saveConfigMut = useMutation({
    mutationFn: () => api.setYouTrackConfig(baseUrl),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['yt-config'] });
      setShowEditUrl(false);
    },
  });

  const deleteConfigMut = useMutation({
    mutationFn: api.deleteYouTrackConfig,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['yt-config'] }),
  });

  const { data: boards = [] } = useQuery({
    queryKey: ['yt-boards'],
    queryFn: api.listYouTrackBoards,
    enabled: !!config,
  });

  const [boardUrl, setBoardUrl] = useState('');

  const addBoardMut = useMutation({
    mutationFn: () => api.addYouTrackBoard(boardUrl),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['yt-boards'] });
      setBoardUrl('');
    },
  });

  const removeBoardMut = useMutation({
    mutationFn: api.removeYouTrackBoard,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['yt-boards'] }),
  });

  const [syncResults, setSyncResults] = useState<BoardSyncResult[]>([]);
  const [syncing, setSyncing] = useState(false);

  async function handleSyncAll() {
    setSyncing(true);
    try {
      const results = await api.syncAllYouTrackBoards();
      setSyncResults(results);
      qc.invalidateQueries({ queryKey: ['yt-boards'] });
    } catch { /* ignore */ }
    setSyncing(false);
  }

  async function handleSyncOne(boardDbId: string) {
    setSyncing(true);
    try {
      const result = await api.syncYouTrackBoard(boardDbId);
      setSyncResults((prev) => {
        const next = prev.filter((r) => r.board_id !== result.board_id);
        return [result, ...next];
      });
      qc.invalidateQueries({ queryKey: ['yt-boards'] });
    } catch { /* ignore */ }
    setSyncing(false);
  }

  const [expandedBoardId, setExpandedBoardId] = useState<string | null>(null);

  if (configLoading) {
    return (
      <div className="page">
        <div className="empty-state">Loading...</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Boards</h2>
      </div>

      {!config ? (
        <div className="yt-config-setup">
          <p className="form-hint" style={{ marginBottom: 8 }}>
            Set your YouTrack base URL. API token must be set via <code>PT_YOUTRACK_API_TOKEN</code> env var.
          </p>
          <form className="settings-form" onSubmit={(e) => { e.preventDefault(); saveConfigMut.mutate(); }}>
            <div className="form-group">
              <label className="form-label">YouTrack URL</label>
              <input className="input" placeholder="https://youtrack.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
            <button className="btn btn-primary" type="submit" disabled={!baseUrl || saveConfigMut.isPending}>Connect</button>
          </form>
        </div>
      ) : (
        <div className="yt-config-bar">
          <span className="yt-config-url">{config.base_url}</span>
          {showEditUrl ? (
            <form className="yt-token-form" onSubmit={(e) => { e.preventDefault(); saveConfigMut.mutate(); }}>
              <input className="input" placeholder="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: 280 }} />
              <button className="btn btn-sm btn-primary" type="submit" disabled={!baseUrl}>Save</button>
              <button className="btn btn-sm" type="button" onClick={() => setShowEditUrl(false)}>Cancel</button>
            </form>
          ) : (
            <div className="yt-config-actions">
              <button className="btn btn-sm" onClick={() => setShowEditUrl(true)}>Edit</button>
              <button className="btn btn-sm btn-danger" onClick={() => deleteConfigMut.mutate()}>Disconnect</button>
            </div>
          )}
        </div>
      )}

      {config && (
        <>
          <form className="yt-add-board" onSubmit={(e) => { e.preventDefault(); if (boardUrl.trim()) addBoardMut.mutate(); }}>
            <input className="input" placeholder="Board URL (e.g. https://youtrack.example.com/agiles/123-45/current)" value={boardUrl} onChange={(e) => setBoardUrl(e.target.value)} style={{ flex: 1 }} />
            <button className="btn btn-primary" type="submit" disabled={!boardUrl.trim() || addBoardMut.isPending}>Add Board</button>
          </form>
          {addBoardMut.isError && <div className="error-banner">Failed to add board. Check the URL and PT_YOUTRACK_API_TOKEN env var.</div>}
        </>
      )}

      {boards.length > 0 && (
        <div className="yt-boards-header">
          <h3>Tracked Boards</h3>
          <button className="btn btn-sm btn-primary" onClick={handleSyncAll} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync All'}
          </button>
        </div>
      )}

      <div className="yt-board-list">
        {boards.map((board) => (
          <BoardCard
            key={board.id}
            board={board}
            syncing={syncing}
            onSync={() => handleSyncOne(board.id)}
            onRemove={() => removeBoardMut.mutate(board.id)}
            syncResult={syncResults.find((r) => r.board_id === board.id)}
            expanded={expandedBoardId === board.id}
            onToggle={() => setExpandedBoardId(expandedBoardId === board.id ? null : board.id)}
          />
        ))}
      </div>

      {config && boards.length === 0 && (
        <div className="empty-state">
          <p>No boards tracked yet. Add a YouTrack agile board URL above.</p>
        </div>
      )}
    </div>
  );
}

function BoardCard({
  board,
  syncing,
  onSync,
  onRemove,
  syncResult,
  expanded,
  onToggle,
}: {
  board: api.YouTrackBoard;
  syncing: boolean;
  onSync: () => void;
  onRemove: () => void;
  syncResult?: BoardSyncResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [tab, setTab] = useState<BoardTab>('issues');

  const { data: issues = [] } = useQuery({
    queryKey: ['yt-issues', board.id],
    queryFn: () => api.listBoardIssues(board.id),
    enabled: expanded && tab === 'issues' && !!board.last_synced_at,
  });

  const changes = syncResult?.changes ?? [];

  return (
    <div className="yt-board-card">
      <div className="yt-board-card-header" onClick={onToggle} style={{ cursor: 'pointer' }}>
        <div className="yt-board-info">
          <span className="yt-board-name">{board.board_name || board.board_id}</span>
          <span className="yt-board-meta">
            {board.last_synced_at ? `Synced ${dayjs(board.last_synced_at).fromNow()}` : 'Never synced'}
          </span>
        </div>
        <div className="yt-board-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-sm" onClick={onSync} disabled={syncing}>Sync</button>
          <button className="btn btn-sm btn-danger" onClick={onRemove}>Remove</button>
        </div>
      </div>

      {changes.length > 0 && (
        <div className="yt-changes">
          <div className="yt-changes-title">{changes.length} change{changes.length !== 1 ? 's' : ''} detected</div>
          {changes.map((c, i) => <ChangeRow key={i} change={c} baseUrl={board.board_url} />)}
        </div>
      )}

      {expanded && (
        <div className="yt-board-body">
          <div className="yt-tab-bar">
            <button className={`yt-tab${tab === 'issues' ? ' active' : ''}`} onClick={() => setTab('issues')}>Issues</button>
            <button className={`yt-tab${tab === 'activity' ? ' active' : ''}`} onClick={() => setTab('activity')}>Activity</button>
          </div>

          {tab === 'issues' && board.last_synced_at && (
            <div className="yt-issues">
              <div className="yt-issues-header">{issues.length} issues on board</div>
              <div className="yt-issues-list">
                {issues.map((iss) => (
                  <div key={iss.id} className="yt-issue-row">
                    <a href={issueUrl(board.board_url, iss.issue_id)} target="_blank" rel="noopener" className="yt-issue-id">{iss.issue_id}</a>
                    <span className="yt-issue-summary">{iss.summary}</span>
                    {iss.state && <span className="yt-issue-state">{iss.state}</span>}
                    {iss.assignee && <span className="yt-issue-assignee">{iss.assignee}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'activity' && (
            <ActivityPanel boardId={board.id} boardUrl={board.board_url} />
          )}
        </div>
      )}
    </div>
  );
}

function ActivityPanel({ boardId, boardUrl }: { boardId: string; boardUrl: string }) {
  const [since, setSince] = useState(() => dayjs().subtract(7, 'day').format('YYYY-MM-DD'));
  const [until, setUntil] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  async function handleFetch() {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.fetchBoardActivity(boardId, since, until);
      if (!mountedRef.current) return;
      setActivities(resp.activities);
      setLoaded(true);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e?.response?.data?.detail || 'Failed to fetch activity');
    }
    if (mountedRef.current) setLoading(false);
  }

  // Group activities by day
  const groups = groupActivitiesByDay(activities);

  return (
    <div className="yt-activity">
      <div className="yt-activity-toolbar">
        <label className="date-range-field">
          <span className="date-range-label">From</span>
          <input type="date" className="input" value={since} onChange={(e) => { if (e.target.value) setSince(e.target.value); }} />
        </label>
        <label className="date-range-field">
          <span className="date-range-label">To</span>
          <input type="date" className="input" value={until} onChange={(e) => { if (e.target.value) setUntil(e.target.value); }} />
        </label>
        <button className="btn btn-sm btn-primary" onClick={handleFetch} disabled={loading}>
          {loading ? 'Loading...' : 'Fetch Activity'}
        </button>
        {loaded && <span className="ce-count">{activities.length} events</span>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loaded && activities.length === 0 && (
        <div className="yt-activity-empty">No activity in this date range.</div>
      )}

      {groups.map((group) => (
        <div key={group.day} className="yt-activity-day">
          <div className="yt-activity-day-header">{dayjs(group.day).format('ddd, MMM D')}</div>
          {group.items.map((item, i) => (
            <ActivityRow key={i} item={item} boardUrl={boardUrl} />
          ))}
        </div>
      ))}
    </div>
  );
}

function ActivityRow({ item, boardUrl }: { item: ActivityItem; boardUrl: string }) {
  const time = dayjs(item.timestamp).format('HH:mm');
  const typeClass = `yt-act-${item.activity_type}`;

  let description = '';
  switch (item.activity_type) {
    case 'created':
      description = 'created';
      break;
    case 'resolved':
      description = 'resolved';
      break;
    case 'comment':
      description = 'commented';
      break;
    case 'field_change':
      if (item.old_value && item.new_value) {
        description = `${item.field}: ${item.old_value} → ${item.new_value}`;
      } else if (item.new_value) {
        description = `${item.field} set to ${item.new_value}`;
      } else if (item.old_value) {
        description = `${item.field} cleared (was ${item.old_value})`;
      } else {
        description = `${item.field} changed`;
      }
      break;
  }

  return (
    <div className={`yt-activity-row ${typeClass}`}>
      <span className="yt-activity-time">{time}</span>
      <a href={issueUrl(boardUrl, item.issue_id)} target="_blank" rel="noopener" className="yt-issue-id">{item.issue_id}</a>
      <span className="yt-activity-desc">{description}</span>
      {item.author && <span className="yt-activity-author">{item.author}</span>}
      {item.comment_text && (
        <div className="yt-activity-comment">{item.comment_text}</div>
      )}
    </div>
  );
}

function ChangeRow({ change, baseUrl }: { change: IssueChange; baseUrl: string }) {
  const typeClass = change.change_type === 'added' ? 'yt-change-added' : change.change_type === 'removed' ? 'yt-change-removed' : 'yt-change-updated';

  return (
    <div className={`yt-change-row ${typeClass}`}>
      <span className="yt-change-type">{change.change_type}</span>
      <a href={issueUrl(baseUrl, change.issue_id)} target="_blank" rel="noopener" className="yt-issue-id">{change.issue_id}</a>
      <span className="yt-change-summary">{change.summary}</span>
      {change.old_state && change.new_state && <span className="yt-change-detail">{change.old_state} → {change.new_state}</span>}
      {change.old_assignee !== null && change.new_assignee !== null && <span className="yt-change-detail">{change.old_assignee || 'unassigned'} → {change.new_assignee || 'unassigned'}</span>}
    </div>
  );
}

function issueUrl(boardUrl: string, issueId: string): string {
  const m = boardUrl.match(/^(https?:\/\/[^/]+)/);
  if (m) return `${m[1]}/issue/${issueId}`;
  return `#${issueId}`;
}

function groupActivitiesByDay(items: ActivityItem[]): { day: string; items: ActivityItem[] }[] {
  const map = new Map<string, ActivityItem[]>();
  for (const item of items) {
    const day = dayjs(item.timestamp).format('YYYY-MM-DD');
    const arr = map.get(day);
    if (arr) arr.push(item);
    else map.set(day, [item]);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, items]) => ({ day, items }));
}
