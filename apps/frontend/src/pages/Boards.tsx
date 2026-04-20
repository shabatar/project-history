import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import * as api from '../lib/api';
import type { BoardSyncResult, IssueChange, ActivityItem } from '../lib/api';
import { renderMarkdown } from '../components/SummaryPanel';
import { userUrl, baseFromUrl } from '../lib/youtrackLinks';

type BoardTab = 'issues' | 'activity';

type ComparePreset = 'last-sync' | 'yesterday' | 'last-week' | 'last-month' | 'last-3-months' | 'custom';

const PRESET_LABELS: Record<ComparePreset, string> = {
  'last-sync': 'Last sync',
  yesterday: 'Yesterday',
  'last-week': 'Last week',
  'last-month': 'Last month',
  'last-3-months': '3 months',
  custom: 'Custom',
};

function presetToDate(preset: Exclude<ComparePreset, 'last-sync' | 'custom'>): string {
  const now = dayjs();
  switch (preset) {
    case 'yesterday': return now.subtract(1, 'day').format('YYYY-MM-DD');
    case 'last-week': return now.subtract(7, 'day').format('YYYY-MM-DD');
    case 'last-month': return now.subtract(1, 'month').format('YYYY-MM-DD');
    case 'last-3-months': return now.subtract(3, 'month').format('YYYY-MM-DD');
  }
}

