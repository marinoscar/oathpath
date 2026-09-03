/**
 * The learner's practice queue counts — issue #90, epic #54 / E5 "Memory".
 *
 * Shaped after `useCivicsCategories`: the same `isMounted` discipline, the
 * same contract that an error is a STRING the page renders rather than an
 * exception the page has to catch, and the same reason for taking
 * `testVersionCode` as a PARAMETER rather than resolving it here — it comes
 * from `LearnerProfileContext`, already loaded once for the session.
 *
 * `null` is a real value — a learner whose profile has no resolved version
 * yet — and this hook does not fetch for it: `GET /api/practice/queue` 400s
 * for exactly that caller ("unfinished setup"), and `/practice` already
 * renders that case ahead of mounting anything that reads this hook, so
 * firing the request only to render nothing with its answer would be a
 * request with no purpose.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, getPracticeQueue } from '../services/api';
import type { PracticeQueue } from '../types';
import { useIsMounted } from './useIsMounted';

interface UsePracticeQueueReturn {
  /** `null` before the first successful read, after a failed one, or when
   *  there is no resolved test version to ask about. */
  queue: PracticeQueue | null;
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePracticeQueue(
  testVersionCode: string | null,
): UsePracticeQueueReturn {
  const [queue, setQueue] = useState<PracticeQueue | null>(null);
  // Starts false when there is nothing to fetch, so a learner with no
  // resolved version never sees a spinner that has nothing to resolve into.
  const [isLoading, setIsLoading] = useState(testVersionCode !== null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!testVersionCode) {
      if (isMounted()) {
        setQueue(null);
        setIsLoading(false);
        setError(null);
      }
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const data = await getPracticeQueue();
      if (isMounted()) setQueue(data);
    } catch (err) {
      if (isMounted()) {
        // Cleared rather than kept — stale counts under an error banner would
        // be the same honesty failure `usePracticeSessions` avoids: data
        // presented as current when the server has just refused to confirm it.
        setQueue(null);
        setError(
          err instanceof ApiError
            ? err.message
            : 'Your practice queue could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, testVersionCode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { queue, isLoading, error, refresh };
}
