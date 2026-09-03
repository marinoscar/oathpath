/**
 * `streamInterviewTurn` — the client half of `POST /api/interviews/:id/turns`
 * (issue #140, epic #57 / E8).
 *
 * Driven through a stubbed `fetch` rather than MSW, for the reason
 * `ExplainPanel.test.tsx` gives: every interesting property here is about what
 * arrives on the wire and when, and a handler that resolves a whole body at
 * once can demonstrate none of it.
 *
 * WHAT THESE TESTS PROTECT, in order of how quietly each would break:
 *
 *  1. **THE LOAD-BEARING ONE: `unavailable` and `error` carry the turn.** This
 *     is the difference from the explain stream, and it is `mock-interview.md`
 *     §5.2 on the wire — the interview advanced in all three cases, only the
 *     officer's wording differs. A decoder that read `officerTurns` off `done`
 *     alone would drop a turn that really happened, leaving the screen on a
 *     question the server has already moved past.
 *  2. **The body is `{ text }` and nothing else** — no `questionId`, no
 *     `phase`, no `skipped`. Which question is being answered is the engine's
 *     state, not the client's claim.
 *  3. **A truncated terminal payload decodes to `outcome: null`, not to a
 *     half-applied turn.** Null is the hook's signal to re-read the server; a
 *     partially-decoded outcome would silently put the learner on the wrong
 *     question.
 *  4. **The opening `: connected` comment is not an event**, and an
 *     unrecognised frame is ignored rather than rendered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  isTerminalFrame,
  streamInterviewTurn,
  type InterviewTurnFrame,
} from '../../services/interviewStream';

const INTERVIEW_ID = 'interview-1';
const encoder = new TextEncoder();

let realFetch: typeof globalThis.fetch;
let streamController: ReadableStreamDefaultController<Uint8Array> | null;
let requestBodies: (string | undefined)[];

function stubFetch() {
  globalThis.fetch = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestBodies.push(init?.body as string | undefined);

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          // The API writes this immediately so the headers flush. It is a
          // COMMENT, not an event, and must never reach a consumer.
          controller.enqueue(encoder.encode(': connected\n\n'));

          // A real `fetch` errors the body when its signal fires. The stub has
          // to as well, or an abort test would hang on a reader nobody woke —
          // and the abort path is the one this feature spends money on.
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.error(new DOMException('Aborted', 'AbortError'));
            } catch {
              // Already closed. Nothing to do.
            }
          });
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  ) as typeof globalThis.fetch;
}

/** The officer turn the API returns on every terminal frame below. */
const OFFICER_TURN = {
  id: 'turn-4',
  turnIndex: 4,
  role: 'officer',
  phase: 'civics',
  questionId: 'question-9',
  text: 'Thank you. Let us continue.\n\nWhat is the supreme law of the land?',
  createdAt: '2026-03-01T12:04:00.000Z',
};

const OUTCOME = {
  officerTurns: [OFFICER_TURN],
  phase: 'civics',
  turnIndex: 4,
  progress: { civicsAsked: 2, civicsPlanned: 10 },
  awaitingCompletion: false,
};

/**
 * Run one turn against a scripted stream and collect what the consumer saw.
 *
 * The frames are written INSIDE the promise's lifetime, after the reader has
 * been handed the body, which is the only ordering that exercises the parser
 * the way the network does.
 */
