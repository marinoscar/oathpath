/**
 * `usePracticeQueue` — the learner's practice queue counts (issue #90, epic
 * #54 / E5 "Memory").
 *
 * Shaped after `useCivicsCategories`, which this hook is deliberately
 * modelled on (see the hook's own header) — same `isMounted` discipline, same
 * "error is a string the page renders, never an exception it has to catch"
 * contract, and the same reason `testVersionCode` is a PARAMETER rather than
 * something the hook resolves itself: it comes from `LearnerProfileContext`,
 * already loaded once for the session. The gating tests below are what would
 * catch a regression that fired `GET /api/practice/queue` for a learner whose
 * profile has no resolved test version yet — the 400 `docs/specs/`
 * calls "unfinished setup", not a failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { usePracticeQueue } from '../../hooks/usePracticeQueue';
import * as api from '../../services/api';
import type { PracticeQueue } from '../../types';

vi.mock('../../services/api', () => ({
  getPracticeQueue: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const { ApiError } = api;

const MOCK_QUEUE: PracticeQueue = {
  testVersionCode: 'v2008',
  total: 100,
  due: 3,
  weak: 2,
  new: {
    total: 10,
    byCategory: [{ categoryId: 'cat-1', categoryName: 'American Government', newCount: 10 }],
  },
  learning: 40,
  mastered: 45,
};

describe('usePracticeQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------
  // Gating on testVersionCode — the hook's own reason for being a parameter
  // ---------------------------------------------------------------------

  describe('gating on testVersionCode', () => {
    it('does not fetch, and is not loading, when there is no resolved test version', () => {
      const { result } = renderHook(() => usePracticeQueue(null));

      expect(api.getPracticeQueue).not.toHaveBeenCalled();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.queue).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('starts loading immediately when a test version is already known', () => {
      vi.mocked(api.getPracticeQueue).mockImplementation(
        () => new Promise(() => {}), // never resolves — asserting the initial state only
      );

      const { result } = renderHook(() => usePracticeQueue('v2008'));

      expect(result.current.isLoading).toBe(true);
      expect(api.getPracticeQueue).toHaveBeenCalledTimes(1);
    });

    it('fetches once testVersionCode becomes available after mounting as null', async () => {
      vi.mocked(api.getPracticeQueue).mockResolvedValue(MOCK_QUEUE);

      const { result, rerender } = renderHook(
        ({ code }: { code: string | null }) => usePracticeQueue(code),
        { initialProps: { code: null } },
      );

      expect(api.getPracticeQueue).not.toHaveBeenCalled();
      expect(result.current.queue).toBeNull();

      rerender({ code: 'v2008' });

      await waitFor(() => expect(result.current.queue).toEqual(MOCK_QUEUE));
      expect(api.getPracticeQueue).toHaveBeenCalledTimes(1);
    });

    it('clears any queue and stops loading when testVersionCode reverts to null', async () => {
      vi.mocked(api.getPracticeQueue).mockResolvedValue(MOCK_QUEUE);

      const { result, rerender } = renderHook(
        ({ code }: { code: string | null }) => usePracticeQueue(code),
        { initialProps: { code: 'v2008' as string | null } },
      );

      await waitFor(() => expect(result.current.queue).toEqual(MOCK_QUEUE));

      rerender({ code: null });

      await waitFor(() => expect(result.current.queue).toBeNull());
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // loading -> success
  // ---------------------------------------------------------------------

  describe('loading to success', () => {
    it('fetches on mount and resolves into the real queue shape', async () => {
      vi.mocked(api.getPracticeQueue).mockResolvedValue(MOCK_QUEUE);

      const { result } = renderHook(() => usePracticeQueue('v2008'));

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.queue).toEqual(MOCK_QUEUE);
      expect(result.current.error).toBeNull();
    });

    it('supports a manual refresh that re-fetches', async () => {
      vi.mocked(api.getPracticeQueue).mockResolvedValue(MOCK_QUEUE);

      const { result } = renderHook(() => usePracticeQueue('v2008'));
      await waitFor(() => expect(result.current.queue).toEqual(MOCK_QUEUE));

      const refreshedQueue: PracticeQueue = { ...MOCK_QUEUE, due: 0, weak: 0 };
      vi.mocked(api.getPracticeQueue).mockResolvedValue(refreshedQueue);

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.queue).toEqual(refreshedQueue);
      expect(api.getPracticeQueue).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------
  // loading -> error
  // ---------------------------------------------------------------------

  describe('loading to error', () => {
    it('renders an ApiError message as a string, not a thrown exception', async () => {
      vi.mocked(api.getPracticeQueue).mockRejectedValue(
        new ApiError('Your practice queue could not be loaded.', 500),
      );

      const { result } = renderHook(() => usePracticeQueue('v2008'));

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.error).toBe('Your practice queue could not be loaded.');
      // Cleared, not kept stale under an error banner — see the hook's header.
      expect(result.current.queue).toBeNull();
    });

    it('falls back to a generic message for a non-ApiError failure', async () => {
      vi.mocked(api.getPracticeQueue).mockRejectedValue(new Error('network down'));

      const { result } = renderHook(() => usePracticeQueue('v2008'));

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.error).toBe('Your practice queue could not be loaded.');
      expect(result.current.queue).toBeNull();
    });

    it('clears a previous error and stale queue is not left behind on a successful refresh', async () => {
      vi.mocked(api.getPracticeQueue).mockRejectedValueOnce(
        new ApiError('Your practice queue could not be loaded.', 500),
      );

      const { result } = renderHook(() => usePracticeQueue('v2008'));
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current.queue).toBeNull();

      vi.mocked(api.getPracticeQueue).mockResolvedValue(MOCK_QUEUE);

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.queue).toEqual(MOCK_QUEUE);
    });
  });
});
