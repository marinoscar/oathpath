/**
 * The caller's own daily goal, streak and freeze budget — the goal ring's,
 * the streak's and the session-end celebration's one data source.
 *
 * Issue #138, epic #56 / E7 "Habit". Shaped after `useReadiness` /
 * `useProgressMastery`: the same `isMounted` discipline, and the same
 * contract that an error is a STRING the caller renders rather than an
 * exception it has to catch.
 *
 * NO GATING PARAMETER, for the identical reason `useReadiness`'s own header
 * gives: `useProgressMastery` takes a `testVersionCode` and skips the fetch
 * when it is `null`, because an unresolved version would 400.
 * `GET /api/engagement/summary` has no such precondition — `today` is always
 * present, with honest zeros for a learner who has done nothing yet
 * (`docs/specs/habit-streaks.md` §4.6), so there is no state in which asking
 * is the wrong thing to do.
 *
 * Used from BOTH `HomePage` (the ring and the streak) and
 * `PracticeSummaryPage` (the celebration, §8) — one hook, not two, so the two
 * surfaces can never read a differently-shaped summary or disagree about how
 * many minutes today held.
 *
 * ON FAILURE THE SUMMARY IS CLEARED, NOT KEPT. A stale ring under an error
 * banner would present a measurement the server has just refused to confirm
 * as though it were current — the same reason `useReadiness` and
 * `useProgressMastery` both clear their own data.
 */

import { useCallback, useEffect, useState } from 'react';

import { getEngagementSummary } from '../services/api';
import type { EngagementSummary } from '../types';
import { useIsMounted } from './useIsMounted';

export interface UseEngagementSummaryReturn {
  engagement: EngagementSummary | null;
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useEngagementSummary(): UseEngagementSummaryReturn {
  const [engagement, setEngagement] = useState<EngagementSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getEngagementSummary();
      if (isMounted()) setEngagement(data);
    } catch (err) {
      if (isMounted()) {
        setEngagement(null);
        setError(
          err instanceof Error
            ? err.message
            : 'Your daily goal could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { engagement, isLoading, error, refresh };
}

export default useEngagementSummary;
