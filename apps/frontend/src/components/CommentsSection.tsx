import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../lib/api';
import { renderMarkdown } from './SummaryPanel';
import { useAppStore } from '../store';

interface Props {
  summaryType: 'git' | 'activity' | 'activity-snapshot' | 'git-snapshot';
  summaryId: string;
}

export function CommentsSection({ summaryType, summaryId }: Props) {
  const qc = useQueryClient();
  const savedQuestions = useAppStore((s) => s.settings.savedQuestions ?? []);
  const qKey = ['comments', summaryType, summaryId];

  const { data: comments = [], isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => api.listComments(summaryType, summaryId),
  });

  const [text, setText] = useState('');
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const addNote = useMutation({
    mutationFn: () => api.createComment(summaryType, summaryId, { comment_type: 'note', user_content: text }),
    onSuccess: () => {
      setText('');
      qc.invalidateQueries({ queryKey: qKey });
    },
  });

  const deleteComment = useMutation({
    mutationFn: (id: string) => api.deleteComment(summaryType, summaryId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qKey }),
  });

  async function handleAskAI() {
    const question = text.trim();
    if (!question) return;

    const comment = await api.createComment(summaryType, summaryId, { comment_type: 'request', user_content: question });
    setText('');
    qc.invalidateQueries({ queryKey: qKey });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreamingId(comment.id);
    setStreamError(null);

    try {
      await api.streamGenerateReply(
        summaryType,
        summaryId,
        comment.id,
        {
          signal: ctrl.signal,
          onEvent: (ev) => {
            if (ev.type === 'done') {
              setStreamingId(null);
              qc.invalidateQueries({ queryKey: qKey });
            } else if (ev.type === 'error') {
              setStreamError(ev.detail);
              setStreamingId(null);
              qc.invalidateQueries({ queryKey: qKey });
            }
          },
        },
      );
    } catch (e: unknown) {
      if ((e as Error)?.name !== 'AbortError') {
        setStreamError((e as Error)?.message || 'Generation failed');
      }
      setStreamingId(null);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }

  const canSubmit = text.trim().length > 0;
  const isStreaming = streamingId !== null;

  return (
    <div className="cs-section">
      <h4 className="cs-heading">Notes &amp; Follow-ups</h4>

      {isLoading && <p className="cs-loading">Loading…</p>}

      {comments.length > 0 && (
        <ul className="cs-list">
          {comments.map((c) => {
            const isThisStreaming = streamingId === c.id;
            return (
              <li key={c.id} className={`cs-item cs-item-${c.comment_type}`}>
                <div className="cs-item-header">
                  <span className={`cs-badge cs-badge-${c.comment_type}`}>
                    {c.comment_type === 'note' ? 'Note' : 'Ask AI'}
                  </span>
                  <span className="cs-ts">{new Date(c.created_at).toLocaleString()}</span>
                  <button
                    className="cs-delete"
                    onClick={() => deleteComment.mutate(c.id)}
                    title="Delete"
                    disabled={isThisStreaming}
                  >
                    ×
                  </button>
                </div>
                <p className="cs-user-content">{c.user_content}</p>
                {c.comment_type === 'request' && (
                  <div className="cs-ai-response">
                    {isThisStreaming && <span className="cs-thinking">Thinking…</span>}
                    {!isThisStreaming && c.ai_response && (
                      <div className="cs-ai-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.ai_response, null) }} />
                    )}
                    {!isThisStreaming && c.ai_status === 'error' && (
                      <p className="cs-error">{c.ai_error || 'Generation failed'}</p>
                    )}
                    {!isThisStreaming && c.ai_status === 'pending' && (
                      <span className="cs-thinking">Pending…</span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {streamError && <p className="cs-error">{streamError}</p>}

      {savedQuestions.length > 0 && (
        <div className="cs-suggestions">
          <span className="cs-suggestions-label">Quick questions</span>
          <div className="cs-suggestion-chips">
            {savedQuestions.map((q, i) => (
              <button
                key={i}
                className="cs-suggestion-chip"
                onClick={() => setText(q)}
                disabled={isStreaming}
                title={q}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="cs-input-row">
        <textarea
          className="input cs-textarea"
          placeholder="Add a note or ask a follow-up question…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          disabled={isStreaming}
        />
        <div className="cs-actions">
          <button
            className="btn btn-sm"
            onClick={() => addNote.mutate()}
            disabled={!canSubmit || isStreaming || addNote.isPending}
          >
            Save note
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={handleAskAI}
            disabled={!canSubmit || isStreaming}
          >
            Ask AI
          </button>
          {isStreaming && (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => { abortRef.current?.abort(); setStreamingId(null); }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
