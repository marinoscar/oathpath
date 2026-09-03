/**
 * The mock interview screen (`/practice/interviews/:id`), issue #140,
 * epic #57 / E8.
 *
 * Driven through a stubbed `fetch` rather than MSW, for the reason
 * `ExplainPanel.test.tsx` gives: every interesting property of this screen is
 * about WHEN bytes arrive — the officer's words have to grow between two
 * `delta` frames, the terminal frame has to advance the interview, and the end
 * control has to be pressable in the middle of all of it. A handler that
 * resolves a whole body at once can demonstrate none of that.
 *
 * WHAT THESE TESTS PROTECT, in order of how quietly each would break:
 *
 *  1. **THE LOAD-BEARING ONE: no correct/incorrect signal appears anywhere
 *     before the interview is completed.** `docs/specs/mock-interview.md` §10
 *     states the failure this avoids: a learner who sees a green tick after
 *     each answer is not rehearsing the thing they are afraid of, because the
 *     real interview gives no per-question feedback either. It is checked
 *     against `container.innerHTML` as well as the accessible tree, and against
 *     the practice screens' OWN vocabulary — imported from
 *     `components/practice/outcome.ts` rather than retyped — so a later change
 *     that reached for `outcomeDisplay` to "just show the verdict" fails here
 *     rather than shipping.
 *  2. **Officer text renders incrementally**, and degrades to one complete
 *     message when it cannot stream.
 *  3. **`unavailable` is not an error.** The turn is rendered, the shared
 *     `AiNotReady` says AI is not set up here, and the interview continues.
 *  4. **The end control is reachable in every phase, including mid-stream**, is
 *     one tap, and completes the interview rather than discarding it.
 *  5. **Accessibility**: one `h1`, a real `<label>` on the answer box, and the
 *     officer's words in a POLITE live region — never assertive, which would
 *     interrupt a screen-reader user on every token.
 *  6. **Legible at 360px.**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { AuthContext } from '../../contexts/AuthContext';
import InterviewPage from '../../pages/InterviewPage';
import {
  gradingMethodNote,
  outcomeDisplay,
} from '../../components/practice/outcome';
import type { AiStatus, Interview, InterviewDetail, InterviewTurnRecord } from '../../types';

const INTERVIEW_ID = 'interview-1';
const PHONE = 360;
const encoder = new TextEncoder();

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

const OPENING_TURN: InterviewTurnRecord = {
  id: 'turn-1',
  turnIndex: 0,
  role: 'officer',
  phase: 'smalltalk',
  questionId: null,
  text: 'Good morning. How are you doing today?',
  createdAt: '2026-03-01T12:00:00.000Z',
};

/** What the officer says next, with the question read VERBATIM from the bank. */
const CIVICS_TURN: InterviewTurnRecord = {
  id: 'turn-3',
  turnIndex: 2,
  role: 'officer',
  phase: 'civics',
  questionId: 'question-9',
  text: 'Thank you. Let us continue.\n\nWhat is the supreme law of the land?',
  createdAt: '2026-03-01T12:02:00.000Z',
};

const OUTCOME = {
  officerTurns: [CIVICS_TURN],
  phase: 'civics',
  turnIndex: 2,
  progress: { civicsAsked: 0, civicsPlanned: 10 },
  awaitingCompletion: false,
};

let realFetch: typeof globalThis.fetch;
let streamController: ReadableStreamDefaultController<Uint8Array> | null;
let completeCalls: number;
let detail: InterviewDetail;
let aiStatus: AiStatus;

function stubFetch() {
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);

      if (url.includes('/ai/status')) return json(aiStatus);

      if (url.includes('/turns')) {
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
        return json({ civics: { planned: 10, asked: 1, correct: 1 } });
      }

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

const delta = (text: string) =>
  `event: delta\ndata: ${JSON.stringify({ text })}\n\n`;

