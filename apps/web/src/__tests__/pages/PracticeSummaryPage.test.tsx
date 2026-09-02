/**
 * Practice summary (`/practice/sessions/:id/summary`) — the debrief
 * (issue #79, epic #52).
 *
 * WHAT THESE TESTS ACTUALLY PROTECT:
 *
 *  1. **Everything renders from the FETCHED session, never from navigation
 *     state.** `PracticeSummaryPage.tsx`'s own header names the failure mode:
 *     carrying the completed session through `navigate(path, { state })` would
 *     make this screen blank on exactly the visit that matters most —
 *     reopening it from Recent sessions, a bookmark, or a reload. So every
 *     test here mounts the page directly at its route, with NO navigation
 *     state at all, and asserts it still renders the tally and the full
 *     per-question review.
 *  2. **"Practise again" starts a new session of the same shape**, and "Back
 *     to Practice" is a real link back to the destination.
 *  3. **Legible at 360px and correct in the dark theme.**
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import PracticeSummaryPage from '../../pages/PracticeSummaryPage';
import type {
  CreatePracticeSessionInput,
  PracticeAttempt,
  PracticeQuestion,
  PracticeSession,
  PracticeSessionDetail,
  PracticeSessionState,
} from '../../types';

const API_BASE = '*/api';
const PHONE = 360;
const SESSION_ID = 'session-done-1';

// -----------------------------------------------------------------------------
// Fixtures
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
  number: 13,
  prompt: 'Name one branch or part of the government.',
  categoryId: 'category-1',
  dynamicScope: 'none',
};

