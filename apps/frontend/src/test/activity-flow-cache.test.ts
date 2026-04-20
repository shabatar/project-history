import { describe, it, expect, beforeEach } from 'vitest';
import { cacheKey, loadActivityCache, saveActivityCache } from '../pages/activity-flow/cache';
import type { ActivityItem } from '../lib/api';

function makeItem(id: string): ActivityItem {
  return {
    timestamp: Date.now(),
    issue_id: id,
    issue_summary: 'summary',
    author: 'Alice',
    author_login: 'alice',
    activity_type: 'created',
    field: '',
    old_value: null,
    new_value: null,
    comment_text: null,
  };
}

describe('activity-flow cache', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('roundtrips a payload through sessionStorage', () => {
    const key = cacheKey('project', 'PROJ', '2026-01-01', '2026-01-31');
    const items = [makeItem('PROJ-1'), makeItem('PROJ-2')];
    saveActivityCache(key, { activities: items, cachedAt: 1_700_000_000_000 });

    const out = loadActivityCache(key);
    expect(out).not.toBeNull();
    expect(out!.cachedAt).toBe(1_700_000_000_000);
    expect(out!.activities.map((a) => a.issue_id)).toEqual(['PROJ-1', 'PROJ-2']);
  });

  it('returns null for a missing key', () => {
    expect(loadActivityCache('yt:activity-cache:project:NOPE:2026-01-01:2026-01-31')).toBeNull();
  });

  it('returns null when the stored value is not valid JSON', () => {
    const key = cacheKey('board', 'b1', '2026-01-01', '2026-01-31');
    sessionStorage.setItem(key, '}not-json{');
    expect(loadActivityCache(key)).toBeNull();
  });

  it('skips writes larger than the size cap', () => {
    const key = cacheKey('project', 'BIG', '2026-01-01', '2026-01-31');
    // Fabricate a giant payload: 10k items × ~200 bytes each ≈ 2MB
    const items: ActivityItem[] = [];
    for (let i = 0; i < 10_000; i++) {
      items.push(makeItem(`BIG-${i}`));
    }
    saveActivityCache(key, { activities: items, cachedAt: Date.now() });
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('cache keys are unique per scope / selection / range', () => {
    expect(cacheKey('project', 'X', 'a', 'b'))
      .not.toBe(cacheKey('board', 'X', 'a', 'b'));
    expect(cacheKey('project', 'X', 'a', 'b'))
      .not.toBe(cacheKey('project', 'Y', 'a', 'b'));
    expect(cacheKey('project', 'X', 'a', 'b'))
      .not.toBe(cacheKey('project', 'X', 'c', 'b'));
  });
});
