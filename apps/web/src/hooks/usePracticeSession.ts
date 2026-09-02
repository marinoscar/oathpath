/**
 * One practice session, read from the server — `GET /api/practice/sessions/:id`.
 *
 * Issue #79, epic #52. The SINGLE source of truth for both screens that show a
 * session: `/practice/sessions/:id` (answering it) and
 * `/practice/sessions/:id/summary` (reading it back).
 *
 * =============================================================================
 * WHY BOTH SCREENS READ THE SERVER AND NEITHER READS NAVIGATION STATE
 * =============================================================================
 *
 * React Router will happily carry a whole `PracticeSessionState` through
 * `navigate(path, { state })`, and doing so would save one request on the two
 * paths a learner most often takes (start → answer, finish → summary). It is
 * still wrong, and the reason is not tidiness:
 *
 *   * **A reload loses it.** `history.state` survives a reload, but the object
 *     a learner comes back to after closing a tab, following a link from
 *     Recent sessions, or opening the summary a month later is nothing at all.
 *     A summary screen that renders from navigation state is therefore a
 *     summary screen that is BLANK exactly when it is revisited — the one case
 *     issue #79 calls out by name ("it must render identically when revisited
 *     later from Recent sessions").
 *   * **It would be a second copy of a number the server computes.** `progress`
 *     and `summary` are both counted from the persisted attempt rows on every
 *     response, so two tabs and a resumed session agree. A copy passed through
 *     the router is a snapshot of one tab's idea of the count, and it goes
 *     stale silently.
 *   * **Mid-session reload must lose no recorded attempt.** That works because
 *     resuming IS this request: the server hands back the same session, every
 *     attempt already written, and the next unanswered question.
 *
 * So the cost is one request, and what it buys is that the two screens cannot
 * disagree with the evidence table or with each other.
 *
 * =============================================================================
 * THIS HOOK FETCHES A SESSION. IT NEVER FETCHES A QUESTION.
 * =============================================================================
 *
 * `nextQuestion` arrives here prompt-only, with no answers, and NOTHING in the
 * practice UI may follow it with a `getCivicsQuestion(id)` to "enrich" it. That
 * call would put the accepted answers into the browser — and therefore into the
 * rendered page's data — before the learner has produced anything, which is
 * precisely the failure `PracticeSessionPage`'s header describes at length.
 */

import { useCallback, useEffect, useState } from 'react';

import { getPracticeSession } from '../services/api';
import type { PracticeSessionDetail } from '../types';
import { useIsMounted } from './useIsMounted';

interface UsePracticeSessionReturn {
  /** The session, its attempts, and the next prompt — or null before the first read. */
  detail: PracticeSessionDetail | null;
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePracticeSession(
  id: string | null | undefined,
): UsePracticeSessionReturn {
  const [detail, setDetail] = useState<PracticeSessionDetail | null>(null);
  // Starts false when there is no id to fetch, so a malformed URL shows its
  // message immediately rather than a spinner that never resolves.
  const [isLoading, setIsLoading] = useState(Boolean(id));
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!id) {
      if (isMounted()) {
        setDetail(null);
        setIsLoading(false);
        setError('That practice session could not be found.');
      }
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const data = await getPracticeSession(id);
      if (isMounted()) setDetail(data);
    } catch (err) {
      if (isMounted()) {
        setDetail(null);
        setError(
          err instanceof Error
            ? err.message
            : 'That practice session could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [id, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { detail, isLoading, error, refresh };
}
