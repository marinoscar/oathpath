/**
 * `ExplainPanel` — the streamed tutor explanation (issue #125, epic #53).
 *
 * The stream is driven directly through a stubbed `fetch` rather than through
 * MSW, because every interesting property of this component is about WHEN
 * bytes arrive: the DOM has to grow between two `delta` frames, the terminal
 * frame has to change the state, and the abort has to reach the request. A
 * handler that resolves a whole body at once can demonstrate none of those —
 * it would assert that the finished text eventually appears, which is the one
 * thing that would still pass if the streaming were removed entirely.
 *
 * The stub also answers `/api/ai/status`, so `AiStatusProvider` sees whatever
 * this file says it should and `AiNotReady` renders from a real context rather
 * than a mock of itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { ExplainPanel } from '../../../components/ai/ExplainPanel';
import { AiStatusProvider } from '../../../contexts/AiStatusContext';
import { AuthContext } from '../../../contexts/AuthContext';
import { mockUser } from '../../utils/test-utils';
import type { AiStatus } from '../../../types';

// -----------------------------------------------------------------------------
// A hand-driven event stream
// -----------------------------------------------------------------------------

const READY: AiStatus = {
  userKeyConfigured: true,
  systemReady: true,
  enabled: true,
  providerConfigured: true,
  unboundRoles: [],
};

const NOT_READY: AiStatus = {
  ...READY,
  systemReady: false,
  unboundRoles: ['tutor'],
};

const encoder = new TextEncoder();

let realFetch: typeof globalThis.fetch;
let streamController: ReadableStreamDefaultController<Uint8Array> | null;
/** The signal the explanation request was opened with, for the abort tests. */
let explainSignal: AbortSignal | null;
let explainCalls: number;
let explainBodies: (string | undefined)[];

interface StubOptions {
  status?: AiStatus;
  /** A non-2xx response for the explain route, for the transport-failure case. */
  explainHttpStatus?: number;
}

/**
 * What `/api/ai/status` answers RIGHT NOW.
 *
 * Mutable, and read per request rather than captured, because the interesting
 * case is exactly the one where it CHANGES mid-test: the panel re-reads the
 * status when the stream contradicts it, and a captured value would make that
 * refetch return the stale answer the server has just disagreed with.
 */
let currentStatus: AiStatus = READY;

function setStatus(status: AiStatus) {
  currentStatus = status;
}

function stubFetch({ status = READY, explainHttpStatus }: StubOptions = {}) {
  currentStatus = status;

  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);

      if (url.includes('/ai/status')) {
        return new Response(JSON.stringify({ data: currentStatus }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.includes('/explain')) {
        explainCalls += 1;
        explainSignal = init?.signal ?? null;
        explainBodies.push(init?.body as string | undefined);

        if (explainHttpStatus && explainHttpStatus !== 200) {
          return new Response('', { status: explainHttpStatus });
        }

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            // The API writes this comment frame immediately so the headers
            // flush. It must be invisible to the panel — a `: comment` is not
            // an event, and rendering it would put a colon at the top of every
            // explanation.
            controller.enqueue(encoder.encode(': connected\n\n'));
          },
        });

        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }

      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  ) as typeof globalThis.fetch;
}

/** Write one SSE frame into the open stream and let React settle. */
async function emit(frame: string) {
  await act(async () => {
    streamController?.enqueue(encoder.encode(frame));
    await Promise.resolve();
  });
}

async function endStream() {
  await act(async () => {
    streamController?.close();
    await Promise.resolve();
  });
}

const delta = (text: string) =>
  `event: delta\ndata: ${JSON.stringify({ text })}\n\n`;

