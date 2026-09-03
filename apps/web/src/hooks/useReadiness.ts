/**
 * The caller's own latest readiness snapshot — the score, its eight-component
 * breakdown, the structural cap, and the day's one recommendation.
 *
 * Issue #139, epic #55 / E6 "Readiness and Progress". Shaped after
 * `useProgressMastery`/`useJourneyHome`: the same `isMounted` discipline, and
 * the same contract that an error is a STRING the page renders rather than an
 * exception it has to catch.
 *
 * NO GATING PARAMETER. `useProgressMastery` takes a `testVersionCode` and
 * skips the fetch when it is `null`, because an unresolved version would 400.
 * `GET /api/readiness` has no such precondition to check for here:
 * `RequireOrientation` (`CLAUDE.md`) already hard-blocks an unoriented
 * learner before either `/` or `/progress` — the two pages this hook is
 * used from — ever mount, so by the time this hook runs the caller always
 * has a resolved test version. This is the identical reasoning
 * `useJourneyHome` already gives for fetching unconditionally on mount.
 *
 * Used from BOTH `HomePage` (the compact widget, #142) and `ProgressPage`
 * (the full dial and breakdown, #139) — one hook, not two, so the two
 * surfaces can never read a differently-shaped snapshot.
 */

import { useCallback, useEffect, useState } from 'react';

import { getReadiness } from '../services/api';
import type { ReadinessSnapshotResponse } from '../types';
import { useIsMounted } from './useIsMounted';

export interface UseReadinessReturn {
  readiness: ReadinessSnapshotResponse | null;
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useReadiness(): UseReadinessReturn {
  const [readiness, setReadiness] = useState<ReadinessSnapshotResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getReadiness();
      if (isMounted()) setReadiness(data);
    } catch (err) {
      if (isMounted()) {
        // Cleared rather than kept — a stale score under an error banner
        // would present a measurement the server has just refused to
        // confirm as though it were current, the same reason
        // `useProgressMastery` clears `mastery` on failure.
        setReadiness(null);
        setError(
          err instanceof Error
            ? err.message
            : 'Your readiness could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { readiness, isLoading, error, refresh };
}