function renderInterview({ mode = 'light' as 'light' | 'dark' } = {}) {
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
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter initialEntries={[`/practice/interviews/${INTERVIEW_ID}`]}>
          <AiStatusProvider>
            <Routes>
              <Route path="/practice/interviews/:id" element={<InterviewPage />} />
              <Route
                path="/practice/interviews/:id/debrief"
                element={<div>the debrief</div>}
              />
              <Route path="/practice" element={<div>Practice destination</div>} />
            </Routes>
          </AiStatusProvider>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/** Mount, and wait for the opening officer turn. */
async function mounted(options?: { mode?: 'light' | 'dark' }) {
  const rendered = renderInterview(options);
  await screen.findByText(/How are you doing today\?/);
  return rendered;
}

/** Answer the officer, and wait for the stream to open. */
async function answer(user: ReturnType<typeof userEvent.setup>, text: string) {
  const field = screen.getByLabelText(/your answer/i);
  if (text) await user.type(field, text);
  await user.click(screen.getByRole('button', { name: /^answer$/i }));
  await waitFor(() => expect(streamController).not.toBeNull());
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  streamController = null;
  completeCalls = 0;
  aiStatus = READY;
  detail = {
    interview: INTERVIEW,
    turns: [OPENING_TURN],
    progress: { civicsAsked: 0, civicsPlanned: 10 },
    awaitingCompletion: false,
    debrief: null,
  };
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setViewportWidth(1440);
});

// -----------------------------------------------------------------------------
// THE LOAD-BEARING ONE
// -----------------------------------------------------------------------------

/**
 * Every word the practice screens use to tell a learner how they did.
 *
 * Derived from `components/practice/outcome.ts` rather than retyped, so this
 * assertion tracks that file: if a later change adds a verdict word there and
 * renders it here, this test fails without anybody having to remember to
 * update a hardcoded list.
 */
const PRACTICE_VERDICT_VOCABULARY: string[] = [
  ...['correct', 'partial', 'incorrect', 'skipped', 'a-value-from-a-newer-server'].flatMap(
    (outcome) => {
      const display = outcomeDisplay(outcome);
      return [display.label, display.detail];
    },
  ),
  ...['self', 'ai'].map((method) => gradingMethodNote(method) ?? ''),
].filter(Boolean);

