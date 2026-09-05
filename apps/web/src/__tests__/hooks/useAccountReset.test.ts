/**
 * `useAccountReset` — the "Danger zone" data-reset hook (issue #270).
 *
 * SHAPED AFTER `useAiKey.ts` (see the hook's own header): `isMounted`
 * discipline, an `ApiError` message preferred over a generic fallback, and a
 * failed mutation that never throws past the hook — it sets an error state and
 * resolves `undefined`, exactly like `useAiKey`'s `remove()`.
 *
 * TWO INDEPENDENT REQUESTS. `summary` (read-only, fetched on mount) and
 * `reset` (the one write) keep separate loading/error state, so these tests
 * are grouped the same way rather than treated as one combined flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { useAccountReset } from '../../hooks/useAccountReset';
import { ApiError } from '../../services/api';
import * as api from '../../services/api';
import type { AccountDataSummary, AccountResetResult } from '../../types';

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>(
    '../../services/api',
  );
  return {
    ...actual,
    getAccountDataSummary: vi.fn(),
    resetAccountData: vi.fn(),
  };
});

const SUMMARY: AccountDataSummary = {
  counts: {
    practice_attempts: 142,
    mock_interviews: 3,
    readiness_snapshots: 0,
  },
  phrases: {
    data: 'DELETE MY DATA',
    data_and_key: 'DELETE EVERYTHING',
  },
};

const RESULT: AccountResetResult = {
  scope: 'data',
  deleted: { practice_attempts: 142, mock_interviews: 3 },
  aiKeyRemoved: false,
};

describe('useAccountReset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Loading the summary
  // ===========================================================================

  describe('summary', () => {
    it('starts loading and fetches the summary on mount', async () => {
      vi.mocked(api.getAccountDataSummary).mockResolvedValue(SUMMARY);

      const { result } = renderHook(() => useAccountReset());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.summary).toBeUndefined();

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(api.getAccountDataSummary).toHaveBeenCalledTimes(1);
      expect(result.current.summary).toEqual(SUMMARY);
      expect(result.current.loadError).toBeNull();
    });

    it('sets loadError to the ApiError message on a failed fetch', async () => {
      vi.mocked(api.getAccountDataSummary).mockRejectedValue(
        new ApiError('Forbidden', 403, 'FORBIDDEN'),
      );

      const { result } = renderHook(() => useAccountReset());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.loadError).toBe('Forbidden');
      expect(result.current.summary).toBeUndefined();
    });

    it('falls back to a generic message when the failure is not an ApiError, and does not crash', async () => {
      vi.mocked(api.getAccountDataSummary).mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() => useAccountReset());

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.loadError).toBe(
        'Could not load what a reset would touch',
      );
    });

    it('refresh() re-fetches the summary', async () => {
      vi.mocked(api.getAccountDataSummary)
        .mockResolvedValueOnce(SUMMARY)
        .mockResolvedValueOnce({ ...SUMMARY, counts: { practice_attempts: 0 } });

      const { result } = renderHook(() => useAccountReset());
      await waitFor(() => expect(result.current.summary).toEqual(SUMMARY));

      await act(async () => {
        await result.current.refresh();
      });

      expect(api.getAccountDataSummary).toHaveBeenCalledTimes(2);
      expect(result.current.summary).toEqual({
        ...SUMMARY,
        counts: { practice_attempts: 0 },
      });
    });

    it('refresh() clears a previous loadError on success', async () => {
      vi.mocked(api.getAccountDataSummary)
        .mockRejectedValueOnce(new ApiError('down', 500))
        .mockResolvedValueOnce(SUMMARY);

      const { result } = renderHook(() => useAccountReset());
      await waitFor(() => expect(result.current.loadError).toBe('down'));

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.loadError).toBeNull();
      expect(result.current.summary).toEqual(SUMMARY);
    });
  });

  // ===========================================================================
  // reset()
  // ===========================================================================

  describe('reset', () => {
    it('calls resetAccountData with (scope, phrase), toggles isResetting, and resolves the result', async () => {
      vi.mocked(api.getAccountDataSummary).mockResolvedValue(SUMMARY);
      vi.mocked(api.resetAccountData).mockResolvedValue(RESULT);

      const { result } = renderHook(() => useAccountReset());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.isResetting).toBe(false);

      let response: AccountResetResult | undefined;
      await act(async () => {
        response = await result.current.reset('data', 'DELETE MY DATA');
      });

      expect(api.resetAccountData).toHaveBeenCalledWith('data', 'DELETE MY DATA');
      expect(response).toEqual(RESULT);
      expect(result.current.isResetting).toBe(false);
      expect(result.current.resetError).toBeNull();
    });

    it('is isResetting: true while the call is in flight', async () => {
      vi.mocked(api.getAccountDataSummary).mockResolvedValue(SUMMARY);
      let resolveReset: (value: AccountResetResult) => void;
      const pending = new Promise<AccountResetResult>((resolve) => {
        resolveReset = resolve;
      });
      vi.mocked(api.resetAccountData).mockReturnValue(pending);

      const { result } = renderHook(() => useAccountReset());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let settled: Promise<AccountResetResult | undefined>;
      act(() => {
        settled = result.current.reset('data', 'DELETE MY DATA');
      });

      await waitFor(() => expect(result.current.isResetting).toBe(true));

      await act(async () => {
        resolveReset(RESULT);
        await settled;
      });

      expect(result.current.isResetting).toBe(false);
    });

    it('NEVER THROWS: a rejected call sets resetError and resolves undefined', async () => {
      vi.mocked(api.getAccountDataSummary).mockResolvedValue(SUMMARY);
      vi.mocked(api.resetAccountData).mockRejectedValue(
        new ApiError('Wrong confirmation phrase', 400, 'INVALID_CONFIRMATION'),
      );

      const { result } = renderHook(() => useAccountReset());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let response: AccountResetResult | undefined = RESULT;
      await act(async () => {
        response = await result.current.reset('data', 'WRONG PHRASE');
      });

      expect(response).toBeUndefined();
      expect(result.current.resetError).toBe('Wrong confirmation phrase');
      expect(result.current.isResetting).toBe(false);
    });

    it('falls back to the generic "nothing was deleted" message when the failure is not an ApiError', async () => {
      vi.mocked(api.getAccountDataSummary).mockResolvedValue(SUMMARY);
      vi.mocked(api.resetAccountData).mockRejectedValue(new Error('network blip'));

      const { result } = renderHook(() => useAccountReset());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      let response: AccountResetResult | undefined = RESULT;
      await act(async () => {
        response = await result.current.reset('data_and_key', 'DELETE EVERYTHING');
      });

      expect(response).toBeUndefined();
      expect(result.current.resetError).toBe(
        'Could not reset your data. Nothing was deleted.',
      );
    });

    it('clearResetError() clears a set resetError', async () => {
      vi.mocked(api.getAccountDataSummary).mockResolvedValue(SUMMARY);
      vi.mocked(api.resetAccountData).mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() => useAccountReset());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.reset('data', 'DELETE MY DATA');
      });
      expect(result.current.resetError).not.toBeNull();

      act(() => {
        result.current.clearResetError();
      });

      expect(result.current.resetError).toBeNull();
    });

    it('a fresh reset() clears a previous resetError before the call resolves', async () => {
      vi.mocked(api.getAccountDataSummary).mockResolvedValue(SUMMARY);
      vi.mocked(api.resetAccountData)
        .mockRejectedValueOnce(new ApiError('first failure', 400))
        .mockResolvedValueOnce(RESULT);

      const { result } = renderHook(() => useAccountReset());
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.reset('data', 'WRONG');
      });
      expect(result.current.resetError).toBe('first failure');

      await act(async () => {
        await result.current.reset('data', 'DELETE MY DATA');
      });
      expect(result.current.resetError).toBeNull();
    });
  });
});