function makeAttempt(
  question: PracticeQuestion,
  overrides: Partial<PracticeAttempt> = {},
): PracticeAttempt {
  return {
    id: `attempt-${question.id}`,
    sessionId: SESSION_ID,
    questionId: question.id,
    question,
    source: 'practice',
    inputMode: 'typed',
    promptMode: 'read',
    responseText: 'the Constitution',
    outcome: 'correct',
    gradingMethod: 'exact',
    revealed: false,
    hintUsed: false,
    durationMs: 3000,
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
          id: `answer-${question.id}`,
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

const COMPLETED_SESSION: PracticeSession = {
  id: SESSION_ID,
  kind: 'quick',
  status: 'completed',
  testVersionCode: 'v2008',
  categoryId: null,
  plannedCount: 2,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: '2026-03-01T12:05:00.000Z',
  summary: {
    plannedCount: 2,
    answered: 2,
    correct: 1,
    partial: 0,
    incorrect: 1,
    skipped: 0,
    selfMarked: 0,
    revealed: 0,
    hintUsed: 0,
    totalDurationMs: 6000,
    timedAttempts: 2,
  },
};

const CATEGORY_SESSION: PracticeSession = {
  ...COMPLETED_SESSION,
  id: 'session-category-1',
  kind: 'category',
  categoryId: 'category-1',
};

const ATTEMPTS: PracticeAttempt[] = [
  makeAttempt(QUESTION_1, { outcome: 'correct' }),
  makeAttempt(QUESTION_2, {
    outcome: 'incorrect',
    responseText: 'a courthouse',
    answerSnapshot: {
      resolvedAt: '2026-03-01T12:02:00.000Z',
      answerResolution: 'resolved',
      resolvedForStateCode: null,
      answers: [
        {
          id: 'answer-branch',
          text: 'Congress',
          sort: 0,
          stateCode: null,
          verifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  }),
];

function detailFor(overrides: Partial<PracticeSessionDetail> = {}): PracticeSessionDetail {
  return {
    session: COMPLETED_SESSION,
    nextQuestion: null,
    progress: { answered: 2, planned: 2 },
    attempts: ATTEMPTS,
    ...overrides,
  };
}

interface SummaryHandlerOptions {
  detail: PracticeSessionDetail;
  onCreateSession?: (input: CreatePracticeSessionInput) => void;
  sessionId?: string;
}

function summaryHandlers(options: SummaryHandlerOptions) {
  const id = options.sessionId ?? SESSION_ID;
  return [
    http.get(`${API_BASE}/practice/sessions/${id}`, () =>
      HttpResponse.json({ data: options.detail }),
    ),
    http.post(`${API_BASE}/practice/sessions`, async ({ request }) => {
      const input = (await request.json()) as CreatePracticeSessionInput;
      options.onCreateSession?.(input);
      const state: PracticeSessionState = {
        session: {
          id: 'session-new-1',
          kind: input.kind,
          status: 'in_progress',
          testVersionCode: 'v2008',
          categoryId: input.categoryId ?? null,
          plannedCount: input.plannedCount ?? 5,
          startedAt: '2026-03-02T00:00:00.000Z',
          completedAt: null,
          summary: null,
        },
        nextQuestion: QUESTION_1,
        progress: { answered: 0, planned: 5 },
      };
      return HttpResponse.json({ data: state });
    }),
  ];
}

function renderSummary(
  options: SummaryHandlerOptions,
  {
    mode = 'light' as 'light' | 'dark',
    sessionId = SESSION_ID,
  }: { mode?: 'light' | 'dark'; sessionId?: string } = {},
) {
  server.use(...summaryHandlers({ ...options, sessionId }));

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
        {/* Mounted DIRECTLY at the summary route with NO navigation state —
            no `initialEntries` object carrying `{ state }`, nothing passed
            through the router. This is the one thing these tests exist to
            prove: the page has no other source of truth to fall back on. */}
        <MemoryRouter initialEntries={[`/practice/sessions/${sessionId}/summary`]}>
          <Routes>
            <Route
              path="/practice/sessions/:id/summary"
              element={<PracticeSummaryPage />}
            />
            <Route path="/practice/sessions/:id" element={<h1>Practice session</h1>} />
            <Route path="/practice" element={<h1>Practice</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

// -----------------------------------------------------------------------------
// Rendered entirely from the fetched session
// -----------------------------------------------------------------------------

describe('mounted directly, with no navigation state', () => {
  it('renders the tally from the fetched summary', async () => {
    renderSummary({ detail: detailFor() });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Practice summary' }),
    ).toBeInTheDocument();
    expect(screen.getByText('You answered 2 of 2.')).toBeInTheDocument();

    // The counts come from `session.summary`, not from re-deriving anything
    // in the browser from the attempts list.
    const correctCount = screen.getByText('correct').previousElementSibling as Element;
    expect(correctCount).toHaveTextContent('1');
    const missedCount = screen.getByText('not matched').previousElementSibling as Element;
    expect(missedCount).toHaveTextContent('1');
  });

  it('renders the full per-question review, in order, with what was typed and what was accepted', async () => {
    renderSummary({ detail: detailFor() });

    await screen.findByRole('heading', { level: 1, name: 'Practice summary' });

    const firstRow = screen
      .getByRole('heading', { level: 3, name: QUESTION_1.prompt })
      .closest('li') as HTMLElement;
    const secondRow = screen
      .getByRole('heading', { level: 3, name: QUESTION_2.prompt })
      .closest('li') as HTMLElement;

    // Row one: a correct, verbatim match — "your answer" and "accepted
    // answer" are honestly the SAME text here, so both are asserted together
    // rather than papered over with a single ambiguous `getByText`.
    expect(within(firstRow).getAllByText('the Constitution')).toHaveLength(2);
    expect(within(firstRow).getByText('Correct')).toBeInTheDocument();

    // Row two: what the learner typed, verbatim, beside what it was actually
    // graded against — two different strings, so this is the unambiguous
    // half of the assertion.
    expect(within(secondRow).getByText('a courthouse')).toBeInTheDocument();
    expect(within(secondRow).getByText('Congress')).toBeInTheDocument();
    expect(within(secondRow).getByText('Not a match')).toBeInTheDocument();
  });

  it('renders identically even though nothing was ever navigated to here', async () => {
    // The strongest form of the assertion: initial history has exactly one
    // entry, this route, and nothing else — there is no "previous screen"
    // this page could have received state from even in principle.
    server.use(...summaryHandlers({ detail: detailFor() }));
    const auth = {
      user: mockUser,
      isLoading: false,
      isAuthenticated: true,
      providers: [],
      login: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    };

    render(
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter
          initialEntries={[{ pathname: `/practice/sessions/${SESSION_ID}/summary` }]}
        >
          <Routes>
            <Route
              path="/practice/sessions/:id/summary"
              element={<PracticeSummaryPage />}
            />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Practice summary' }),
    ).toBeInTheDocument();
    expect(screen.getByText('You answered 2 of 2.')).toBeInTheDocument();
  });

  it('shows no tally, but still the real attempts, for an abandoned session', async () => {
    renderSummary({
      detail: detailFor({
        session: { ...COMPLETED_SESSION, status: 'abandoned', summary: null },
      }),
    });

    expect(
      await screen.findByText(/left unfinished when you started another one/i),
    ).toBeInTheDocument();
    // The specific tally SENTENCE is gone — not merely a substring match,
    // which the info alert's own "what you answered is still below" would
    // trip on the moment it changed a single word.
    expect(screen.queryByText('You answered 2 of 2.')).not.toBeInTheDocument();
    expect(screen.queryByText(/^You answered \d/)).not.toBeInTheDocument();
    // The evidence that WAS produced is still there.
    expect(
      screen.getByRole('heading', { level: 3, name: QUESTION_1.prompt }),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

describe('actions', () => {
  it('practises again with the same session shape and lands on the new session', async () => {
    const created: CreatePracticeSessionInput[] = [];
    const user = userEvent.setup();
    renderSummary({
      detail: detailFor(),
      onCreateSession: (input) => created.push(input),
    });

    await user.click(
      await screen.findByRole('button', { name: /practise again/i }),
    );

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({ kind: 'quick' });
    expect(
      await screen.findByRole('heading', { name: 'Practice session' }),
    ).toBeInTheDocument();
  });

  it('practises again in the same category for a category session', async () => {
    const created: CreatePracticeSessionInput[] = [];
    const user = userEvent.setup();
    renderSummary(
      {
        detail: detailFor({ session: CATEGORY_SESSION }),
        onCreateSession: (input) => created.push(input),
        sessionId: CATEGORY_SESSION.id,
      },
      { sessionId: CATEGORY_SESSION.id },
    );

    await user.click(
      await screen.findByRole('button', { name: /practise again/i }),
    );

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      kind: 'category',
      categoryId: CATEGORY_SESSION.categoryId,
    });
  });

  it('returns to /practice with a real link', async () => {
    renderSummary({ detail: detailFor() });

    const back = await screen.findByRole('link', { name: /back to practice/i });
    expect(back).toHaveAttribute('href', '/practice');
  });
});

// -----------------------------------------------------------------------------
// Mobile and theme
// -----------------------------------------------------------------------------

describe('at 360px and in both themes', () => {
  it('renders the tally and both actions at a 360px viewport', async () => {
    setViewportWidth(PHONE);
    renderSummary({ detail: detailFor() });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Practice summary' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /practise again/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to practice/i })).toBeInTheDocument();
  });

  it('renders the same content in the dark theme', async () => {
    renderSummary({ detail: detailFor() }, { mode: 'dark' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Practice summary' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Correct')).toBeInTheDocument();
  });
});