describe('InterviewPage — no verdict before the debrief', () => {
  it('shows no correct or incorrect signal anywhere before the interview is completed', async () => {
    const user = userEvent.setup();
    const { container } = await mounted();

    // Answer a question, and let the interview move on to the next one — the
    // exact moment a drill screen would show a tick.
    await answer(user, 'the Constitution');
    await emit(delta('Thank you. '));
    await emit(`event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`);
    await screen.findByText(/What is the supreme law of the land\?/);

    for (const word of PRACTICE_VERDICT_VOCABULARY) {
      // BOTH the accessible tree and the raw markup: a `display:none` node or a
      // stray attribute passes every `getByText` assertion while still being
      // readable with View Source or a screen reader's browse mode.
      expect(screen.queryByText(word)).toBeNull();
      expect(container.innerHTML).not.toContain(word);
    }

    // And no running score, in any of the shapes one could take.
    expect(container.textContent).not.toMatch(/\d+\s*(of|\/)\s*\d+\s*correct/i);
    expect(container.textContent).not.toMatch(/score/i);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('shows pacing without showing a score', async () => {
    // Explicitly allowed by §10, and explicitly the only counting on screen:
    // "6 of 10 asked" is a fact the real interview also gives an applicant.
    detail = {
      ...detail,
      turns: [OPENING_TURN, CIVICS_TURN],
      progress: { civicsAsked: 3, civicsPlanned: 10 },
    };
    await mounted();

    expect(screen.getByText('Question 4 of 10')).toBeInTheDocument();
    expect(screen.getByText(/Part 3 of 6 · Civics questions/)).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Streaming
// -----------------------------------------------------------------------------

describe('InterviewPage — the officer answers in pieces', () => {
  it('grows the officer’s words as frames arrive, then lands the whole turn', async () => {
    const user = userEvent.setup();
    const { container } = await mounted();

    await answer(user, 'I am well, thank you');

    await emit(delta('Thank you. '));
    await waitFor(() => expect(container.textContent).toContain('Thank you.'));
    const afterFirst = container.textContent?.length ?? 0;

    await emit(delta('Let us continue.'));
    await waitFor(() =>
      expect(container.textContent).toContain('Let us continue.'),
    );

    // THE ASSERTION THAT ONLY STREAMING PASSES: the screen held one frame's
    // worth of text and then held more, rather than appearing whole at the end.
    expect(container.textContent?.length ?? 0).toBeGreaterThan(afterFirst);
    // The opening `: connected` comment is not an event and never reaches the
    // page.
    expect(container.textContent).not.toContain('connected');

    await emit(`event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`);

    // The whole turn, including the question read verbatim from the database —
    // the acknowledgement is not rendered twice.
    expect(
      await screen.findByText(/What is the supreme law of the land\?/),
    ).toBeInTheDocument();
    expect(container.textContent?.match(/Let us continue\./g)).toHaveLength(1);
  });

  it('degrades to one complete message when nothing streams', async () => {
    const user = userEvent.setup();
    await mounted();

    await answer(user, 'I am well');
    // No deltas at all — the fallback line arrives whole on the terminal frame.
    await emit(`event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`);

    expect(
      await screen.findByText(/What is the supreme law of the land\?/),
    ).toBeInTheDocument();
  });

  it('accepts an empty answer rather than refusing it', async () => {
    const user = userEvent.setup();
    await mounted();

    await answer(user, '');
    await emit(`event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`);

    expect(
      await screen.findByText(/What is the supreme law of the land\?/),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// `unavailable`
// -----------------------------------------------------------------------------

describe('InterviewPage — AI not set up here', () => {
  it('renders the turn and `AiNotReady`, never an error, and carries on', async () => {
    aiStatus = NOT_READY;
    const user = userEvent.setup();
    await mounted();

    await answer(user, 'the Constitution');
    await emit(
      `event: unavailable\ndata: ${JSON.stringify({ ...OUTCOME, cause: 'role_unbound' })}\n\n`,
    );

    // THE TURN. The engine substituted a neutral officer line and proceeded
    // identically — dropping it would leave the screen on a question the server
    // has already moved past.
    expect(
      await screen.findByText(/What is the supreme law of the land\?/),
    ).toBeInTheDocument();

    // The SHARED component, and its one sentence.
    expect(
      await screen.findByText(/This is not a problem with your key/i),
    ).toBeInTheDocument();

    // NOT an error, in any of the shapes one could take.
    const alerts = screen.getAllByRole('alert');
    for (const alert of alerts) {
      expect(alert.className).not.toMatch(/colorError|standardError/);
    }

    // And the interview is still answerable.
    expect(screen.getByLabelText(/your answer/i)).toBeEnabled();
  });

  it('points a learner with no key of their own at the page that fixes it', async () => {
    const user = userEvent.setup();
    await mounted();

    await answer(user, 'the Constitution');
    await emit(
      `event: unavailable\ndata: ${JSON.stringify({ ...OUTCOME, cause: 'no_user_key' })}\n\n`,
    );

    // `AiNotReady`'s "nothing is wrong on your side" is NOT true of this cause,
    // so it gets its own message — the reasoning `ExplainPanel` states.
    expect(await screen.findByText(/Add your AI key/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add your key/i })).toHaveAttribute(
      'href',
      '/settings/ai',
    );
  });
});

// -----------------------------------------------------------------------------
// Ending it
// -----------------------------------------------------------------------------

describe('InterviewPage — ending the interview', () => {
  it('is reachable mid-stream, and completes rather than discarding', async () => {
    const user = userEvent.setup();
    await mounted();

    await answer(user, 'the Constitution');
    // MID-STREAM, deliberately: the moment somebody most wants out of a
    // rehearsal is the moment it is going badly.
    const end = screen.getByRole('button', { name: /end this interview/i });
    expect(end).toBeEnabled();

    await user.click(end);

    // COMPLETED, not abandoned — leaving still produces a real debrief.
    await waitFor(() => expect(completeCalls).toBe(1));
    // AND THE LEARNER IS TAKEN TO IT (#145). This used to land on `/practice`,
    // because `/practice/interviews/:id/debrief` was not mounted yet and
    // sending a learner to an unmounted route drops them on the catch-all
    // redirect to `/`. The route exists now, so the debrief is where ending an
    // interview goes — which is the whole point of ending it rather than
    // abandoning it.
    expect(await screen.findByText('the debrief')).toBeInTheDocument();
  });

  it('offers finishing in place of the answer box once nothing is left to answer', async () => {
    detail = { ...detail, awaitingCompletion: true };
    const user = userEvent.setup();
    await mounted();

    expect(screen.queryByLabelText(/your answer/i)).toBeNull();
    await user.click(
      screen.getByRole('button', { name: /finish and see how it went/i }),
    );

    await waitFor(() => expect(completeCalls).toBe(1));
  });

  it('keeps the learner in the interview when completing is refused', async () => {
    const user = userEvent.setup();
    await mounted();

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'That interview is abandoned' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof globalThis.fetch;

    await user.click(screen.getByRole('button', { name: /end this interview/i }));

    expect(await screen.findByText(/that interview is abandoned/i)).toBeInTheDocument();
    expect(screen.queryByText('the debrief')).toBeNull();
  });

  it('says plainly that a finished interview is finished, rather than redirecting', async () => {
    detail = {
      ...detail,
      interview: { ...INTERVIEW, status: 'completed', completedAt: '2026-03-01T12:20:00.000Z' },
    };
    renderInterview();

    expect(await screen.findByText(/This interview is finished/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/your answer/i)).toBeNull();
    // And the one thing the learner opening this URL is actually looking for
    // is one link away, at its own address (#145) rather than rendered here as
    // a second copy of the same result.
    expect(screen.getByRole('link', { name: /see how it went/i })).toHaveAttribute(
      'href',
      `/practice/interviews/${INTERVIEW_ID}/debrief`,
    );
  });
});

// -----------------------------------------------------------------------------
// Accessibility and width
// -----------------------------------------------------------------------------

describe('InterviewPage — accessibility and width', () => {
  it('has one h1 and a real label on the answer box', async () => {
    await mounted();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Mock interview');
    // Found BY ITS ACCESSIBLE NAME, which only a real `<label>` provides.
    expect(screen.getByLabelText(/your answer/i)).toBeInTheDocument();
  });

  it('announces the officer politely, and marks the region busy while streaming', async () => {
    const user = userEvent.setup();
    const { container } = await mounted();

    const region = container.querySelector('[aria-label="Interview transcript"]');
    expect(region).not.toBeNull();
    // POLITE, never assertive: officer text arrives token by token, and an
    // assertive region would interrupt the reader on every fragment.
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'false');

    await answer(user, 'the Constitution');
    await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'true'));

    await emit(`event: done\ndata: ${JSON.stringify(OUTCOME)}\n\n`);
    await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'false'));
  });

  it('renders at 360px and in the dark theme', async () => {
    setViewportWidth(PHONE);
    await mounted({ mode: 'dark' });

    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.getByText(/How are you doing today\?/)).toBeVisible();
    expect(screen.getByLabelText(/your answer/i)).toBeVisible();
    expect(
      screen.getByRole('button', { name: /end this interview/i }),
    ).toBeVisible();
  });
});
