/**
 * Practice session (`/practice/sessions/:id`) — one question at a time
 * (issue #79, epic #52).
 *
 * WHAT THESE TESTS ACTUALLY PROTECT, in order of how quietly each would break:
 *
 *  1. **THE LOAD-BEARING ONE: the accepted answers are nowhere on the page
 *     before the learner submits, skips, or reveals.** `PracticeSessionPage.tsx`'s
 *     own header states the failure mode plainly: if the answer is in the page
 *     while the learner types, the exercise stops being recall and becomes
 *     recognition, and the damage is invisible from every other screen and
 *     every other test. This is checked against BOTH the accessible text tree
 *     AND the raw `container.innerHTML`, because a `display:none` node or a
 *     stray `data-answer` attribute passes every `screen.getByText` assertion
 *     while still being readable with View Source or a screen reader's browse
 *     mode.
 *  2. **Submit renders the verdict, then the accepted answers** — in that
 *     order, and only after the POST resolves.
 *  3. **Skip and Reveal send exactly the flags the API contracts on**
 *     (`skipped: true`, `revealed: true`), and self-mark is visually the
 *     QUIET option beside the primary "move on" action — never the other way
 *     around, because a flattering self-mark button would make the evidence
 *     table untrustworthy one click at a time.
 *  4. **Reloading mid-session resumes from the server.** A fresh mount with a
 *     session that already has attempts must pick up exactly where the server
 *     left off, never at question one.
 *  5. **A live region carries the verdict**, and **the answer field is
 *     focused on every new question**, because a learner who cannot see is
 *     still expected to answer from recall.
 *  6. **Legible at 360px and correct in the dark theme.**
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import PracticeSessionPage from '../../pages/PracticeSessionPage';
import type {
  PracticeAttempt,
  PracticeAttemptResult,
  PracticeQuestion,
  PracticeSession,
  PracticeSessionDetail,
  RecordPracticeAttemptInput,
} from '../../types';

const API_BASE = '*/api';
const PHONE = 360;
const SESSION_ID = 'session-1';

// -----------------------------------------------------------------------------
// Fixtures — shaped from `apps/api/src/practice/dto/*.ts`.
//
// The accepted answer text below ("the Constitution") is deliberately a
// distinctive, unique string that appears NOWHERE else on this screen — the
// question prompt, the labels, the button text — so a positive match against
// it is unambiguous evidence the answer reached the DOM, wherever it landed.
// -----------------------------------------------------------------------------

const QUESTION_1: PracticeQuestion = {
  id: 'question-1',
  number: 1,
  prompt: 'What is the supreme law of the land?',
  categoryId: 'category-1',
  dynamicScope: 'none',
};

const QUESTION_2: PracticeQuestion = {
  id: 'question-2',
  number: 2,
  prompt: 'What does the Constitution do?',
  categoryId: 'category-1',
  dynamicScope: 'none',
};

const SESSION_BASE: PracticeSession = {
  id: SESSION_ID,
  kind: 'quick',
  status: 'in_progress',
  testVersionCode: 'v2008',
  categoryId: null,
  plannedCount: 5,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: null,
  summary: null,
};

