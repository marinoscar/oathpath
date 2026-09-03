/**
 * `useProgressMastery` — the fetch hook behind `/progress`.
 *
 * Issue #94, epic #54 / E5 "Memory". Shaped after `useUserSettings.test.ts` /
 * `usePersonalAccessTokens.test.ts`: the API module is mocked at the named-
 * export boundary the hook itself imports (`getProgressMastery`), not the
 * generic `api.get`.
 *
 * Two hook-specific behaviours get their own describe block, because they are
 * the two ways this hook differs from an ordinary "fetch on mount" hook:
 *
 *  1. **`testVersionCode === null` never fetches.** The hook's own header
 *     explains why — a caller with no resolved test version would get a 400,
 *     and that 400 is not the honest thing to show someone who simply has not
 *     finished setup.
 *  2. **An error clears `mastery` rather than leaving a stale value under an
 *     error banner** — the hook's own comment on that line, tested directly
 *     here rather than trusted from the source.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { useProgressMastery } from '../../hooks/useProgressMastery';
import { getProgressMastery } from '../../services/api';
import type { ProgressMastery } from '../../types';

vi.mock('../../services/api', () => ({
  getProgressMastery: vi.fn(),
}));

const MASTERY: ProgressMastery = {
  testVersionCode: 'v2008',
  totalQuestions: 100,
  attempted: 40,
  byState: { new: 60, learning: 15, review: 10, lapsed: 5, mastered: 10 },
  categories: [
    {
      categoryId: 'category-democracy',
      categoryName: 'Principles of American Democracy',
      totalQuestions: 20,
      byState: { new: 10, learning: 4, review: 2, lapsed: 1, mastered: 3 },
      masteredCount: 3,
    },
  ],
};

describe('useProgressMastery — loading to success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts loading when a test version code is given, and fetches it', async () => {
    vi.mocked(getProgressMastery).mockResolvedValue(MASTERY);

    const { result } = renderHook(() => useProgressMastery('v2008'));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.mastery).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(getProgressMastery).toHaveBeenCalledTimes(1);
    expect(result.current.mastery).toEqual(MASTERY);
    expect(result.current.error).toBeNull();
  });

  it('starts NOT loading, and never fetches, when the test version code is null', async () => {
    vi.mocked(getProgressMastery).mockResolvedValue(MASTERY);

    const { result } = renderHook(() => useProgressMastery(null));

    // No spinner promised for a learner with unfinished setup — the page
    // renders its own "finish your plan" notice instead, immediately.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.mastery).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(getProgressMastery).not.toHaveBeenCalled();
    });
  });

  it('re-fetches once a real test version code arrives after starting null', async () => {
    vi.mocked(getProgressMastery).mockResolvedValue(MASTERY);

    const { result, rerender } = renderHook(
      ({ code }: { code: string | null }) => useProgressMastery(code),
      { initialProps: { code: null } },
    );

    expect(result.current.mastery).toBeNull();
    expect(getProgressMastery).not.toHaveBeenCalled();

    rerender({ code: 'v2008' });

    await waitFor(() => {
      expect(result.current.mastery).toEqual(MASTERY);
    });
    expect(getProgressMastery).toHaveBeenCalledTimes(1);
  });
});

describe('useProgressMastery — loading to error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces an Error message as a string, and clears mastery on failure', async () => {
    vi.mocked(getProgressMastery).mockRejectedValue(
      new Error('You have no resolved test version yet.'),
    );

    const { result } = renderHook(() => useProgressMastery('v2008'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('You have no resolved test version yet.');
    expect(result.current.mastery).toBeNull();
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    vi.mocked(getProgressMastery).mockRejectedValue('a plain string rejection');

    const { result } = renderHook(() => useProgressMastery('v2008'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Your progress could not be loaded.');
  });

  it('clears a previously loaded mastery value when a refresh then fails', async () => {
    vi.mocked(getProgressMastery).mockResolvedValueOnce(MASTERY);

    const { result } = renderHook(() => useProgressMastery('v2008'));

    await waitFor(() => {
      expect(result.current.mastery).toEqual(MASTERY);
    });

    vi.mocked(getProgressMastery).mockRejectedValueOnce(new Error('Server error.'));

    await act(async () => {
      await result.current.refresh();
    });

    // A stale measurement under an error banner would present a number the
    // server just refused to confirm as though it were still current — the
    // hook's own header names this explicitly.
    expect(result.current.mastery).toBeNull();
    expect(result.current.error).toBe('Server error.');
  });

  it('clears a previous error on a successful refresh', async () => {
    vi.mocked(getProgressMastery).mockRejectedValueOnce(new Error('First failure.'));

    const { result } = renderHook(() => useProgressMastery('v2008'));

    await waitFor(() => {
      expect(result.current.error).toBe('First failure.');
    });

    vi.mocked(getProgressMastery).mockResolvedValueOnce(MASTERY);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.mastery).toEqual(MASTERY);
  });
});
