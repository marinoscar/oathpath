/**
 * The learner's recent practice sessions — the third band of `/practice`.
 *
 * Issue #76, epic #52. Shaped after `useCivicsCategories` / `useEmailSettings`:
 * the same `isMounted` discipline, and the same contract that an error is a
 * STRING the page renders rather than an exception the page has to catch.
 *
 * =============================================================================
 * AN EMPTY LIST IS A REAL, HONEST ANSWER — NOT AN ERROR AND NOT A ZERO
 * =============================================================================
 *
 * A learner who has never practised gets `items: []`, and `/practice` renders
 * an empty state that says exactly that. It must never render a chart, a
 * percentage or a "0 correct out of 0" tile in its place: `VISION.md`'s honesty
 * rule and `journey-shell.md` §10 are both about the same failure mode — a
 * fabricated zero is indistinguishable, at a glance, from a real measurement,
 * and the learner cannot tell which one they are looking at.
 *
 * That is why this hook keeps `items`, `isLoading` and `error` as three
 * separate facts rather than collapsing them: "we haven't asked yet", "we
 * asked and there is nothing", and "we asked and it failed" are three different
 * things to say, and only the middle one is an empty state.
 *
 * `refresh` exists for two callers: the error banner's retry, and the page
 * itself after it starts a session — starting one closes any session that was
 * still `in_progress`, so the list on screen is stale the instant a session
 * begins.
 */

import { useCallback, useEffect, useState } from 'react';

import { getPracticeSessions } from '../services/api';
import type { PracticeSessionListItem } from '../types';
import { useIsMounted } from './useIsMounted';

/**
 * How many rows "recent" means.
 *
 * Small on purpose. This is a band on a destination page, not a history
 * screen: the question it answers is "what was I just doing", and a learner
 * who wants the twentieth session back is asking a different question that no
 * pagination control on this band would answer well either.
 */
export const RECENT_SESSION_COUNT = 5;

interface UsePracticeSessionsReturn {
  sessions: PracticeSessionListItem[];
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePracticeSessions(
  pageSize: number = RECENT_SESSION_COUNT,
): UsePracticeSessionsReturn {
  const [sessions, setSessions] = useState<PracticeSessionListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getPracticeSessions({ page: 1, pageSize });
      if (isMounted()) setSessions(data.items);
    } catch (err) {
      if (isMounted()) {
        // Cleared rather than kept. Leaving the previous rows on screen under
        // an error banner would show a history the server has just refused to
        // confirm — stale data presented as fact, which is the same honesty
        // failure an invented zero would be.
        setSessions([]);
        setError(
          err instanceof Error
            ? err.message
            : 'Your recent practice could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, pageSize]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sessions, isLoading, error, refresh };
}
