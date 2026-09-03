/**
 * The learner's practice queue counts — issue #90, epic #54 / E5 "Memory".
 *
 * Shaped after `useCivicsCategories` / `usePracticeSessions`: the same
 * `isMounted` discipline, and the same contract that an error is a STRING the
 * page renders rather than an exception the page has to catch.
 *
 * `GET /api/practice/queue` 400s for a caller with no resolved test version
 * (unfinished setup) — `/practice` already handles that case ahead of
 * mounting anything that reads this hook, so it is not re-diagnosed here; an
 * unexpected 400 still surfaces through the ordinary `error` string.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, getPracticeQueue } from '../services/api';
import type { PracticeQueue } from '../types';
import { useIsMounted } from './useIsMounted';

interface UsePracticeQueueReturn {
  /** `null` before the first successful read, or after a failed one. */
  queue: PracticeQueue | null;
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePracticeQueue(): UsePracticeQueueReturn {
  const [queue, setQueue] = useState<PracticeQueue | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
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
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { queue, isLoading, error, refresh };
}
