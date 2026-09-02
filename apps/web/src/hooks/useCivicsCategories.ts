/**
 * A test version's categories — the top level of `/learn`.
 *
 * Issue #121, epic #51. Shaped after `useAiSettings` / `useEmailSettings`: the
 * same `isMounted` discipline, and the same contract that an error is a STRING
 * the page renders rather than an exception the page has to catch.
 *
 * THE VERSION CODE IS A PARAMETER, NOT SOMETHING THIS HOOK RESOLVES. It comes
 * from `LearnerProfileContext`, which loaded the learner's profile once for the
 * whole session; re-reading it here would put a request behind every navigation
 * into Learn. `null` is a real value — a learner whose profile has no resolved
 * version yet — and this hook does not fetch for it, because the route would be
 * `/civics/versions/null/categories` and a 404 is not the honest thing to show
 * somebody who simply has not finished setup.
 */

import { useCallback, useEffect, useState } from 'react';

import { getCivicsCategories } from '../services/api';
import type { CivicsCategory } from '../types';
import { useIsMounted } from './useIsMounted';

interface UseCivicsCategoriesReturn {
  categories: CivicsCategory[];
  isLoading: boolean;
  /** A message to render, or null. Never an exception to catch. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useCivicsCategories(
  testVersionCode: string | null,
): UseCivicsCategoriesReturn {
  const [categories, setCategories] = useState<CivicsCategory[]>([]);
  // Starts false when there is nothing to fetch, so a learner with no resolved
  // version sees the explanation immediately rather than a spinner that never
  // resolves into anything.
  const [isLoading, setIsLoading] = useState(testVersionCode !== null);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    if (!testVersionCode) {
      if (isMounted()) {
        setCategories([]);
        setIsLoading(false);
        setError(null);
      }
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const data = await getCivicsCategories(testVersionCode);
      if (isMounted()) setCategories(data);
    } catch (err) {
      if (isMounted()) {
        setCategories([]);
        setError(
          err instanceof Error
            ? err.message
            : 'The question categories could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted, testVersionCode]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { categories, isLoading, error, refresh };
}
