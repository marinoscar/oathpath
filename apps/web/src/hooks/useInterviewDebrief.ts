/**
 * One finished interview, read back — `GET /api/interviews/:id`.
 *
 * Issue #145, epic #57 / E8. The debrief screen's only source of data, shaped
 * after `usePracticeSession` (#79), which is the same read for the same kind of
 * screen one level up.
 *
 * =============================================================================
 * WHY THIS IS NOT `useMockInterview`
 * =============================================================================
 *
 * `useMockInterview` reads the same endpoint, and reusing it here would work on
 * the first render and be wrong afterwards. That hook owns a LIVE interview: an
 * `AbortController` for the officer's stream, `submitTurn`, `complete()`, and a
 * turn status machine. A debrief is a finished thing being read back — there is
 * no turn to take, no stream to abort and nothing to complete, and handing the
 * debrief screen a `complete()` it must remember never to call is how a screen
 * ends up re-triggering a readiness recompute on a page that only meant to read.
 *
 * (It would not, in fact, write a second snapshot —
 * `POST /api/interviews/:id/complete` is idempotent — but a screen whose
 * correctness rests on somebody else's idempotency is a screen one refactor
 * away from being wrong.)
 *
 * =============================================================================
 * READ FROM THE SERVER, ALWAYS. NEVER FROM NAVIGATION STATE.
 * =============================================================================
 *
 * The interview screen already HAS the debrief in hand when it navigates here —
 * `completeInterview` returned it — and carrying it through
 * `navigate(path, { state })` would save exactly one request on exactly one
 * path. It is still wrong, for the reason `usePracticeSession` states at length
 * for the practice summary: the visit that matters most is the SECOND one, from
 * the history list, from a bookmark, or after a reload, and on that visit there
 * is no navigation state at all. A debrief screen that renders from navigation
 * state is a debrief screen that is blank exactly when a learner comes back to
 * compare two attempts — which is the whole reason §12 added the list endpoint.
 *
 * The stored debrief is also the honest one. It is read out of
 * `mock_interviews.result`, written once at completion, with each question's
 * `acceptedAnswers` frozen from the attempt's own answer snapshot — so a
 * dynamic answer changing later (`civics-content.md` §4: the Speaker of the
 * House) never re-grades a learner's history.
 */

import { useCallback, useEffect, useState } from 'react';

import { getInterview } from '../services/api';
import type { InterviewDetail } from '../types';
import { useIsMounted } from './useIsMounted';

export interface UseInterviewDebriefReturn {
  /**
   * The interview, its transcript and its debrief — or null before the first
   * read settles.
   *
   * `detail.debrief` is null while the interview is not `completed`, and that
   * is not an error state: the caller sends the learner back into the
   * interview. See `InterviewDebriefPage`.
   */
  detail: InterviewDetail | null;
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useInterviewDebrief(
  interviewId: string | undefined,
): UseInterviewDebriefReturn {
  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!interviewId) {
      // No id in the path at all. Not a request that failed — a request that
      // was never sensible to make — so it is said as prose rather than left
      // as a spinner that never resolves.
      setIsLoading(false);
      setError('That interview could not be found.');
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const data = await getInterview(interviewId);
      if (isMounted()) setDetail(data);
    } catch (err) {
      if (isMounted()) {
        // Cleared rather than kept, the same reason `usePracticeSessions` and
        // `useReadiness` clear theirs: a debrief left on screen under an error
        // banner is a result the server has just refused to confirm, presented
        // as though it were current.
        setDetail(null);
        setError(
          err instanceof Error
            ? err.message
            : 'That interview could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [interviewId, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { detail, isLoading, error, refresh };
}