async function collect(frames: string[]): Promise<InterviewTurnFrame[]> {
  stubFetch();
  const received: InterviewTurnFrame[] = [];
  const controller = new AbortController();

  const done = streamInterviewTurn(INTERVIEW_ID, 'the Constitution', {
    signal: controller.signal,
    onFrame: (frame) => received.push(frame),
  });

  // One microtask turn, so the reader is attached before anything is written.
  await Promise.resolve();
  for (const frame of frames) {
    streamController?.enqueue(encoder.encode(frame));
  }
  streamController?.close();
  await done;

  return received;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  streamController = null;
  requestBodies = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('streamInterviewTurn — the frames', () => {
  it('decodes deltas and a `done` frame carrying the turn outcome', async () => {
    const received = await collect([
      `event: delta\ndata: ${JSON.stringify({ text: 'Thank you. ' })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ text: 'Let us continue.' })}\n\n`,
      `event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`,
    ]);

    expect(received).toHaveLength(3);
    expect(received[0]).toEqual({ event: 'delta', text: 'Thank you. ' });
    expect(received[1]).toEqual({ event: 'delta', text: 'Let us continue.' });

    const terminal = received[2];
    expect(terminal.event).toBe('done');
    if (terminal.event !== 'done') throw new Error('expected a done frame');
    expect(terminal.outcome?.phase).toBe('civics');
    expect(terminal.outcome?.progress).toEqual({ civicsAsked: 2, civicsPlanned: 10 });
    expect(terminal.outcome?.officerTurns).toHaveLength(1);
    expect(terminal.outcome?.officerTurns[0].text).toContain(
      'What is the supreme law of the land?',
    );
  });

  it('carries the turn outcome on `unavailable` too, with its cause', async () => {
    // THE LOAD-BEARING ONE. `mock-interview.md` §5.2: the engine substituted a
    // neutral officer line and proceeded identically — the turn happened.
    const received = await collect([
      `event: unavailable\ndata: ${JSON.stringify({
        ...OUTCOME,
        cause: 'role_unbound',
      })}\n\n`,
    ]);

    const frame = received[0];
    expect(frame.event).toBe('unavailable');
    if (frame.event !== 'unavailable') throw new Error('expected unavailable');
    expect(frame.cause).toBe('role_unbound');
    expect(frame.outcome).not.toBeNull();
    expect(frame.outcome?.officerTurns[0].text).toContain('supreme law');
    expect(frame.outcome?.progress.civicsAsked).toBe(2);
  });

  it('carries the turn outcome on `error` too, with its redacted message', async () => {
    const received = await collect([
      `event: error\ndata: ${JSON.stringify({
        ...OUTCOME,
        errorCode: 'stream_transport_error',
        error: 'The officer’s reply could not be delivered.',
      })}\n\n`,
    ]);

    const frame = received[0];
    expect(frame.event).toBe('error');
    if (frame.event !== 'error') throw new Error('expected error');
    expect(frame.errorCode).toBe('stream_transport_error');
    expect(frame.error).toContain('could not be delivered');
    expect(frame.outcome?.phase).toBe('civics');
  });

  it('falls back to an administrator-side cause when the cause is unknown', async () => {
    // Never `no_user_key`: guessing that would send a learner to replace a key
    // that is fine.
    const received = await collect([
      `event: unavailable\ndata: ${JSON.stringify({ ...OUTCOME, cause: 'something_new' })}\n\n`,
    ]);

    const frame = received[0];
    if (frame.event !== 'unavailable') throw new Error('expected unavailable');
    expect(frame.cause).toBe('capability_unsupported');
  });

  it('reports `outcome: null` rather than half a turn when the payload is truncated', async () => {
    const received = await collect([
      // No `progress`, and a phase this bundle has never heard of.
      `event: done\ndata: ${JSON.stringify({ phase: 'interrogation', officerTurns: [] })}\n\n`,
    ]);

    const frame = received[0];
    if (frame.event !== 'done') throw new Error('expected a done frame');
    expect(frame.outcome).toBeNull();
  });

  it('accepts an empty `officerTurns` array — the API documents one', async () => {
    const received = await collect([
      `event: done\ndata: ${JSON.stringify({ ...OUTCOME, officerTurns: [] })}\n\n`,
    ]);

    const frame = received[0];
    if (frame.event !== 'done') throw new Error('expected a done frame');
    expect(frame.outcome).not.toBeNull();
    expect(frame.outcome?.officerTurns).toEqual([]);
  });

  it('ignores the opening comment, an empty delta, and an unrecognised frame', async () => {
    const received = await collect([
      `event: delta\ndata: ${JSON.stringify({ text: '' })}\n\n`,
      'event: someday\ndata: {"text":"from a newer server"}\n\n',
      `event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`,
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].event).toBe('done');
  });
});

describe('streamInterviewTurn — the request', () => {
  it('sends `{ text }` and nothing else', async () => {
    // No `questionId`, no `phase`, no `skipped`, no `revealed`, no `hintUsed`:
    // the API's DTO is a `strictObject`, so an invented key is a 400 — and
    // which question this answers is the engine's own state, never a claim the
    // client gets to make.
    await collect([`event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`]);

    expect(requestBodies).toHaveLength(1);
    expect(JSON.parse(requestBodies[0] as string)).toEqual({
      text: 'the Constitution',
    });
  });

  it('sends an empty answer rather than refusing it', async () => {
    stubFetch();
    const controller = new AbortController();
    const done = streamInterviewTurn(INTERVIEW_ID, '', {
      signal: controller.signal,
      onFrame: () => {},
    });
    await Promise.resolve();
    streamController?.enqueue(
      encoder.encode(`event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`),
    );
    streamController?.close();
    await done;

    // An applicant who says nothing has still taken their turn.
    expect(JSON.parse(requestBodies[0] as string)).toEqual({ text: '' });
  });

  it('rejects when the learner aborts, so the caller can tell it apart', async () => {
    stubFetch();
    const controller = new AbortController();
    const done = streamInterviewTurn(INTERVIEW_ID, 'anything', {
      signal: controller.signal,
      onFrame: () => {},
    });

    await Promise.resolve();
    controller.abort();

    await expect(done).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('isTerminalFrame', () => {
  it('is true for all three terminal frames and false for a delta', () => {
    expect(isTerminalFrame({ event: 'delta', text: 'x' })).toBe(false);
    expect(isTerminalFrame({ event: 'done', outcome: null })).toBe(true);
    expect(
      isTerminalFrame({
        event: 'unavailable',
        outcome: null,
        cause: 'ai_disabled',
      }),
    ).toBe(true);
    expect(
      isTerminalFrame({
        event: 'error',
        outcome: null,
        errorCode: 'x',
        error: 'y',
      }),
    ).toBe(true);
  });
});
