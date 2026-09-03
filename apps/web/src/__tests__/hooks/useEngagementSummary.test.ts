/**
 * `useEngagementSummary` — the fetch hook behind the goal ring and the streak
 * on Home (#138), and the celebration on the practice summary (#138).
 *
 * Shaped after `useReadiness.test.ts`: the API module is mocked at the named
 * export the hook itself imports (`getEngagementSummary`), not at the generic
 * `api.get`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { useEngagementSummary } from '../../hooks/useEngagementSummary';
import { getEngagementSummary } from '../../services/api';
import { engagementSummary } from '../utils/engagement-fixtures';

vi.mock('../../services/api', () => ({
  getEngagementSummary: vi.fn(),
}));

const SUMMARY = engagementSummary();

describe('useEngagementSummary — loading to success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts loading immediately, with no gating parameter to wait on', async () => {
    vi.mocked(getEngagementSummary).mockResolvedValue(SUMMARY);

    const { result } = renderHook(() => useEngagementSummary());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.engagement).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(getEngagementSummary).toHaveBeenCalledTimes(1);
    expect(result.current.engagement).toEqual(SUMMARY);
    expect(result.current.error).toBeNull();
  });
});

describe('useEngagementSummary — loading to error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces an Error message as a string, and clears the summary on failure', async () => {
    vi.mocked(getEngagementSummary).mockRejectedValue(new Error('Server error.'));

    const { result } = renderHook(() => useEngagementSummary());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Server error.');
    expect(result.current.engagement).toBeNull();
  });

  it('falls back to a generic message for a non-Error rejection', async () => {
    vi.mocked(getEngagementSummary).mockRejectedValue('a plain string rejection');

    const { result } = renderHook(() => useEngagementSummary());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Your daily goal could not be loaded.');
  });

  it('clears a previously loaded summary when a refresh then fails', async () => {
    vi.mocked(getEngagementSummary).mockResolvedValueOnce(SUMMARY);

    const { result } = renderHook(() => useEngagementSummary());

    await waitFor(() => {
      expect(result.current.engagement).toEqual(SUMMARY);
    });

    vi.mocked(getEngagementSummary).mockRejectedValueOnce(new Error('Server error.'));

    await act(async () => {
      await result.current.refresh();
    });

    // A stale ring under an error banner would present a measurement the
    // server has just refused to confirm as though it were still current.
    expect(result.current.engagement).toBeNull();
    expect(result.current.error).toBe('Server error.');
  });

  it('clears a previous error on a successful refresh', async () => {
    vi.mocked(getEngagementSummary).mockRejectedValueOnce(new Error('First failure.'));

    const { result } = renderHook(() => useEngagementSummary());

    await waitFor(() => {
      expect(result.current.error).toBe('First failure.');
    });

    vi.mocked(getEngagementSummary).mockResolvedValueOnce(SUMMARY);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.engagement).toEqual(SUMMARY);
  });
});