export default function Boards() {
  const qc = useQueryClient();

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ['yt-config'],
    queryFn: api.getYouTrackConfig,
  });

  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [showEditUrl, setShowEditUrl] = useState(false);
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [testResult, setTestResult] = useState<api.YouTrackTestResult | null>(null);

  useEffect(() => {
    if (config) setBaseUrl(config.base_url);
  }, [config]);

  const saveConfigMut = useMutation({
    mutationFn: (input: api.YouTrackConfigInput) => api.setYouTrackConfig(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['yt-config'] });
      setShowEditUrl(false);
      setShowTokenForm(false);
      setToken('');
    },
  });

  const deleteConfigMut = useMutation({
    mutationFn: api.deleteYouTrackConfig,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['yt-config'] });
      setTestResult(null);
    },
  });

  const clearTokenMut = useMutation({
    mutationFn: api.clearYouTrackToken,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['yt-config'] });
      setTestResult(null);
    },
  });

  const testConnMut = useMutation({
    mutationFn: (input: { base_url?: string; api_token?: string }) =>
      api.testYouTrackConnection(input),
    onSuccess: (result) => setTestResult(result),
    onError: () => setTestResult({ ok: false, detail: 'Request failed', username: null }),
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
  const [comparePreset, setComparePreset] = useState<ComparePreset>('last-sync');
  const [customDate, setCustomDate] = useState(() => dayjs().subtract(7, 'day').format('YYYY-MM-DD'));

  const effectiveSince = comparePreset === 'last-sync'
    ? null
    : comparePreset === 'custom'
      ? (customDate || null)
      : presetToDate(comparePreset);

  async function handleSyncAll() {
    setSyncing(true);
    try {
      const results = await api.syncAllYouTrackBoards(effectiveSince);
      setSyncResults(results);
      qc.invalidateQueries({ queryKey: ['yt-boards'] });
    } catch { /* ignore */ }
    setSyncing(false);
  }

  async function handleSyncOne(boardDbId: string) {
    setSyncing(true);
    try {
      const result = await api.syncYouTrackBoard(boardDbId, effectiveSince);
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
            Enter your YouTrack base URL and API token. The token is encrypted at rest and never returned to the UI.
          </p>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveConfigMut.mutate({ base_url: baseUrl, api_token: token || null });
            }}
          >
            <div className="form-group">
              <label className="form-label">YouTrack URL</label>
              <input
                className="input"
                placeholder="https://youtrack.example.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="form-group">
              <label className="form-label">API Token</label>
              <input
                className="input"
                type="password"
                placeholder="perm:..."
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="form-hint" style={{ marginTop: 4 }}>
                Generate one in YouTrack → Profile → Account Security → New permanent token.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={!baseUrl || saveConfigMut.isPending}
              >
                {saveConfigMut.isPending ? 'Saving...' : 'Connect'}
              </button>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  testConnMut.mutate({
                    base_url: baseUrl || undefined,
                    api_token: token || undefined,
                  })
                }
                disabled={!baseUrl || !token || testConnMut.isPending}
              >
                {testConnMut.isPending ? 'Testing...' : 'Test connection'}
              </button>
            </div>
          </form>
          {testResult && <TestResultBanner result={testResult} />}
        </div>
      ) : (
        <>
          <div className="yt-config-bar">
            <span className="yt-config-url">{config.base_url}</span>
            <TokenStatusChip config={config} />
            {showEditUrl ? (
              <form
                className="yt-token-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveConfigMut.mutate({ base_url: baseUrl });
                }}
              >
                <input
                  className="input"
                  placeholder="Base URL"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  style={{ width: 280 }}
                />
                <button className="btn btn-sm btn-primary" type="submit" disabled={!baseUrl}>
                  Save
                </button>
                <button className="btn btn-sm" type="button" onClick={() => setShowEditUrl(false)}>
                  Cancel
                </button>
              </form>
            ) : (
              <div className="yt-config-actions">
                <button className="btn btn-sm" onClick={() => setShowEditUrl(true)}>
                  Edit URL
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setShowTokenForm((s) => !s);
                    setToken('');
                    setTestResult(null);
                  }}
                >
                  {config.token_configured && config.token_source === 'db'
                    ? 'Change token'
                    : 'Set token'}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    testConnMut.mutate({ base_url: config.base_url })
                  }
                  disabled={!config.token_configured || testConnMut.isPending}
                  title={
                    !config.token_configured
                      ? 'No token configured'
                      : 'Test the stored token against YouTrack'
                  }
                >
                  {testConnMut.isPending ? 'Testing...' : 'Test'}
                </button>
                {config.token_source === 'db' && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      if (confirm('Clear the stored YouTrack token? (Env var, if set, will still be used.)')) {
                        clearTokenMut.mutate();
                      }
                    }}
                  >
                    Clear token
                  </button>
                )}
                <button className="btn btn-sm btn-danger" onClick={() => deleteConfigMut.mutate()}>
                  Disconnect
                </button>
              </div>
            )}
          </div>

          {showTokenForm && config.token_source !== 'env' && (
            <form
              className="yt-token-form"
              style={{ margin: '8px 0', gap: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (token) saveConfigMut.mutate({ base_url: config.base_url, api_token: token });
              }}
            >
              <input
                className="input"
                type="password"
                placeholder="New API token (perm:...)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 280 }}
              />
              <button
                className="btn btn-sm btn-primary"
                type="submit"
                disabled={!token || saveConfigMut.isPending}
              >
                Save token
              </button>
              <button
                className="btn btn-sm"
                type="button"
                onClick={() =>
                  testConnMut.mutate({ base_url: config.base_url, api_token: token })
                }
                disabled={!token || testConnMut.isPending}
              >
                Test first
              </button>
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => { setShowTokenForm(false); setToken(''); }}
              >
                Cancel
              </button>
            </form>
          )}

          {showTokenForm && config.token_source === 'env' && (
            <div className="form-hint" style={{ marginTop: 8 }}>
              Token is currently supplied via the <code>PT_YOUTRACK_API_TOKEN</code> env var and takes precedence over any UI value. Unset the env var to manage the token here.
            </div>
          )}

          {testResult && <TestResultBanner result={testResult} />}

          <form
            className="yt-add-board"
            onSubmit={(e) => {
              e.preventDefault();
              if (boardUrl.trim()) addBoardMut.mutate();
            }}
          >
            <input
              className="input"
              placeholder="Board URL (e.g. https://youtrack.example.com/agiles/123-45/current)"
              value={boardUrl}
              onChange={(e) => setBoardUrl(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={!boardUrl.trim() || addBoardMut.isPending}
            >
              Add Board
            </button>
          </form>
          {addBoardMut.isError && (
            <div className="error-banner">
              Failed to add board. Check the URL and that your YouTrack token is valid.
            </div>
          )}
        </>
      )}

      {boards.length > 0 && (
        <>
          <div className="yt-boards-header">
            <h3>Tracked Boards</h3>
            <button className="btn btn-sm btn-primary" onClick={handleSyncAll} disabled={syncing}>
              {syncing ? 'Syncing...' : 'Sync All'}
            </button>
          </div>
          <ComparePresetBar
            preset={comparePreset}
            onPresetChange={setComparePreset}
            customDate={customDate}
            onCustomDateChange={setCustomDate}
            effectiveSince={effectiveSince}
          />
        </>
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

      {syncResult && (
        <div className="yt-changes">
          <div className="yt-changes-title">
            {changes.length} change{changes.length !== 1 ? 's' : ''} detected
            <span className="yt-baseline-note">
              {' · '}
              {syncResult.baseline_synced_at
                ? `compared to ${syncResult.since ? dayjs(syncResult.since).format('MMM D') : dayjs(syncResult.baseline_synced_at).fromNow()} (${dayjs(syncResult.baseline_synced_at).format('MMM D, HH:mm')})`
                : 'no earlier baseline — every issue is counted as new'}
            </span>
          </div>
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

  const [summaryStyle, setSummaryStyle] = useState<'short' | 'detailed' | 'manager'>('detailed');
  const [summary, setSummary] = useState<api.ActivitySummaryResponse | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  async function handleFetch() {
    setLoading(true);
    setError(null);
    setSummary(null);
    setSummaryError(null);
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

  async function handleSummarize() {
    setSummarizing(true);
    setSummaryError(null);
    try {
      const resp = await api.summarizeBoardActivity(boardId, {
        since,
        until,
        summary_style: summaryStyle,
      });
      if (!mountedRef.current) return;
      setSummary(resp);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setSummaryError(e?.response?.data?.detail || 'Failed to summarize activity');
    }
    if (mountedRef.current) setSummarizing(false);
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

        <div className="yt-summary-controls">
          <label className="date-range-field">
            <span className="date-range-label">Style</span>
            <select
              className="input"
              value={summaryStyle}
              onChange={(e) => setSummaryStyle(e.target.value as 'short' | 'detailed' | 'manager')}
              disabled={summarizing}
            >
              <option value="short">Short</option>
              <option value="detailed">Detailed</option>
              <option value="manager">Manager</option>
            </select>
          </label>
          <button
            className="btn btn-sm"
            onClick={handleSummarize}
            disabled={!loaded || activities.length === 0 || summarizing}
            title={
              !loaded
                ? 'Fetch activity first'
                : activities.length === 0
                  ? 'No activity to summarize'
                  : 'Generate an AI summary of this activity'
            }
          >
            {summarizing ? 'Summarizing...' : 'Summarize with AI'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {summaryError && <div className="error-banner">{summaryError}</div>}

      {summary && <ActivitySummaryCard summary={summary} />}

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
      {item.author && (() => {
        const href = userUrl(baseFromUrl(boardUrl), item.author_login);
        return href
          ? <a href={href} target="_blank" rel="noopener" className="yt-activity-author">{item.author}</a>
          : <span className="yt-activity-author">{item.author}</span>;
      })()}
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

function ActivitySummaryCard({ summary }: { summary: api.ActivitySummaryResponse }) {
  // Issue-id refs (e.g. PROJ-123) are auto-linked by the globally-configured
  // issue tracker (see Settings → Issue Tracker / main.tsx), so we pass null
  // for repoContext.
  return (
    <article className="yt-summary-card">
      <header className="yt-summary-header">
        <div className="yt-summary-meta">
          <span className={`yt-summary-tag yt-summary-tag-${summary.summary_style}`}>
            {summary.summary_style}
          </span>
          <span className="yt-summary-sub">
            {summary.activity_count} event{summary.activity_count !== 1 ? 's' : ''} ·{' '}
            {summary.since} → {summary.until} · {summary.model_name}
          </span>
        </div>
        {!summary.used_llm && (
          <span className="yt-summary-fallback" title="Ollama was unreachable — deterministic fallback summary">
            fallback
          </span>
        )}
      </header>
      <div
        className="summary-markdown"
        dangerouslySetInnerHTML={{
          __html: renderMarkdown(summary.summary_markdown, null),
        }}
      />
    </article>
  );
}

function ComparePresetBar({
  preset,
  onPresetChange,
  customDate,
  onCustomDateChange,
  effectiveSince,
}: {
  preset: ComparePreset;
  onPresetChange: (p: ComparePreset) => void;
  customDate: string;
  onCustomDateChange: (d: string) => void;
  effectiveSince: string | null;
}) {
  const presets: ComparePreset[] = ['last-sync', 'yesterday', 'last-week', 'last-month', 'last-3-months', 'custom'];
  return (
    <div className="yt-compare-bar">
      <span className="yt-compare-label">Compare to:</span>
      <div className="yt-compare-presets">
        {presets.map((p) => (
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
        <input
          type="date"
          className="input"
          value={customDate}
          max={dayjs().format('YYYY-MM-DD')}
          onChange={(e) => { if (e.target.value) onCustomDateChange(e.target.value); }}
          style={{ width: 160 }}
        />
      )}
      {effectiveSince && (
        <span className="yt-compare-hint">
          vs. snapshot on/before {dayjs(effectiveSince).format('MMM D, YYYY')}
        </span>
      )}
    </div>
  );
}

function TokenStatusChip({ config }: { config: api.YouTrackConfig }) {
  if (!config.token_configured) {
    return <span className="yt-token-chip yt-token-chip-missing">Token: not configured</span>;
  }
  const label = config.token_source === 'env' ? 'env' : 'stored';
  return <span className="yt-token-chip yt-token-chip-ok">Token: {label}</span>;
}

function TestResultBanner({ result }: { result: api.YouTrackTestResult }) {
  if (result.ok) {
    return (
      <div className="success-banner" style={{ margin: '8px 0' }}>
        Connected{result.username ? ` as ${result.username}` : ''}.
      </div>
    );
  }
  return (
    <div className="error-banner" style={{ margin: '8px 0' }}>
      {result.detail || 'Connection failed'}
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
