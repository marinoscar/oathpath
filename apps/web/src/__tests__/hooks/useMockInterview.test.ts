/**
 * `useMockInterview` — the interview as React state (issue #140, epic #57 / E8).
 *
 * Driven through a stubbed `fetch` rather than MSW, for the reason
 * `ExplainPanel.test.tsx` gives: the interesting properties are about WHEN
 * bytes arrive and about which signal is fired, and a handler that resolves a
 * whole body at once can demonstrate neither.
 *
 * WHAT THESE TESTS PROTECT, in order of how quietly each would break:
 *
 *  1. **THE LOAD-BEARING ONE: `unavailable` still applies the turn.** The
 *     interview advanced — same next question, same grading, same stop rule —
 *     and only the officer's wording is plainer (`mock-interview.md` §5.2). A
 *     hook that treated it as a dead end would leave the screen on a question
 *     the server has already moved past, and the learner's next answer would be
 *     graded against a question they were never shown. Nothing else would look
 *     wrong.
 *  2. **A terminal frame this bundle cannot decode re-reads the server**
 *     instead of showing an error over an interview that is fine. The turn was
 *     committed before the response opened, so the server is the one place that
 *     certainly knows what happened.
 *  3. **The applicant's own turns are filtered out of the transcript.** With
 *     retention off they are persisted with empty text on purpose (§8.2), and a
 *     screen that rendered them would tell a learner, wordlessly and falsely,
 *     that they said nothing.
 *  4. **Ending the interview aborts the stream**, because the officer's words
 *     are generated on the learner's own key.
 *  5. **No verdict reaches this hook**, because nothing sends it one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useMockInterview } from '../../hooks/useMockInterview';
import type { Interview, InterviewDetail, InterviewTurnRecord } from '../../types';

const INTERVIEW_ID = 'interview-1';
const encoder = new TextEncoder();

const INTERVIEW: Interview = {
  id: INTERVIEW_ID,
  mode: 'text',
  status: 'in_progress',
  testVersionCode: 'v2008',
  seniorExemption: false,
  transcriptRetained: false,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: null,
  civicsAsked: 0,
  civicsCorrect: 0,
  passedCivics: false,
};

function officerTurn(overrides: Partial<InterviewTurnRecord> = {}): InterviewTurnRecord {
  return {
    id: 'turn-1',
    turnIndex: 0,
    role: 'officer',
    phase: 'smalltalk',
    questionId: null,
    text: 'Good morning. How are you doing today?',
    createdAt: '2026-03-01T12:00:00.000Z',
    ...overrides,
  };
}

/** The applicant turn a retention-off interview persists with empty text. */
const EMPTY_APPLICANT_TURN: InterviewTurnRecord = {
  id: 'turn-2',
  turnIndex: 1,
  role: 'applicant',
  phase: 'smalltalk',
  questionId: null,
  text: '',
  createdAt: '2026-03-01T12:01:00.000Z',
};

const CIVICS_TURN: InterviewTurnRecord = officerTurn({
  id: 'turn-3',
  turnIndex: 2,
  phase: 'civics',
  questionId: 'question-9',
  text: 'Thank you. Let us continue.\n\nWhat is the supreme law of the land?',
});

const OUTCOME = {
  officerTurns: [CIVICS_TURN],
  phase: 'civics',
  turnIndex: 2,
  progress: { civicsAsked: 1, civicsPlanned: 10 },
  awaitingCompletion: false,
};

let realFetch: typeof globalThis.fetch;
let streamController: ReadableStreamDefaultController<Uint8Array> | null;
let turnSignal: AbortSignal | null;
let detail: InterviewDetail;
let detailReads: number;
let completeCalls: number;

function stubFetch() {
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);

      if (url.includes('/turns')) {
        turnSignal = init?.signal ?? null;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode(': connected\n\n'));
            init?.signal?.addEventListener('abort', () => {
              try {
                controller.error(new DOMException('Aborted', 'AbortError'));
              } catch {
                // Already closed.
              }
            });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      if (url.includes('/complete')) {
        completeCalls += 1;
        return json({ civics: { planned: 10, asked: 1, correct: 0 } });
      }

      detailReads += 1;
      return json(detail);
    },
  ) as typeof globalThis.fetch;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Write one SSE frame into the open stream and let React settle. */
async function emit(frame: string) {
  await act(async () => {
    streamController?.enqueue(encoder.encode(frame));
    await Promise.resolve();
  });
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  streamController = null;
  turnSignal = null;
  detailReads = 0;
  completeCalls = 0;
  detail = {
    interview: INTERVIEW,
    turns: [officerTurn()],
    progress: { civicsAsked: 0, civicsPlanned: 10 },
    awaitingCompletion: false,
    debrief: null,
  };
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function mount() {
  const rendered = renderHook(() => useMockInterview(INTERVIEW_ID));
  await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
  return rendered;
}

describe('useMockInterview — resuming from the server', () => {
  it('reads the interview and derives the phase from the last turn', async () => {
    const { result } = await mount();

    expect(result.current.interview?.id).toBe(INTERVIEW_ID);
    expect(result.current.officerTurns).toHaveLength(1);
    expect(result.current.phase).toBe('smalltalk');
    expect(result.current.progress).toEqual({ civicsAsked: 0, civicsPlanned: 10 });
    expect(result.current.turnStatus).toBe('idle');
  });

  it('keeps the applicant’s turns out of the transcript', async () => {
    // With retention off they are persisted with empty text on purpose. See
    // this file's header.
    detail = { ...detail, turns: [officerTurn(), EMPTY_APPLICANT_TURN] };

    const { result } = await mount();

    expect(result.current.officerTurns.map((turn) => turn.role)).toEqual(['officer']);
  });

  it('says so rather than throwing when the interview cannot be read', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'No such interview' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof globalThis.fetch;

    const { result } = await mount();

    expect(result.current.interview).toBeNull();
    expect(typeof result.current.loadError).toBe('string');
  });
});

