/**
 * The learner's own coverage and mastery, by category — `/progress`'s data source.
 *
 * Issue #94, epic #54 / E5 "Memory". Shaped after `useCivicsCategories` /
 * `usePracticeSessions`: the same `isMounted` discipline, and the same
 * contract that an error is a STRING the page renders rather than an
 * exception the page has to catch.
 *
 * THE TEST VERSION CODE IS A PARAMETER, NOT SOMETHING THIS HOOK RESOLVES —
 * same reasoning as `useCivicsCategories`'s own header. It comes from
 * `LearnerProfileContext`, loaded once for the whole session; `null` is a
 * real value (a learner whose profile has no resolved version yet), and this
 * hook does not fetch for it, because `GET /api/progress/mastery` would 400
 * and that 400 is not the honest thing to show somebody who simply has not
 * finished setup — `/progress` renders its own "finish your plan" notice
 * instead, the same one `/practice` already renders.
 */

import { useCallback, useEffect, useState } from 'react';

import { getProgressMastery } from '../services/api';
import type { ProgressMastery } from '../types';
import { useIsMounted } from './useIsMounted';

interface UseProgressMasteryReturn {
  mastery: ProgressMastery | null;
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useProgressMastery(
  testVersionCode: string | null,
): UseProgressMasteryReturn {
  const [mastery, setMastery] = useState<ProgressMastery | null>(null);
  // Starts false when there is nothing to fetch, so a learner with no
  // resolved version sees the explanation immediately rather than a spinner
  // that never resolves into anything.
  const [isLoading, setIsLoading] = useState(testVersionCode !== null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!testVersionCode) {
      if (isMounted()) {
        setMastery(null);
        setIsLoading(false);
        setError(null);
      }
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const data = await getProgressMastery();
      if (isMounted()) setMastery(data);
    } catch (err) {
      if (isMounted()) {
        // Cleared rather than kept — stale progress under an error banner
        // would present a measurement the server has just refused to
        // confirm as though it were current.
        setMastery(null);
        setError(
          err instanceof Error
            ? err.message
            : 'Your progress could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, testVersionCode]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { mastery, isLoading, error, refresh };
}
