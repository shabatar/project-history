import dayjs from 'dayjs';
import type { ActivityItem } from './api';

/** One activity event as a readable line (local time). */
function eventLine(it: ActivityItem, withIssue: boolean): string {
  const t = dayjs(it.timestamp).format('YYYY-MM-DD HH:mm');
  let body: string;
  switch (it.activity_type) {
    case 'created':
      body = `created: ${it.issue_summary}`;
      break;
    case 'resolved':
      body = 'resolved';
      break;
    case 'comment':
      body = `commented: ${it.comment_text ?? ''}`;
      break;
    case 'field_change':
      body = `${it.field}: ${it.old_value ?? '∅'} → ${it.new_value ?? '∅'}`;
      break;
    default:
      body = it.activity_type;
  }
  const issue = withIssue ? `${it.issue_id} ` : '';
  const who = it.author ? ` (${it.author})` : '';
  return `${t} — ${issue}${body}${who}`;
}

/** Activity for a single issue: a header line plus indented, chronological events. */
export function issueActivityToText(
  issueId: string,
  summary: string,
  items: ActivityItem[],
): string {
  const sorted = [...items].sort((a, b) => a.timestamp - b.timestamp);
  const header = summary ? `${issueId} — ${summary}` : issueId;
  return [header, ...sorted.map((it) => `  ${eventLine(it, false)}`)].join('\n');
}

/** A flat, chronological text list of events (issue id on each line). */
export function activityItemsToText(items: ActivityItem[]): string {
  return [...items]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((it) => eventLine(it, true))
    .join('\n');
}