function renderPanel(questionId = 'question-1') {
  const auth = {
    user: mockUser,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  };

  return render(
    <AuthContext.Provider value={auth as never}>
      <MemoryRouter>
        <AiStatusProvider>
          <ExplainPanel questionId={questionId} />
        </AiStatusProvider>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

/** The live region's current text — the only thing a learner actually reads. */
function explanationText(container: HTMLElement): string {
  return container.querySelector('[aria-label="Explanation"]')?.textContent ?? '';
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  streamController = null;
  explainSignal = null;
  explainCalls = 0;
  explainBodies = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// -----------------------------------------------------------------------------
// Streaming
// -----------------------------------------------------------------------------

describe('ExplainPanel — the explanation arrives in pieces', () => {
  it('grows the DOM as frames arrive, and finishes on `done`', async () => {
    stubFetch();
    const user = userEvent.setup();
    const { container } = renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );

    await emit(delta('The Constitution '));
    await waitFor(() =>
      expect(explanationText(container)).toContain('The Constitution'),
    );
    const afterFirst = explanationText(container);

    await emit(delta('is the supreme law of the land.'));
    await waitFor(() =>
      expect(explanationText(container)).toContain('supreme law of the land'),
    );

    // THE ASSERTION THAT ONLY STREAMING PASSES: the region held one frame's
    // worth of text and then held more, rather than appearing whole at the end.
    expect(explanationText(container).length).toBeGreaterThan(afterFirst.length);
    expect(explanationText(container)).toBe(
      'The Constitution is the supreme law of the land.',
    );

    // The opening `: connected` comment is not an event and never reaches the
    // page.
    expect(explanationText(container)).not.toContain('connected');

    await emit('event: done\ndata: {"usage":{"totalTokens":42}}\n\n');
    await endStream();

    expect(await screen.findByText('Explanation finished.')).toBeInTheDocument();
    // The text survives the terminal frame — it is the whole point of the call.
    expect(explanationText(container)).toContain('supreme law of the land');
  });

  it('marks the region busy while streaming and settled when it ends', async () => {
    stubFetch();
    const user = userEvent.setup();
    const { container } = renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );
    await emit(delta('The Constitution.'));

    const region = () => container.querySelector('[aria-label="Explanation"]');

    // `aria-busy` while tokens arrive, so a screen reader is not read a
    // fragment of a word per frame.
    await waitFor(() => expect(region()).toHaveAttribute('aria-busy', 'true'));
    expect(region()).toHaveAttribute('aria-live', 'polite');

    await emit('event: done\ndata: {"usage":{}}\n\n');
    await endStream();

    await waitFor(() => expect(region()).toHaveAttribute('aria-busy', 'false'));
  });

  it('sends no state, no user id, and no body at all without a focus note', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );
    await waitFor(() => expect(explainCalls).toBe(1));

    // The DTO is a `strictObject` and the caller is the bearer of the token:
    // an invented key would be a 400, and there is nothing here to invent one
    // with.
    expect(explainBodies[0]).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Stopping, and the cost of not stopping
// -----------------------------------------------------------------------------

describe('ExplainPanel — the learner can stop it, and unmounting does', () => {
  it('aborts the request when the learner presses Stop', async () => {
    stubFetch();
    const user = userEvent.setup();
    const { container } = renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );
    await emit(delta('The Constitution '));

    await user.click(await screen.findByRole('button', { name: /stop/i }));

    // THE REQUEST IS ACTUALLY CANCELLED. Every token is billed to the
    // learner's own key, so a "stop" that only stops rendering is a stop that
    // keeps spending their money.
    expect(explainSignal?.aborted).toBe(true);
    expect(await screen.findByText('You stopped this explanation.')).toBeInTheDocument();
    // What arrived stays: those tokens were really generated and really paid for.
    expect(explanationText(container)).toContain('The Constitution');
  });

  it('aborts the request on unmount', async () => {
    stubFetch();
    const user = userEvent.setup();
    const { unmount } = renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );
    await emit(delta('The Constitution '));

    unmount();

    expect(explainSignal?.aborted).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// The endings that are not errors
// -----------------------------------------------------------------------------

describe('ExplainPanel — terminal states', () => {
  it('renders the shared AiNotReady component when the stream ends unavailable', async () => {
    // THE REALISTIC RACE: the cached status still says ready — an
    // administrator unbound the tutor model since this page loaded — so the
    // panel offers the action, and the ENDPOINT is what says otherwise.
    stubFetch({ status: READY });
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );

    // From here the status endpoint tells the truth, which the panel re-reads
    // when the frame contradicts its cache.
    setStatus(NOT_READY);
    await emit('event: unavailable\ndata: {"cause":"role_unbound"}\n\n');
    await endStream();

    // #43's component, by its one load-bearing sentence — never a toast, never
    // a spinner, never a silent absence.
    expect(
      await screen.findByText(/This is not a problem with your key/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No explanation is available right now.'),
    ).toBeInTheDocument();

    // ONCE, not twice. The panel refreshes the cached status when the stream
    // contradicts it, so both the pre-press branch and the terminal branch
    // become true — and the same message rendered twice reads as two separate
    // problems.
    expect(
      screen.getAllByText(/This is not a problem with your key/i),
    ).toHaveLength(1);

    // NOT AN ERROR. Nothing is broken and nothing was spent, so nothing on
    // screen says something went wrong.
    expect(document.body.textContent).not.toMatch(/could not|failed|error/i);
  });

  it('points a learner with no key at their own settings, not at the admin message', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );
    await emit('event: unavailable\ndata: {"cause":"no_user_key"}\n\n');
    await endStream();

    expect(
      await screen.findByText(/Add your AI key to see explanations/i),
    ).toBeInTheDocument();
    // "Nothing is wrong on your side" is NOT true of this cause, which is
    // exactly why it is not routed through the shared component.
    expect(
      screen.queryByText(/This is not a problem with your key/i),
    ).not.toBeInTheDocument();
  });

  it('asks for a state rather than guessing one', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );
    await emit(
      'event: state_required\ndata: {"answerResolution":"state_required"}\n\n',
    );
    await endStream();

    // The same notice `/learn` already shows this learner for this question —
    // not an AI message, because the remedy is a profile field.
    expect(
      await screen.findByText(/Set your state to see this answer/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/This is not a problem with your key/i),
    ).not.toBeInTheDocument();
  });

  it('reports a real failure as an error, with a way to try again', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );
    await emit(
      'event: error\ndata: {"errorCode":"provider_error","error":"The model did not respond."}\n\n',
    );
    await endStream();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The model did not respond.',
    );
    // The stable grouping code is for logs, not for a person.
    expect(document.body.textContent).not.toContain('provider_error');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('does not present a truncated stream as a finished explanation', async () => {
    stubFetch();
    const user = userEvent.setup();
    const { container } = renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );
    await emit(delta('The Constitution '));
    // The body closes with NO terminal frame — a proxy timing out mid-answer.
    await endStream();

    expect(
      await screen.findByText('This explanation did not finish.'),
    ).toBeInTheDocument();
    expect(explanationText(container)).toContain('The Constitution');
    expect(screen.queryByText('Explanation finished.')).not.toBeInTheDocument();
  });

  it('reports a refused request without losing the retry', async () => {
    stubFetch({ explainHttpStatus: 502 });
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: /explain this answer/i }),
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// systemReady === false, before anything is pressed
// -----------------------------------------------------------------------------

describe('ExplainPanel — systemReady === false', () => {
  it('disables the action AND says why, with the shared component', async () => {
    stubFetch({ status: NOT_READY });
    renderPanel();

    expect(
      await screen.findByText(/This is not a problem with your key/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /explain this answer/i }),
    ).toBeDisabled();

    // A disabled control with no explanation is the failure this pair exists
    // to avoid; a spinner or a silent absence would be worse still.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('spends nothing while it is blocked', async () => {
    stubFetch({ status: NOT_READY });
    // `pointerEventsCheck: 0` because MUI gives a disabled button
    // `pointer-events: none`, which user-event refuses to click through. The
    // point of the case is what happens if a press somehow lands, so the check
    // is the thing being bypassed rather than the thing being tested.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPanel();

    await screen.findByText(/This is not a problem with your key/i);
    await user.click(screen.getByRole('button', { name: /explain this answer/i }));

    expect(explainCalls).toBe(0);
  });

  it('offers the action normally when the status cannot be read at all', async () => {
    // The provider fails open by design (`AiStatusContext`), and a cache that
    // cannot be read must never remove a feature: the endpoint is the
    // authority, and it will say `unavailable` if it really is.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/ai/status')) throw new Error('network down');
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    renderPanel();

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /explain this answer/i }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByText(/This is not a problem with your key/i),
    ).not.toBeInTheDocument();
  });
});
