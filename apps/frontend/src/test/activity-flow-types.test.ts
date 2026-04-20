import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { classifyItem, presetToDate } from '../pages/activity-flow/types';
import type { ActivityItem } from '../lib/api';

function makeItem(partial: Partial<ActivityItem>): ActivityItem {
  return {
    timestamp: 0,
    issue_id: 'PROJ-1',
    issue_summary: '',
    author: '',
    author_login: null,
    activity_type: 'created',
    field: '',
    old_value: null,
    new_value: null,
    comment_text: null,
    ...partial,
  };
}

describe('classifyItem', () => {
  it('maps created/resolved/comment directly', () => {
    expect(classifyItem(makeItem({ activity_type: 'created' }))).toBe('created');
    expect(classifyItem(makeItem({ activity_type: 'resolved' }))).toBe('resolved');
    expect(classifyItem(makeItem({ activity_type: 'comment' }))).toBe('comment');
  });

  it('classifies field_change by field name', () => {
    expect(classifyItem(makeItem({ activity_type: 'field_change', field: 'State' }))).toBe('state');
    expect(classifyItem(makeItem({ activity_type: 'field_change', field: 'state' }))).toBe('state');
    expect(classifyItem(makeItem({ activity_type: 'field_change', field: 'Assignee' }))).toBe('assignee');
    expect(classifyItem(makeItem({ activity_type: 'field_change', field: 'Priority' }))).toBe('other');
    expect(classifyItem(makeItem({ activity_type: 'field_change', field: '' }))).toBe('other');
  });

  it('falls back to other for unknown types', () => {
    expect(
      classifyItem(makeItem({ activity_type: 'weird-type' as ActivityItem['activity_type'] })),
    ).toBe('other');
  });
});

describe('presetToDate', () => {
  it('yesterday is one day ago', () => {
    const now = dayjs();
    expect(presetToDate('yesterday')).toBe(now.subtract(1, 'day').format('YYYY-MM-DD'));
  });

  it('last-week is 7 days ago', () => {
    const now = dayjs();
    expect(presetToDate('last-week')).toBe(now.subtract(7, 'day').format('YYYY-MM-DD'));
  });

  it('last-month is one calendar month ago', () => {
    const now = dayjs();
    expect(presetToDate('last-month')).toBe(now.subtract(1, 'month').format('YYYY-MM-DD'));
  });

  it('last-3-months is three calendar months ago', () => {
    const now = dayjs();
    expect(presetToDate('last-3-months')).toBe(now.subtract(3, 'month').format('YYYY-MM-DD'));
  });
});
