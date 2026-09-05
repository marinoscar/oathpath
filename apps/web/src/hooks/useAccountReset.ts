/**
 * Load the caller's data-reset preview, and run the reset itself.
 *
 * Issue #270. SHAPED AFTER `useAiKey.ts`, the same template every settings
 * hook in this app follows: `useIsMounted()` guards every `setState` past an
 * `await`, an `ApiError` message is preferred over a generic fallback, and a
 * failed mutation never throws past this hook — it sets an error state and
 * resolves, exactly like `useAiKey`'s `remove()`.
 *
 * TWO INDEPENDENT REQUESTS, NOT ONE COMBINED LOADING FLAG. `summary` answers
 * "what would this touch" and is read-only (`GET /api/account/data-summary`
 * only ever `count`s); `reset` is the one irreversible write
 * (`POST /api/account/reset`). Keeping their loading/error state separate is
 * what lets the dialog show a live consequence list (from `summary`) at the
 * same time as a reset-specific error (from `reset`) without either
 * clobbering the other.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  getAccountDataSummary,
  resetAccountData,
} from '../services/api';
import type {
  AccountDataSummary,
  AccountResetResult,
  AccountResetScope,
} from '../types';
import { useIsMounted } from './useIsMounted';

interface UseAccountResetReturn {
  summary: AccountDataSummary | undefined;
  isLoading: boolean;
  loadError: string | null;

  isResetting: boolean;
  resetError: string | null;

  /**
   * Run the reset. Resolves the server's result on success.
   *
   * NEVER THROWS. On failure it sets `resetError` and resolves `undefined` —
   * the same convention `useAiKey`'s `remove()` uses — so a caller can always
   * `await` this without a `try`/`catch` of its own.
   */
  reset: (
    scope: AccountResetScope,
    confirmationPhrase: string,
  ) => Promise<AccountResetResult | undefined>;

  /** Re-fetch the summary. Exposed for a dialog that reopens after a while. */
  refresh: () => Promise<void>;

  /** Clear a stale reset error, e.g. when the dialog closes or reopens. */
  clearResetError: () => void;
}

export function useAccountReset(): UseAccountResetReturn {
  const [summary, setSummary] = useState<AccountDataSummary | undefined>(
    undefined,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [isResetting, setIsResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const fetchSummary = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getAccountDataSummary();
      if (isMounted()) setSummary(data);
    } catch (err) {
      if (isMounted()) {
        setLoadError(
          err instanceof ApiError
            ? err.message
            : 'Could not load what a reset would touch',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const reset = useCallback(
    async (
      scope: AccountResetScope,
      confirmationPhrase: string,
    ): Promise<AccountResetResult | undefined> => {
      try {
        setIsResetting(true);
        setResetError(null);
        return await resetAccountData(scope, confirmationPhrase);
      } catch (err) {
        if (isMounted()) {
          setResetError(
            err instanceof ApiError
              ? err.message
              : 'Could not reset your data. Nothing was deleted.',
          );
        }
        return undefined;
      } finally {
        if (isMounted()) setIsResetting(false);
      }
    },
    [isMounted],
  );

  const clearResetError = useCallback(() => setResetError(null), []);

  return {
    summary,
    isLoading,
    loadError,
    isResetting,
    resetError,
    reset,
    refresh: fetchSummary,
    clearResetError,
  };
}
