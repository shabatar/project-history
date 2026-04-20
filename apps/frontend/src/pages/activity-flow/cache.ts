/** sessionStorage cache for fetched activity — survives in-tab navigation. */

import type { ActivityItem } from '../../lib/api';
import { activityCacheKey, ActivityCacheMaxBytes } from '../../lib/storageKeys';
import type { Scope } from './types';

export interface CachedActivities {
  activities: ActivityItem[];
  cachedAt: number; // epoch ms
}

export function cacheKey(scope: Scope, id: string, since: string, until: string): string {
  return activityCacheKey(scope, id, since, until);
}

export function saveActivityCache(key: string, payload: CachedActivities): void {
  try {
    const json = JSON.stringify(payload);
    if (json.length > ActivityCacheMaxBytes) return; // skip oversized payloads
    sessionStorage.setItem(key, json);
  } catch { /* storage unavailable — ignore */ }
}

export function loadActivityCache(key: string): CachedActivities | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedActivities;
  } catch { return null; }
}
