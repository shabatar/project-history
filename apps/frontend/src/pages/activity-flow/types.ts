/** Shared types and small helpers for the Activity Flow page. */

import dayjs from 'dayjs';
import type { ActivityItem } from '../../lib/api';

export type Scope = 'board' | 'project';
export type ViewMode = 'timeline' | 'by-issue';
export type SummaryStyle = 'short' | 'detailed' | 'manager';
export type RangePreset =
  | 'yesterday'
  | 'last-week'
  | 'last-month'
  | 'last-3-months'
  | 'custom';

export const TYPE_KEYS = ['created', 'resolved', 'comment', 'state', 'assignee', 'other'] as const;
export type TypeKey = (typeof TYPE_KEYS)[number];

export const TYPE_LABEL: Record<TypeKey, string> = {
  created: 'Created',
  resolved: 'Resolved',
  comment: 'Comments',
  state: 'State changes',
  assignee: 'Assignee changes',
  other: 'Other fields',
};

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export const LOG_CAP = 100;

/** Normalized summary payload shared by board and project scopes. */
export interface UnifiedSummary {
  label: string;
  since: string;
  until: string;
  summary_style: SummaryStyle;
  model_name: string;
  activity_count: number;
  summary_markdown: string;
  used_llm: boolean;
}

export interface FetchProgress {
  phase: string;
  done: number;
  total: number;
  events_so_far: number;
}

/** Map an ActivityItem to a UI filter bucket. */
export function classifyItem(item: ActivityItem): TypeKey {
  if (item.activity_type === 'created') return 'created';
  if (item.activity_type === 'resolved') return 'resolved';
  if (item.activity_type === 'comment') return 'comment';
  if (item.activity_type === 'field_change') {
    const field = (item.field || '').toLowerCase();
    if (field === 'state') return 'state';
    if (field === 'assignee') return 'assignee';
    return 'other';
  }
  return 'other';
}

/** Convert a preset (non-custom) to a YYYY-MM-DD start date. */
export function presetToDate(preset: Exclude<RangePreset, 'custom'>): string {
  const now = dayjs();
  switch (preset) {
    case 'yesterday': return now.subtract(1, 'day').format('YYYY-MM-DD');
    case 'last-week': return now.subtract(7, 'day').format('YYYY-MM-DD');
    case 'last-month': return now.subtract(1, 'month').format('YYYY-MM-DD');
    case 'last-3-months': return now.subtract(3, 'month').format('YYYY-MM-DD');
  }
}

export const PRESET_LABELS: Record<RangePreset, string> = {
  yesterday: 'Yesterday',
  'last-week': 'Last week',
  'last-month': 'Last month',
  'last-3-months': '3 months',
  custom: 'Custom',
};
