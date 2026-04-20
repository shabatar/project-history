import { describe, it, expect } from 'vitest';
import { activityCacheKey, StorageKeys, ActivityCacheMaxBytes } from '../lib/storageKeys';

describe('storageKeys', () => {
  it('exposes stable key namespaces', () => {
    expect(StorageKeys.scope).toBe('yt:selected-scope');
    expect(StorageKeys.selectedProjectShortName).toBe('yt:selected-project-short-name');
    expect(StorageKeys.selectedBoardId).toBe('yt:selected-board-id');
    expect(StorageKeys.activityCachePrefix).toBe('yt:activity-cache:');
  });

  it('builds deterministic activity cache keys', () => {
    expect(activityCacheKey('project', 'PROJ', '2026-01-01', '2026-01-31'))
      .toBe('yt:activity-cache:project:PROJ:2026-01-01:2026-01-31');
    expect(activityCacheKey('board', 'abc123', '2026-04-01', '2026-04-30'))
      .toBe('yt:activity-cache:board:abc123:2026-04-01:2026-04-30');
  });

  it('sets a reasonable size cap', () => {
    // Guard against accidental downgrades that would silently break caching
    expect(ActivityCacheMaxBytes).toBeGreaterThanOrEqual(100_000);
    expect(ActivityCacheMaxBytes).toBeLessThanOrEqual(2_000_000);
  });
});
