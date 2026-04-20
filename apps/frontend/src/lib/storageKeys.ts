/** Browser-storage keys. `yt:` namespace = YouTrack integration. */

export const StorageKeys = {
  scope: 'yt:selected-scope',
  selectedProjectShortName: 'yt:selected-project-short-name',
  selectedBoardId: 'yt:selected-board-id',
  activityCachePrefix: 'yt:activity-cache:',
} as const;

export const ActivityCacheMaxBytes = 500_000;

export function activityCacheKey(
  scope: 'board' | 'project',
  id: string,
  since: string,
  until: string,
): string {
  return `${StorageKeys.activityCachePrefix}${scope}:${id}:${since}:${until}`;
}
