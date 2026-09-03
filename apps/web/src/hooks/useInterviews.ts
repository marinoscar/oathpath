/**
 * The learner's own mock interviews, newest first — `GET /api/interviews`.
 *
 * Issue #145, epic #57 / E8. Shaped after `usePracticeSessions` (#76), which is
 * the same band on the same destination one level up: the same `isMounted`
 * discipline, the same `page`/`pageSize` call, and the same contract that an
 * error is a STRING the page renders rather than an exception it has to catch.
 *
 * =============================================================================
 * WHY A HISTORY LIST EXISTS AT ALL
 * =============================================================================
 *
 * `docs/specs/mock-interview.md` §12 states the reason the endpoint under this
 * hook was added to the epic's own three routes, and it is the reason this hook
 * exists too: **a completed debrief must be reachable again later.** "Did I do
 * better on my second mock interview than my first" is a real, expected
 * question this product should be able to answer, and it cannot be answered if
 * a debrief exists only as a one-time response to the `complete` call that
 * produced it. The interview screen navigates to a debrief once; this is how a
 * learner gets back to it a week later.
 *
 * =============================================================================
 * AN EMPTY HISTORY IS A REAL, HONEST ANSWER — NOT AN ERROR AND NOT A ZERO
 * =============================================================================
 *
 * A learner who has never sat a mock interview gets `items: []`, and the screen
 * renders a sentence saying exactly that. It must never render "0 interviews",
 * a flat chart, a ring at zero or a disabled-looking dashboard implying data
 * that has not arrived — `VISION.md`'s honesty rule, and the identical argument
 * `usePracticeSessions` makes for its own band: a fabricated zero is
 * indistinguishable at a glance from a real measurement, and a learner cannot
 * tell which one they are looking at.
 *
 * That is why `items`, `isLoading` and `error` stay three separate facts rather
 * than collapsing into one: "we haven't asked yet", "we asked and there is
 * nothing", and "we asked and it failed" are three different things to say, and
 * only the middle one is an empty state.
 *
 * `refresh` exists for the error banner's retry. It is deliberately NOT called
 * after starting an interview: starting navigates away from the screen that
 * renders this list, so there is nothing on screen left to go stale — unlike
 * `usePracticeSessions`, whose page stays mounted while a session start closes
 * a row that said "In progress" a moment ago.
 */

import { useCallback, useEffect, useState } from 'react';

import { getInterviews } from '../services/api';
import type { InterviewListItem } from '../types';
import { useIsMounted } from './useIsMounted';

/**
 * How many rows "your interviews" means on the start screen.
 *
 * Small on purpose, and smaller than `RECENT_SESSION_COUNT`'s five: an
 * interview is a twenty-minute event a learner sits a handful of times, not a
 * five-question drill they run several times a day, so the question this band
 * answers ("how did the last few go") is served by fewer rows.
 */
export const RECENT_INTERVIEW_COUNT = 5;

export interface UseInterviewsReturn {
  interviews: InterviewListItem[];
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useInterviews(
  pageSize: number = RECENT_INTERVIEW_COUNT,
): UseInterviewsReturn {
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getInterviews({ page: 1, pageSize });
      if (isMounted()) setInterviews(data.items);
    } catch (err) {
      if (isMounted()) {
        // Cleared rather than kept. Leaving the previous rows on screen under
        // an error banner would show a history the server has just refused to
        // confirm — stale data presented as fact, which is the same honesty
        // failure an invented zero would be.
        setInterviews([]);
        setError(
          err instanceof Error
            ? err.message
            : 'Your past interviews could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, pageSize]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { interviews, isLoading, error, refresh };
}
