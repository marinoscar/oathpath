/**
 * The caller's own past readiness snapshots, newest first — the trend line's
 * data source on `/progress`, and the one prior snapshot the Home widget
 * compares its score against.
 *
 * Issue #139/#142, epic #55 / E6. Shaped after `useReadiness`/
 * `useProgressMastery`: the same `isMounted` discipline, and the same
 * contract that an error is a STRING the page renders rather than an
 * exception it has to catch.
 *
 * ONE FIXED PAGE, NO PARAMETER. This hook renders a trend, not a paginated
 * table — `HISTORY_PAGE_SIZE` is generous enough to describe a trend (about
 * six weeks of nightly-cron snapshots, or more if a learner completes
 * several sessions a day) without exposing pagination controls nobody asked
 * for. A caller that eventually needs to page through the FULL history is a
 * different feature with a different hook, not a parameter bolted onto this
 * one.
 */

import { useCallback, useEffect, useState } from 'react';

import { getReadinessHistory } from '../services/api';
import type { ReadinessSnapshotResponse } from '../types';
import { useIsMounted } from './useIsMounted';

/** Newest-first rows fetched for the trend — see the header above. */
const HISTORY_PAGE_SIZE = 30;

export interface UseReadinessHistoryReturn {
  /** Newest first, as the API sends it. Empty before the first successful read. */
  history: ReadinessSnapshotResponse[];
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useReadinessHistory(): UseReadinessHistoryReturn {
  const [history, setHistory] = useState<ReadinessSnapshotResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const page = await getReadinessHistory({ page: 1, pageSize: HISTORY_PAGE_SIZE });
      if (isMounted()) setHistory(page.items);
    } catch (err) {
      if (isMounted()) {
        // Cleared rather than kept, for the identical reason `useReadiness`
        // clears the snapshot on failure — a stale trend under an error
        // would present history the server just refused to confirm.
        setHistory([]);
        setError(
          err instanceof Error
            ? err.message
            : 'Your readiness history could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { history, isLoading, error, refresh };
}
