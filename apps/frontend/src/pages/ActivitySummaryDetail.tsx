import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import * as api from '../lib/api';
import { renderMarkdown } from '../components/SummaryPanel';
import { CommentsSection } from '../components/CommentsSection';
import { EditableTitle } from '../components/EditableTitle';

const styleLabels: Record<string, string> = {
  short: 'Brief',
  detailed: 'Detailed',
  custom: 'Custom',
};

export default function ActivitySummaryDetail() {
  const { summaryId } = useParams<{ summaryId: string }>();
  const qc = useQueryClient();

  const { data: summary, isLoading, isError } = useQuery({
    queryKey: ['activity-summary', summaryId],
    queryFn: () => api.getActivitySummary(summaryId!),
    enabled: !!summaryId,
  });

  if (isLoading) return <div className="page"><div className="empty-state">Loading…</div></div>;
  if (isError || !summary) {
    return (
      <div className="page">
        <div className="error-banner">Summary not found.</div>
        <Link to="/summaries" className="btn" style={{ marginTop: 12 }}>Back to Reports</Link>
      </div>
    );
  }

  return (
    <div className="page summ-detail-page">
      <div className="page-header">
        <Link to="/summaries" className="snap-detail-back">← Reports</Link>
        <EditableTitle
          defaultTitle={summary.source_name}
          userLabel={summary.user_label}
          onSave={async (label) => {
            await api.patchItemLabel('activity-summary', summary.id, label);
            qc.invalidateQueries({ queryKey: ['activity-summary', summaryId] });
            qc.invalidateQueries({ queryKey: ['activity-summaries'] });
          }}
        />
      </div>

      <div className="snap-detail-meta">
        <span className="snap-meta-pill">{summary.source_type === 'board' ? 'Board' : 'Project'}</span>
        <span>{summary.since} → {summary.until}</span>
        <span className="snap-detail-count">{summary.activity_count} events</span>
        <span className="summ-detail-style">{styleLabels[summary.summary_style] ?? summary.summary_style}</span>
        <span className="summ-detail-model">{summary.model_name}</span>
        <span className="snap-detail-saved">Generated {dayjs(summary.generated_at).fromNow()}</span>
      </div>

      {summary.custom_prompt && (
        <p className="yt-summary-custom-prompt summ-detail-prompt">
          <em>Prompt:</em> {summary.custom_prompt}
        </p>
      )}

      <div className="report-content summ-detail-content"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(summary.summary_markdown, null) }}
      />

      <div className="snap-detail-comments">
        <CommentsSection summaryType="activity" summaryId={summary.id} />
      </div>
    </div>
  );
}