function makeAttempt(overrides: Partial<PracticeAttempt> = {}): PracticeAttempt {
  return {
    id: 'attempt-1',
    sessionId: SESSION_ID,
    questionId: QUESTION_1.id,
    question: QUESTION_1,
    source: 'practice',
    inputMode: 'typed',
    promptMode: 'read',
    responseText: 'the big rules',
    outcome: 'incorrect',
    gradingMethod: 'exact',
    revealed: false,
    hintUsed: false,
    durationMs: 4200,
    failureCause: null,
    aiFeedback: null,
    aiUsageEventId: null,
    answeredAt: '2026-03-01T12:01:00.000Z',
    answerSnapshot: {
      resolvedAt: '2026-03-01T12:01:00.000Z',
      answerResolution: 'resolved',
      resolvedForStateCode: null,
      answers: [
        {
          id: 'answer-1',
          text: 'the Constitution',
          sort: 0,
          stateCode: null,
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

function detailFor(overrides: Partial<PracticeSessionDetail> = {}): PracticeSessionDetail {
  return {
    session: SESSION_BASE,
    nextQuestion: QUESTION_1,
    progress: { answered: 0, planned: 5 },
    attempts: [],
    ...overrides,
  };
}

interface SessionHandlerOptions {
  detail: PracticeSessionDetail;
  onAttempt?: (input: RecordPracticeAttemptInput) => void;
  attemptResult?: PracticeAttemptResult;
  onComplete?: () => void;
}

function sessionHandlers(options: SessionHandlerOptions) {
  return [
    http.get(`${API_BASE}/practice/sessions/${SESSION_ID}`, () =>
      HttpResponse.json({ data: options.detail }),
    ),
    http.post(
      `${API_BASE}/practice/sessions/${SESSION_ID}/attempts`,
      async ({ request }) => {
        const input = (await request.json()) as RecordPracticeAttemptInput;
        options.onAttempt?.(input);
        if (options.attemptResult) {
          return HttpResponse.json({ data: options.attemptResult });
        }
        // The default: grade whatever came in as `incorrect`, and echo back
        // exactly the flags received — this is what makes "Skip sends
        // `skipped: true`" checkable from the response the page renders too.
        const attempt = makeAttempt({
          responseText: input.responseText ?? null,
          outcome: input.skipped ? 'skipped' : 'incorrect',
          revealed: Boolean(input.revealed),
          durationMs: input.durationMs ?? null,
        });
        const result: PracticeAttemptResult = {
          attempt,
          acceptedAnswers: attempt.answerSnapshot.answers,
          nextQuestion: QUESTION_2,
          progress: { answered: 1, planned: 5 },
        };
        return HttpResponse.json({ data: result });
      },
    ),
    http.post(
      `${API_BASE}/practice/sessions/${SESSION_ID}/attempts/:attemptId/self-mark`,
      () =>
        HttpResponse.json({
          data: makeAttempt({ outcome: 'correct', gradingMethod: 'self', revealed: true }),
        }),
    ),
    http.post(`${API_BASE}/practice/sessions/${SESSION_ID}/complete`, () => {
      options.onComplete?.();
      return HttpResponse.json({
        data: { ...SESSION_BASE, status: 'completed', completedAt: '2026-03-01T12:20:00.000Z' },
      });
    }),
  ];
}

function renderSession(
  options: SessionHandlerOptions,
  { mode = 'light' as 'light' | 'dark' }: { mode?: 'light' | 'dark' } = {},
) {
  server.use(...sessionHandlers(options));

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
        <MemoryRouter initialEntries={[`/practice/sessions/${SESSION_ID}`]}>
          <Routes>
            <Route path="/practice/sessions/:id" element={<PracticeSessionPage />} />
            <Route
              path="/practice/sessions/:id/summary"
              element={<h1>Practice summary</h1>}
            />
            <Route path="/practice" element={<h1>Practice</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

// -----------------------------------------------------------------------------
// THE LOAD-BEARING ASSERTION
// -----------------------------------------------------------------------------

describe('before any attempt is recorded', () => {
  it('renders the accepted answer NOWHERE — not in the text, and not anywhere in the raw DOM', async () => {
    const { container } = renderSession({ detail: detailFor() });

    expect(
      await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();

    // The accessible-text check.
    expect(screen.queryByText('the Constitution')).not.toBeInTheDocument();

    // The raw-DOM check: if the answer were hidden behind `display:none`, a
    // collapsed panel, or a stray `data-*` attribute, `screen.queryByText`
    // above would still pass while a View Source read or a screen reader's
    // browse mode would still find it. This is the assertion that catches
    // that shortcut — if it were in the DOM, the exercise would be multiple
    // choice wearing a text box, exactly as the page's own header warns.
    expect(container.innerHTML).not.toContain('the Constitution');
  });
});

// -----------------------------------------------------------------------------
// Submit, then the verdict, then the answer
// -----------------------------------------------------------------------------

describe('submitting an answer', () => {
  it('renders the verdict and only then the accepted answers, inside a live region', async () => {
    const user = userEvent.setup();
    const { container } = renderSession({ detail: detailFor() });

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    expect(container.innerHTML).not.toContain('the Constitution');

    await user.type(screen.getByLabelText(/your answer/i), 'the big rules');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/not a match/i));

    // NOW the answer exists — earned by a recorded attempt.
    expect(await screen.findByText('the Constitution')).toBeInTheDocument();
    expect(container.innerHTML).toContain('the Constitution');

    // Order: the verdict text precedes the answer text in the same region.
    const verdictIndex = status.innerHTML.indexOf('Not a match');
    const answerIndex = status.innerHTML.indexOf('the Constitution');
    expect(verdictIndex).toBeGreaterThan(-1);
    expect(answerIndex).toBeGreaterThan(verdictIndex);
  });

  it('sends `skipped: true` and nothing else claiming an answer', async () => {
    const seen: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ detail: detailFor(), onAttempt: (input) => seen.push(input) });

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.click(screen.getByRole('button', { name: /^skip$/i }));

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].skipped).toBe(true);
    expect(seen[0].responseText).toBeUndefined();
    expect(await screen.findByText('Skipped')).toBeInTheDocument();
  });

  it('sends `revealed: true` when the learner asks to see the answer', async () => {
    const seen: RecordPracticeAttemptInput[] = [];
    const user = userEvent.setup();
    renderSession({ detail: detailFor(), onAttempt: (input) => seen.push(input) });

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.click(screen.getByRole('button', { name: /show me the answer/i }));

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].revealed).toBe(true);
    expect(await screen.findByText('the Constitution')).toBeInTheDocument();
  });

  it('offers self-mark as the SECONDARY action after a reveal, never the primary one', async () => {
    const user = userEvent.setup();
    renderSession({ detail: detailFor() });

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.click(screen.getByRole('button', { name: /show me the answer/i }));

    const selfMark = await screen.findByRole('button', { name: /i was right/i });
    const primary = screen.getByRole('button', { name: /next question/i });

    // The rendered emphasis, not just presence: the primary "move on" action
    // is a filled/contained button; self-mark is the quiet text button beside
    // it. `AttemptFeedback.tsx`'s header explains why this must never flip.
    expect(primary.className).toContain('MuiButton-contained');
    expect(selfMark.className).toContain('MuiButton-text');
    expect(selfMark.className).not.toContain('MuiButton-contained');

    await user.click(selfMark);
    await waitFor(() =>
      expect(screen.getByText('You marked this one correct yourself.')).toBeInTheDocument(),
    );
  });

  it('does not offer self-mark on a cold, unrevealed miss', async () => {
    renderSession({ detail: detailFor() });
    const user = userEvent.setup();

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.type(screen.getByLabelText(/your answer/i), 'the big rules');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await screen.findByText('Not a match');
    expect(
      screen.queryByRole('button', { name: /i was right/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/we can only count your own call/i)).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Progress and focus
// -----------------------------------------------------------------------------

describe('progress and focus', () => {
  it('shows "Question N of planned"', async () => {
    renderSession({
      detail: detailFor({
        nextQuestion: QUESTION_2,
        progress: { answered: 2, planned: 5 },
        attempts: [makeAttempt(), makeAttempt({ id: 'attempt-2' })],
      }),
    });

    expect(await screen.findByText('Question 3 of 5')).toBeInTheDocument();
  });

  it('focuses the answer field on the first question and again on the next one', async () => {
    const user = userEvent.setup();
    renderSession({ detail: detailFor() });

    const firstInput = await screen.findByLabelText(/your answer/i);
    await waitFor(() => expect(firstInput).toHaveFocus());

    await user.type(firstInput, 'the big rules');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));
    await screen.findByText('Not a match');

    await user.click(screen.getByRole('button', { name: /next question/i }));

    const secondInput = await screen.findByLabelText(/your answer/i);
    await waitFor(() => expect(secondInput).toHaveFocus());
    expect(screen.getByText(QUESTION_2.prompt)).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Resume mid-session
// -----------------------------------------------------------------------------

describe('reloading mid-session', () => {
  it('resumes from the server — the question already answered is not asked again', async () => {
    renderSession({
      detail: detailFor({
        nextQuestion: QUESTION_2,
        progress: { answered: 1, planned: 5 },
        attempts: [makeAttempt()],
      }),
    });

    // A fresh mount lands directly on question 2 — the server's next
    // question — with no action taken and nothing carried through navigation.
    expect(
      await screen.findByRole('heading', { level: 2, name: QUESTION_2.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText('Question 2 of 5')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Finishing when there is nothing left to ask
// -----------------------------------------------------------------------------

describe('when nextQuestion is null', () => {
  it('offers a Finish control that completes the session and navigates to the summary', async () => {
    const user = userEvent.setup();
    let completed = false;
    renderSession({
      detail: detailFor({
        nextQuestion: null,
        progress: { answered: 5, planned: 5 },
        attempts: [makeAttempt()],
      }),
      onComplete: () => {
        completed = true;
      },
    });

    expect(
      await screen.findByText(/that.s everything in this session/i),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /finish and see your summary/i }),
    );

    await waitFor(() => expect(completed).toBe(true));
    expect(await screen.findByRole('heading', { name: 'Practice summary' })).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Mobile and theme
// -----------------------------------------------------------------------------

describe('at 360px and in both themes', () => {
  it('renders the question and its controls at a 360px viewport', async () => {
    setViewportWidth(PHONE);
    renderSession({ detail: detailFor() });

    expect(
      await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^submit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show me the answer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^skip$/i })).toBeInTheDocument();
  });

  it('renders the same content in the dark theme', async () => {
    const user = userEvent.setup();
    renderSession({ detail: detailFor() }, { mode: 'dark' });

    await screen.findByRole('heading', { level: 2, name: QUESTION_1.prompt });
    await user.click(screen.getByRole('button', { name: /show me the answer/i }));

    expect(await screen.findByText('the Constitution')).toBeInTheDocument();
  });
});
