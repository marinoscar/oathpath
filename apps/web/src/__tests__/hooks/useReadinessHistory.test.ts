/**
 * `useReadinessHistory` — the fetch hook behind the readiness trend, shared
 * by `ProgressPage` (#139) and the Home widget's prior-score comparison
 * (#142).
 *
 * Shaped after `useReadiness.test.ts`/`useProgressMastery.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { useReadinessHistory } from '../../hooks/useReadinessHistory';
import { getReadinessHistory } from '../../services/api';
import { readinessHistoryResponse, readinessSnapshot } from '../utils/readiness-fixtures';

vi.mock('../../services/api', () => ({
  getReadinessHistory: vi.fn(),
}));

const CURRENT = readinessSnapshot({ id: 'current', score: 65 });
const PREVIOUS = readinessSnapshot({ id: 'previous', score: 59 });

describe('useReadinessHistory — loading to success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts loading immediately, fetches page 1 with a fixed page size, and returns newest-first items', async () => {
    vi.mocked(getReadinessHistory).mockResolvedValue(
      readinessHistoryResponse([CURRENT, PREVIOUS]),
    );

    const { result } = renderHook(() => useReadinessHistory());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.history).toEqual([]);
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(getReadinessHistory).toHaveBeenCalledTimes(1);
    expect(getReadinessHistory).toHaveBeenCalledWith({ page: 1, pageSize: 30 });
    expect(result.current.history).toEqual([CURRENT, PREVIOUS]);
    expect(result.current.error).toBeNull();
  });

  it('starts with an empty array before the first read, never null and never fabricated rows', async () => {
    vi.mocked(getReadinessHistory).mockResolvedValue(readinessHistoryResponse([]));

    const { result } = renderHook(() => useReadinessHistory());

    expect(result.current.history).toEqual([]);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.history).toEqual([]);
  });
});

describe('useReadinessHistory — loading to error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces an Error message as a string, and clears history on failure', async () => {
    vi.mocked(getReadinessHistory).mockRejectedValue(new Error('Server error.'));

    const { result } = renderHook(() => useReadinessHistory());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Server error.');
    expect(result.current.history).toEqual([]);
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    vi.mocked(getReadinessHistory).mockRejectedValue('a plain string rejection');

    const { result } = renderHook(() => useReadinessHistory());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Your readiness history could not be loaded.');
  });

  it('clears a previously loaded history when a refresh then fails', async () => {
    vi.mocked(getReadinessHistory).mockResolvedValueOnce(
      readinessHistoryResponse([CURRENT, PREVIOUS]),
    );

    const { result } = renderHook(() => useReadinessHistory());

    await waitFor(() => {
      expect(result.current.history).toEqual([CURRENT, PREVIOUS]);
    });

    vi.mocked(getReadinessHistory).mockRejectedValueOnce(new Error('Server error.'));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.history).toEqual([]);
    expect(result.current.error).toBe('Server error.');
  });
});
