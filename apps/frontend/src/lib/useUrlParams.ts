import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { useAppStore } from '../store';

/**
 * Two-way sync between URL search params and the app store.
 * Params: repo, from, to
 *
 * - On mount: reads URL → store (URL wins if present)
 * - On store change: writes store → URL
 */
export function useUrlParams() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    selectedRepoId,
    dateRange,
    setSelectedRepoId,
    setDateRange,
  } = useAppStore();

  // URL → store (on mount / URL change via back/forward)
  useEffect(() => {
    const urlRepo = searchParams.get('repo');
    const urlFrom = searchParams.get('from');
    const urlTo = searchParams.get('to');

    if (urlRepo && urlRepo !== selectedRepoId) {
      setSelectedRepoId(urlRepo);
    }
    if (urlFrom && urlFrom !== dateRange.from) {
      setDateRange({
        from: urlFrom,
        to: urlTo || dayjs().format('YYYY-MM-DD'),
      });
    } else if (urlTo && urlTo !== dateRange.to) {
      setDateRange({ ...dateRange, to: urlTo });
    }
    // Only run on mount / URL change, not store change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Store → URL
  useEffect(() => {
    const next: Record<string, string> = {};
    if (selectedRepoId) next.repo = selectedRepoId;
    if (dateRange.from) next.from = dateRange.from;
    if (dateRange.to) next.to = dateRange.to;
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepoId, dateRange.from, dateRange.to]);

  return { selectedRepoId, dateRange, setSelectedRepoId, setDateRange };
}