describe('useMockInterview — taking a turn', () => {
  it('streams the officer’s words, then replaces them with the whole turn', async () => {
    const { result } = await mount();

    act(() => result.current.submitTurn('the Constitution'));
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    await emit('event: delta\ndata: {"text":"Thank you. "}\n\n');
    await waitFor(() => expect(result.current.streamingText).toBe('Thank you. '));

    await emit(`event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`);

    await waitFor(() => expect(result.current.turnStatus).toBe('complete'));
    // The partial is cleared because the turn appended below contains it
    // verbatim; keeping both would render the acknowledgement twice.
    expect(result.current.streamingText).toBe('');
    expect(result.current.officerTurns).toHaveLength(2);
    expect(result.current.officerTurns[1].text).toContain('supreme law of the land');
    expect(result.current.phase).toBe('civics');
    expect(result.current.progress).toEqual({ civicsAsked: 1, civicsPlanned: 10 });
  });

  it('applies the turn on `unavailable`, and reports it as not an error', async () => {
    const { result } = await mount();

    act(() => result.current.submitTurn('the Constitution'));
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    await emit(
      `event: unavailable\ndata: ${JSON.stringify({ ...OUTCOME, cause: 'role_unbound' })}\n\n`,
    );

    await waitFor(() => expect(result.current.turnStatus).toBe('unavailable'));
    expect(result.current.unavailableCause).toBe('role_unbound');
    // NOT an error, and NOT a dropped turn.
    expect(result.current.turnError).toBeNull();
    expect(result.current.officerTurns).toHaveLength(2);
    expect(result.current.phase).toBe('civics');
    expect(result.current.progress?.civicsAsked).toBe(1);
  });

  it('applies the turn on `error` too, and keeps the server’s redacted message', async () => {
    const { result } = await mount();

    act(() => result.current.submitTurn('the Constitution'));
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    await emit(
      `event: error\ndata: ${JSON.stringify({
        ...OUTCOME,
        errorCode: 'stream_transport_error',
        error: 'The officer’s reply could not be delivered.',
      })}\n\n`,
    );

    await waitFor(() => expect(result.current.turnStatus).toBe('error'));
    expect(result.current.turnError).toContain('could not be delivered');
    expect(result.current.officerTurns).toHaveLength(2);
    expect(result.current.phase).toBe('civics');
  });

  it('re-reads the server when a terminal frame’s outcome will not decode', async () => {
    const { result } = await mount();
    const readsBefore = detailReads;

    // What the server will say when asked: the turn really happened.
    detail = {
      ...detail,
      turns: [officerTurn(), EMPTY_APPLICANT_TURN, CIVICS_TURN],
      progress: { civicsAsked: 1, civicsPlanned: 10 },
    };

    act(() => result.current.submitTurn('the Constitution'));
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    await emit('event: done\ndata: {"phase":"interrogation"}\n\n');

    await waitFor(() => expect(detailReads).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(result.current.officerTurns).toHaveLength(2));
    expect(result.current.phase).toBe('civics');
    // Recovery, not a failure: nothing is reported to the learner.
    expect(result.current.turnError).toBeNull();
  });

  it('re-reads the server when the body closes with no terminal frame', async () => {
    const { result } = await mount();
    const readsBefore = detailReads;

    detail = {
      ...detail,
      turns: [officerTurn(), EMPTY_APPLICANT_TURN, CIVICS_TURN],
      progress: { civicsAsked: 1, civicsPlanned: 10 },
    };

    act(() => result.current.submitTurn('the Constitution'));
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    await act(async () => {
      streamController?.close();
      await Promise.resolve();
    });

    await waitFor(() => expect(detailReads).toBeGreaterThan(readsBefore));
    expect(result.current.turnError).toBeNull();
  });
});

describe('useMockInterview — ending it', () => {
  it('aborts the stream before completing, then returns the debrief', async () => {
    const { result } = await mount();

    act(() => result.current.submitTurn('the Constitution'));
    await waitFor(() => expect(result.current.isStreaming).toBe(true));
    expect(turnSignal?.aborted).toBe(false);

    let debrief: unknown = null;
    await act(async () => {
      debrief = await result.current.complete();
    });

    // ABORT IS THE FEATURE: the officer's words are generated on the learner's
    // own key, and a conversation that is over should stop costing money.
    expect(turnSignal?.aborted).toBe(true);
    expect(completeCalls).toBe(1);
    expect(debrief).not.toBeNull();
    expect(result.current.completeError).toBeNull();
  });

  it('reports a refused completion instead of pretending it finished', async () => {
    const { result } = await mount();

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'That interview is abandoned' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof globalThis.fetch;

    let debrief: unknown = 'unset';
    await act(async () => {
      debrief = await result.current.complete();
    });

    expect(debrief).toBeNull();
    expect(typeof result.current.completeError).toBe('string');
  });
});

describe('useMockInterview — what it never holds', () => {
  it('exposes no verdict, no score and no correct count', async () => {
    const { result } = await mount();

    act(() => result.current.submitTurn('the Constitution'));
    await waitFor(() => expect(result.current.isStreaming).toBe(true));
    await emit(`event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`);
    await waitFor(() => expect(result.current.turnStatus).toBe('complete'));

    // §10. The engine knew the grade the instant it computed it and
    // deliberately does not send it; there is nowhere here for one to land.
    const keys = Object.keys(result.current);
    for (const forbidden of ['outcome', 'correct', 'score', 'verdict', 'feedback']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(result.current.progress).not.toHaveProperty('civicsCorrect');
  });
});
