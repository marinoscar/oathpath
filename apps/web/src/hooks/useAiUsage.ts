/**
 * The caller's own recorded AI usage.
 *
 * Issue #42, epic #25. Separate from `useAiKey` because they answer different
 * questions and fail independently: a user whose key is saved perfectly can
 * still have no usage yet, and a usage request that fails must not make the
 * key form unusable.
 *
 * THIS IS RECORDED USAGE, NOT A BILL. Token counts are not dollars, this app
 * carries no price table, and `callsWithUnknownUsage` counts calls whose
 * consumption was never reported. The page says so and links to the user's own
 * OpenAI dashboard; nothing here computes or exposes a currency figure, and the
 * response type carries a compile-time proof of that on the API side.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError, getAiUsage } from '../services/api';
import type { AiUsage } from '../types';
import { useIsMounted } from './useIsMounted';

/** The window the page opens with. Matches the API's own default. */
export const DEFAULT_USAGE_DAYS = 30;

interface UseAiUsageReturn {
  usage: AiUsage | null;
  isLoading: boolean;
  error: string | null;
  days: number;
  setDays: (days: number) => void;
  refresh: () => Promise<void>;
}

export function useAiUsage(): UseAiUsageReturn {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(DEFAULT_USAGE_DAYS);

  const isMounted = useIsMounted();

  const fetchUsage = useCallback(
    async (window: number) => {
      try {
        setIsLoading(true);
        setError(null);
        const data = await getAiUsage(window);
        if (isMounted()) setUsage(data);
      } catch (err) {
        if (isMounted()) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Could not load your usage right now',
          );
        }
      } finally {
        if (isMounted()) setIsLoading(false);
      }
    },
    [isMounted],
  );

  useEffect(() => {
    fetchUsage(days);
  }, [fetchUsage, days]);

  const refresh = useCallback(() => fetchUsage(days), [fetchUsage, days]);

  return { usage, isLoading, error, days, setDays, refresh };
}
