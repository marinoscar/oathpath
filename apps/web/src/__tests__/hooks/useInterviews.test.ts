/**
 * `useInterviews` — the learner's own mock interviews (issue #145, epic #57 /
 * E8 "Mock interview").
 *
 * Shaped after `usePracticeSessions`, which this hook is deliberately modelled
 * on (see the hook's own header): same `isMounted` discipline, same "error is a
 * string the page renders, never an exception it has to catch" contract, same
 * `page`/`pageSize` call.
 *
 * WHAT THESE TESTS PROTECT:
 *
 *  1. **Loading, empty and failed stay three separate facts.** Collapsing any
 *     two is how a screen ends up rendering "you haven't sat one yet" for a
 *     request that actually failed — a fabricated absence, which `VISION.md`'s
 *     honesty rule treats exactly as it treats a fabricated zero.
 *  2. **A failure CLEARS the rows.** Leaving the previous list on screen under
 *     an error banner presents a history the server has just refused to confirm
 *     as though it were current.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { useInterviews, RECENT_INTERVIEW_COUNT } from '../../hooks/useInterviews';
import * as api from '../../services/api';
import type { InterviewListItem, InterviewPage } from '../../types';

vi.mock('../../services/api', () => ({
  getInterviews: vi.fn(),
}));

const ROW: InterviewListItem = {
  id: 'interview-1',
  mode: 'text',
  status: 'completed',
  testVersionCode: 'v2008',
  seniorExemption: false,
  transcriptRetained: false,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: '2026-03-01T12:20:00.000Z',
  civicsAsked: 8,
  civicsCorrect: 6,
  passedCivics: true,
};

function page(items: InterviewListItem[]): InterviewPage {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: RECENT_INTERVIEW_COUNT,
    totalPages: 1,
  };
}

describe('useInterviews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks for the first page, at the band’s own size', async () => {
    vi.mocked(api.getInterviews).mockResolvedValue(page([ROW]));

    const { result } = renderHook(() => useInterviews());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(api.getInterviews).toHaveBeenCalledWith({
      page: 1,
      pageSize: RECENT_INTERVIEW_COUNT,
    });
    expect(result.current.interviews).toEqual([ROW]);
    expect(result.current.error).toBeNull();
  });

  it('reports an empty history as empty, not as an error', async () => {
    // THE DISTINCTION THE WHOLE HOOK EXISTS TO KEEP: "we asked and there is
    // nothing" is a real, honest answer, and the only one of the three states
    // that is an empty state.
    vi.mocked(api.getInterviews).mockResolvedValue(page([]));

    const { result } = renderHook(() => useInterviews());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.interviews).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a failure as a string, and clears the rows', async () => {
    vi.mocked(api.getInterviews).mockResolvedValueOnce(page([ROW]));
    const { result } = renderHook(() => useInterviews());
    await waitFor(() => expect(result.current.interviews).toEqual([ROW]));

    vi.mocked(api.getInterviews).mockRejectedValueOnce(
      new Error('Your past interviews could not be loaded.'),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe('Your past interviews could not be loaded.');
    // CLEARED. A stale list under an error banner is data the server has just
    // declined to confirm, rendered as fact.
    expect(result.current.interviews).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('says something renderable when the rejection is not an Error', async () => {
    vi.mocked(api.getInterviews).mockRejectedValue('nope');

    const { result } = renderHook(() => useInterviews());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Your past interviews could not be loaded.');
  });

  it('clears a previous error on a successful retry', async () => {
    vi.mocked(api.getInterviews).mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useInterviews());
    await waitFor(() => expect(result.current.error).toBe('boom'));

    vi.mocked(api.getInterviews).mockResolvedValueOnce(page([ROW]));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.interviews).toEqual([ROW]);
  });
});
