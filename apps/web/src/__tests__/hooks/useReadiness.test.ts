/**
 * `useReadiness` — the fetch hook behind the readiness score, shared by
 * `ProgressPage` (#139) and the Home widget (#142).
 *
 * Shaped after `useProgressMastery.test.ts`: the API module is mocked at the
 * named-export boundary the hook itself imports (`getReadiness`), not the
 * generic `api.get`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { useReadiness } from '../../hooks/useReadiness';
import { getReadiness } from '../../services/api';
import { readinessSnapshot } from '../utils/readiness-fixtures';

vi.mock('../../services/api', () => ({
  getReadiness: vi.fn(),
}));

const SNAPSHOT = readinessSnapshot();

describe('useReadiness — loading to success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts loading immediately, with no gating parameter to wait on', async () => {
    vi.mocked(getReadiness).mockResolvedValue(SNAPSHOT);

    const { result } = renderHook(() => useReadiness());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.readiness).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(getReadiness).toHaveBeenCalledTimes(1);
    expect(result.current.readiness).toEqual(SNAPSHOT);
    expect(result.current.error).toBeNull();
  });
});

describe('useReadiness — loading to error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces an Error message as a string, and clears readiness on failure', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new Error('Server error.'));

    const { result } = renderHook(() => useReadiness());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Server error.');
    expect(result.current.readiness).toBeNull();
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    vi.mocked(getReadiness).mockRejectedValue('a plain string rejection');

    const { result } = renderHook(() => useReadiness());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Your readiness could not be loaded.');
  });

  it('clears a previously loaded snapshot when a refresh then fails', async () => {
    vi.mocked(getReadiness).mockResolvedValueOnce(SNAPSHOT);

    const { result } = renderHook(() => useReadiness());

    await waitFor(() => {
      expect(result.current.readiness).toEqual(SNAPSHOT);
    });

    vi.mocked(getReadiness).mockRejectedValueOnce(new Error('Server error.'));

    await act(async () => {
      await result.current.refresh();
    });

    // A stale score under an error banner would present a measurement the
    // server just refused to confirm as though it were still current.
    expect(result.current.readiness).toBeNull();
    expect(result.current.error).toBe('Server error.');
  });

  it('clears a previous error on a successful refresh', async () => {
    vi.mocked(getReadiness).mockRejectedValueOnce(new Error('First failure.'));

    const { result } = renderHook(() => useReadiness());

    await waitFor(() => {
      expect(result.current.error).toBe('First failure.');
    });

    vi.mocked(getReadiness).mockResolvedValueOnce(SNAPSHOT);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.readiness).toEqual(SNAPSHOT);
  });
});
