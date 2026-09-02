/**
 * Everything the home screen renders, in one loading state.
 *
 * Issue #74, epic #50. Two GETs — `/journey/home` and `/journey/stages` — in
 * the shape of `useNotificationEvents` / `useEmailSettings`: same `isMounted`
 * discipline, same "error is a string the page renders" contract.
 *
 * =============================================================================
 * ONE `Promise.all`, ONE `isLoading`, AND THAT IS THE HONESTY REQUIREMENT
 * =============================================================================
 *
 * The two responses are fetched together and settle together on purpose. Two
 * independent loading flags would let the page paint a stage path before the
 * home payload arrives — eight dots with none marked, or worse, the previous
 * learner's stage — and paint a Next-up card before the stage registry can name
 * the stage it belongs to. `docs/specs/journey-shell.md` §10's rule is about
 * fabricated DATA, but a half-rendered journey is the same failure in a
 * different costume: the learner cannot tell "still loading" from "this is
 * where you are".
 *
 * So: nothing renders until both answers are in, and a failure of EITHER is a
 * failure of the page. There is no partial success worth showing.
 *
 * =============================================================================
 * THIS IS NOT `LearnerProfileContext`, AND MUST NOT BE FOLDED INTO IT
 * =============================================================================
 *
 * `contexts/LearnerProfileContext.tsx` holds the learner's stored ANSWERS,
 * fetched once per session because a gate consults it on every navigation.
 * This hook holds the server's READING of those answers — the recommendation,
 * the calendar-day countdown, the goal placeholder — which is recomputed
 * against the server's clock and is stale the moment it is cached. Mounting it
 * in that context would either freeze a countdown for the length of a session
 * or reintroduce the per-navigation request storm that context exists to
 * avoid.
 *
 * `refresh` is exported so the page's error state can offer a retry that is a
 * real retry rather than a route change.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, getJourneyHome, getJourneyStages } from '../services/api';
import type { JourneyHome, JourneyStage } from '../types';
import { useIsMounted } from './useIsMounted';

export interface UseJourneyHomeReturn {
  /** `GET /api/journey/home`, or `null` before the first successful read. */
  home: JourneyHome | null;

  /**
   * The stage registry IN SERVER ORDER, or `null` before the first successful
   * read.
   *
   * NEVER RE-SORTED AND NEVER DEFAULTED. The order is the journey, and the web
   * app has no opinion about it — `journey-shell.md` §6 puts the one
   * declaration in the API precisely so there is nothing here to disagree with
   * it. `null` rather than `[]` for the same reason `useNotificationEvents`
   * distinguishes them: an empty array would be a real (if alarming) answer,
   * and rendering it as "loading" would hide a broken deployment.
   */
  stages: JourneyStage[] | null;

  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useJourneyHome(): UseJourneyHomeReturn {
  const [home, setHome] = useState<JourneyHome | null>(null);
  const [stages, setStages] = useState<JourneyStage[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const fetchAll = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      // In parallel, not in sequence: they are independent reads, and chaining
      // them would double the wait on the first screen a learner sees.
      const [homeData, stageData] = await Promise.all([
        getJourneyHome(),
        getJourneyStages(),
      ]);
      if (isMounted()) {
        setHome(homeData);
        setStages(stageData);
      }
    } catch (err) {
      if (isMounted()) {
        setError(
          err instanceof ApiError ? err.message : 'Failed to load your journey',
        );
        // Cleared deliberately. Leaving the previous answers on screen behind
        // an error banner would show a countdown the server has just refused to
        // confirm, which is the shape of stale-data-as-fact §10 rules out.
        setHome(null);
        setStages(null);
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  return { home, stages, isLoading, error, refresh: fetchAll };
}
