/**
 * Practice (`/practice`) — the real destination (issue #76, epic #52).
 *
 * WHAT THESE TESTS ACTUALLY PROTECT, in order of how quietly each would break:
 *
 *  1. **Quick 5 is one click, not a form.** The acceptance criterion names it
 *     directly: one press posts `{ kind: 'quick' }` and lands on the session
 *     screen. A regression that inserted a confirmation step or a count picker
 *     would still "work" by every other measure on this page.
 *  2. **Categories start a `category` session, by id, in the server's order.**
 *     Never sorted locally — `PracticePage.tsx`'s own header explains why a
 *     well-meant `localeCompare` here would renumber the exam.
 *  3. **An empty history renders an honest sentence, never a fabricated zero.**
 *     `journey-shell.md` §10's rule: a learner with no attempts must see
 *     nothing that could be mistaken for a real measurement — no "0 correct",
 *     no percentage, no ring, no bar. That is only checkable by asserting the
 *     ABSENCE of those shapes, not just the presence of the empty sentence.
 *  4. **Loading, empty and failed stay three different screens.** A failed
 *     fetch must never render as a blank page or as a quiet "you have no
 *     history" — `usePracticeSessions`'s header names this explicitly.
 *  5. **The mock interview is reachable from here (#145, epic #57 / E8)**, as
 *     its own band, and its copy says what the thing IS before a learner
 *     commits twenty minutes to it: longer than five questions, and no feedback
 *     until the end. `docs/specs/mock-interview.md` §10's reason reaches one
 *     screen back — a learner who was not told there is no per-question signal
 *     reads its absence as the product being broken.
 *  6. **Legible at 360px and correct in the dark theme**, because this is a
 *     screen a learner opens from Home's one recommendation, most often on a
 *     phone.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import { LearnerProfileProvider } from '../../contexts/LearnerProfileContext';
import PracticePage from '../../pages/PracticePage';
import { ORIENTED_PROFILE, UNORIENTED_PROFILE } from '../utils/journey-fixtures';
import {
  CATEGORIES,
  CATEGORY_DEMOCRACY,
  civicsHandlers,
  journeyProfileHandler,
} from '../utils/civics-fixtures';
import type {
  CreatePracticeSessionInput,
  JourneyProfile,
  PracticeQueue,
  PracticeSessionListItem,
  PracticeSessionState,
} from '../../types';

const API_BASE = '*/api';
const PHONE = 360;

// -----------------------------------------------------------------------------
// Session fixtures — shaped from `apps/api/src/practice/dto/*.ts`, the same
// discipline `civics-fixtures.ts` and `journey-fixtures.ts` already follow.
// -----------------------------------------------------------------------------

const COMPLETED_SESSION: PracticeSessionListItem = {
  id: 'session-completed-1',
  kind: 'quick',
  status: 'completed',
  testVersionCode: 'v2008',
  categoryId: null,
  plannedCount: 5,
  startedAt: '2026-03-01T12:00:00.000Z',
  completedAt: '2026-03-01T12:10:00.000Z',
  summary: {
    plannedCount: 5,
    answered: 5,
    correct: 4,
    partial: 0,
    incorrect: 1,
    skipped: 0,
    selfMarked: 0,
    revealed: 0,
    hintUsed: 0,
    totalDurationMs: 60000,
    timedAttempts: 5,
  },
  answeredCount: 5,
  correctCount: 4,
};

const IN_PROGRESS_SESSION: PracticeSessionListItem = {
  id: 'session-in-progress-1',
  kind: 'category',
  status: 'in_progress',
  testVersionCode: 'v2008',
  categoryId: CATEGORY_DEMOCRACY.id,
  plannedCount: 5,
  startedAt: '2026-03-02T09:00:00.000Z',
  completedAt: null,
  summary: null,
  answeredCount: 2,
  correctCount: 1,
};

function sessionStartResponse(
  input: CreatePracticeSessionInput,
): PracticeSessionState {
  return {
    session: {
      id: `session-started-${input.kind}`,
      kind: input.kind,
      status: 'in_progress',
      testVersionCode: 'v2008',
      categoryId: input.categoryId ?? null,
      plannedCount: input.plannedCount ?? 5,
      startedAt: '2026-03-03T00:00:00.000Z',
      completedAt: null,
      summary: null,
    },
    nextQuestion: {
      id: 'question-first',
      number: 1,
      prompt: 'What is the supreme law of the land?',
      categoryId: input.categoryId ?? CATEGORIES[0].id,
      dynamicScope: 'none',
    },
    progress: { answered: 0, planned: input.plannedCount ?? 5 },
  };
}

/**
 * A brand-new learner's queue: everything is `new`, nothing is due, weak, or
 * mastered yet. The default so that a test exercising Quick 5, categories or
 * recent sessions — none of which is ABOUT the queue band — is not also
 * silently exercising its error state, the way `onUnhandledRequest: 'warn'`
 * would otherwise make it: an un-mocked `GET /api/practice/queue` fails
 * outright (there is no real server here), so every test that omits this
 * handler would see a second, unrelated "Try again" button appear.
 */
const DEFAULT_QUEUE: PracticeQueue = {
  testVersionCode: 'v2008',
  total: CATEGORIES.length * 10,
  due: 0,
  weak: 0,
  new: {
    total: CATEGORIES.length * 10,
    byCategory: CATEGORIES.map((category) => ({
      categoryId: category.id,
      categoryName: category.name,
      newCount: 10,
    })),
  },
  learning: 0,
  mastered: 0,
};

interface PracticeHandlerOptions {
  sessions?: PracticeSessionListItem[];
  sessionsStatus?: number;
  queue?: PracticeQueue;
  queueStatus?: number;
  onCreateSession?: (input: CreatePracticeSessionInput) => void;
}

function practiceHandlers(options: PracticeHandlerOptions = {}) {
  const sessions = options.sessions ?? [];
  const queue = options.queue ?? DEFAULT_QUEUE;

  return [
    http.get(`${API_BASE}/practice/sessions`, () => {
      if (options.sessionsStatus && options.sessionsStatus >= 400) {
        return HttpResponse.json(
          { message: 'Your recent practice could not be loaded.' },
          { status: options.sessionsStatus },
        );
      }
      return HttpResponse.json({
        data: {
          items: sessions,
          total: sessions.length,
          page: 1,
          pageSize: 5,
          totalPages: 1,
        },
      });
    }),

    http.post(`${API_BASE}/practice/sessions`, async ({ request }) => {
      const input = (await request.json()) as CreatePracticeSessionInput;
      options.onCreateSession?.(input);
      return HttpResponse.json({ data: sessionStartResponse(input) });
    }),

    http.get(`${API_BASE}/practice/queue`, () => {
      if (options.queueStatus && options.queueStatus >= 400) {
        return HttpResponse.json(
          { message: 'Your practice queue could not be loaded.' },
          { status: options.queueStatus },
        );
      }
      return HttpResponse.json({ data: queue });
    }),
  ];
}

/**
 * Reads the ACTUAL react-router param, never the mocked global `window.location`
 * `setup.ts` freezes — that mock's `pathname` never changes on navigation, so a
 * stub built from it would report "navigated" even when nothing moved.
 */
function SessionStub() {
  const { id } = useParams<{ id: string }>();
  return <h1>Practice session {id}</h1>;
}

function renderPractice(
  {
    profile = ORIENTED_PROFILE,
    mode = 'light' as 'light' | 'dark',
  }: { profile?: JourneyProfile; mode?: 'light' | 'dark' } = {},
) {
  server.use(journeyProfileHandler(profile));

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
        <MemoryRouter initialEntries={['/practice']}>
          <Routes>
            {/* A layout route, exactly as `App.tsx` mounts it — see
                `LearnPage.test.tsx` for why that matters for "fetched once". */}
            <Route element={<LearnerProfileProvider />}>
              <Route path="/practice" element={<PracticePage />} />
              <Route path="/practice/sessions/:id" element={<SessionStub />} />
              <Route
                path="/practice/interviews"
                element={<h1>Mock interview</h1>}
              />
              <Route path="/settings/journey" element={<h1>Your plan</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  server.use(...civicsHandlers());
});

// -----------------------------------------------------------------------------
// Quick 5 — one click, one request, one navigation
// -----------------------------------------------------------------------------

describe('Quick 5', () => {
  it('starts a session with one click and lands on the session screen', async () => {
    const created: CreatePracticeSessionInput[] = [];
    server.use(
      ...practiceHandlers({
        sessions: [],
        onCreateSession: (input) => created.push(input),
      }),
    );
    const user = userEvent.setup();
    renderPractice();

    await user.click(await screen.findByRole('button', { name: /start a quick 5/i }));

    // The request body: `kind: 'quick'` and NOTHING that picks a count or a
    // difficulty — this is the one-click acceptance criterion, not "a form
    // that defaults sensibly".
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({ kind: 'quick' });

    // And the navigation — to the started session's own id.
    expect(
      await screen.findByRole('heading', {
        name: 'Practice session session-started-quick',
      }),
    ).toBeInTheDocument();
  });

  it('disables the category list too while a start is in flight, not just the button already pressed', async () => {
    server.use(
      http.post(`${API_BASE}/practice/sessions`, async ({ request }) => {
        await delay(50);
        const input = (await request.json()) as CreatePracticeSessionInput;
        return HttpResponse.json({ data: sessionStartResponse(input) });
      }),
      ...practiceHandlers({ sessions: [] }),
    );
    const user = userEvent.setup();
    renderPractice();

    const categoryButton = await screen.findByRole('button', {
      name: new RegExp(CATEGORY_DEMOCRACY.name),
    });
    const quickButton = screen.getByRole('button', { name: /start a quick 5/i });
    await user.click(quickButton);

    expect(screen.getByText(/starting…/i)).toBeInTheDocument();
    // `starting !== null` disables the WHOLE page's starters, not only the one
    // already pressed. MUI's `ListItemButton` renders as a `<div
    // role="button">` here (no `href`), so the DISABLED signal is
    // `aria-disabled`, not the native `disabled` attribute — and the
    // `pointer-events: none` `userEvent` itself refuses below is the real,
    // load-bearing effect of that state, not merely a visual dimming.
    expect(categoryButton).toHaveAttribute('aria-disabled', 'true');
    await expect(user.click(categoryButton)).rejects.toThrow(/pointer-events/i);
  });

  // ---------------------------------------------------------------------
  // Quick 5's copy and icon bias toward review — same `due + weak` gate
  // `PracticeQueueSummary`'s own headline uses, still posting `kind: 'quick'`
  // unchanged (there is no wired `review` session kind to request — see this
  // page's header).
  // ---------------------------------------------------------------------

  it('biases Quick 5 toward review when the queue has due-or-weak evidence', async () => {
    server.use(
      ...practiceHandlers({
        sessions: [],
        queue: { ...DEFAULT_QUEUE, due: 3, weak: 2 },
      }),
    );
    renderPractice();

    expect(
      await screen.findByRole('button', { name: /review now/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('AutorenewOutlinedIcon')).toBeInTheDocument();
    expect(
      screen.getByText(/due and struggling ones first.*you have 5 of those waiting/i),
    ).toBeInTheDocument();
    // Neither the default label nor its icon is left rendered alongside it.
    expect(
      screen.queryByRole('button', { name: /start a quick 5/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('BoltIcon')).not.toBeInTheDocument();
  });

  it('keeps the default Quick 5 copy and icon when nothing is due or weak', async () => {
    server.use(
      ...practiceHandlers({ sessions: [], queue: { ...DEFAULT_QUEUE, due: 0, weak: 0 } }),
    );
    renderPractice();

    expect(
      await screen.findByRole('button', { name: /start a quick 5/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('BoltIcon')).toBeInTheDocument();
    expect(
      screen.getByText(/ones you haven.t seen yet come first/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review now/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('AutorenewOutlinedIcon')).not.toBeInTheDocument();
  });

  it('still POSTs kind: quick when biased toward review — never an unwired kind', async () => {
    const created: CreatePracticeSessionInput[] = [];
    server.use(
      ...practiceHandlers({
        sessions: [],
        queue: { ...DEFAULT_QUEUE, due: 3, weak: 2 },
        onCreateSession: (input) => created.push(input),
      }),
    );
    const user = userEvent.setup();
    renderPractice();

    await user.click(await screen.findByRole('button', { name: /review now/i }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({ kind: 'quick' });
  });
});

// -----------------------------------------------------------------------------
// The queue band — loading, error and empty-bank states, ahead of any action
// -----------------------------------------------------------------------------

describe('the queue band', () => {
  it('shows a loading state, then the real summary once the queue resolves', async () => {
    server.use(
      http.get(`${API_BASE}/practice/queue`, async () => {
        await delay(50);
        return HttpResponse.json({ data: DEFAULT_QUEUE });
      }),
      ...practiceHandlers({ sessions: [] }),
    );
    renderPractice();

    expect(
      await screen.findByRole('status', { name: /loading your queue/i }),
    ).toBeInTheDocument();

    expect(
      await screen.findByText(`${DEFAULT_QUEUE.new.total} questions you haven't seen yet.`),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: /loading your queue/i }),
    ).not.toBeInTheDocument();
  });

  it('does not render a blank band when the fetch fails, and offers a retry that recovers', async () => {
    server.use(
      ...practiceHandlers({ sessions: [], queueStatus: 500 }),
    );
    const user = userEvent.setup();
    renderPractice();

    expect(
      await screen.findByText(/practice queue could not be loaded/i),
    ).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: /try again/i });
    expect(retry).toBeInTheDocument();

    // The rest of the page is unaffected — this is a band failure, not a page
    // failure.
    expect(
      screen.getByRole('button', { name: /start a quick 5/i }),
    ).toBeInTheDocument();

    // Recovering: the retry re-fetches and the error is replaced by the
    // summary, never left standing beside it.
    server.use(...practiceHandlers({ sessions: [] }));
    await user.click(retry);

    expect(
      await screen.findByText(/questions you haven.t seen yet/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/practice queue could not be loaded/i),
    ).not.toBeInTheDocument();
  });

  it('renders an honest "nothing loaded" message, not a zero-valued summary, when the bank itself is empty', async () => {
    const emptyBankQueue: PracticeQueue = {
      testVersionCode: 'v2008',
      total: 0,
      due: 0,
      weak: 0,
      new: { total: 0, byCategory: [] },
      learning: 0,
      mastered: 0,
    };
    server.use(...practiceHandlers({ sessions: [], queue: emptyBankQueue }));
    renderPractice();

    expect(
      await screen.findByText(/no questions loaded for your test version yet/i),
    ).toBeInTheDocument();
    // Not the queue summary's own headline — the two states are mutually
    // exclusive, and this is the "the bank has nothing in it" case, not
    // "you're caught up".
    expect(screen.queryByText(/caught up/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ready to review/i)).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// By category
// -----------------------------------------------------------------------------

describe('practising one section', () => {
  it("renders the learner's real categories and starts a category session for the one clicked", async () => {
    const created: CreatePracticeSessionInput[] = [];
    server.use(
      ...practiceHandlers({
        sessions: [],
        onCreateSession: (input) => created.push(input),
      }),
    );
    const user = userEvent.setup();
    renderPractice();

    for (const category of CATEGORIES) {
      expect(
        await screen.findByRole('button', { name: new RegExp(category.name) }),
      ).toBeInTheDocument();
    }

    await user.click(
      screen.getByRole('button', { name: new RegExp(CATEGORY_DEMOCRACY.name) }),
    );

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      kind: 'category',
      categoryId: CATEGORY_DEMOCRACY.id,
    });
  });

  it("shows each section's new-question count from queue.new.byCategory, and omits it once a section has none left", async () => {
    server.use(
      ...practiceHandlers({
        sessions: [],
        queue: {
          ...DEFAULT_QUEUE,
          new: {
            total: 6,
            byCategory: [
              { categoryId: CATEGORY_DEMOCRACY.id, categoryName: CATEGORY_DEMOCRACY.name, newCount: 6 },
              // No entry at all for the other categories — the real shape a
              // fully-covered section sends, not a `newCount: 0` row.
            ],
          },
        },
      }),
    );
    renderPractice();

    const democracyButton = await screen.findByRole('button', {
      name: new RegExp(CATEGORY_DEMOCRACY.name),
    });
    expect(democracyButton).toHaveTextContent(`${CATEGORY_DEMOCRACY.section} · 6 new`);

    // A category with nothing in `byCategory` shows its plain section name —
    // an honest "nothing left", not a discouraging "0 new".
    for (const category of CATEGORIES.filter((c) => c.id !== CATEGORY_DEMOCRACY.id)) {
      const button = screen.getByRole('button', { name: new RegExp(category.name) });
      expect(button).toHaveTextContent(category.section);
      expect(button).not.toHaveTextContent('new');
    }
  });
});

// -----------------------------------------------------------------------------
// Recent sessions — completed vs. in-progress
// -----------------------------------------------------------------------------

describe('recent sessions', () => {
  it('offers Resume on an in-progress session and a summary link on a completed one', async () => {
    server.use(
      ...practiceHandlers({ sessions: [COMPLETED_SESSION, IN_PROGRESS_SESSION] }),
    );
    renderPractice();

    // The in-progress row: a real Resume button, not a bare status label.
    const resume = await screen.findByRole('link', { name: /resume/i });
    expect(resume).toHaveAttribute(
      'href',
      `/practice/sessions/${IN_PROGRESS_SESSION.id}`,
    );
    expect(screen.getByText('In progress')).toBeInTheDocument();

    // The completed row: a link to its summary, and no "Resume" on it.
    const summaryLink = screen.getByRole('link', { name: /quick 5/i });
    expect(summaryLink).toHaveAttribute(
      'href',
      `/practice/sessions/${COMPLETED_SESSION.id}/summary`,
    );
  });

  it('shows an honest empty state — no zero-valued figure or chart', async () => {
    server.use(...practiceHandlers({ sessions: [] }));
    renderPractice();

    expect(
      await screen.findByText(/haven.t practised yet/i),
    ).toBeInTheDocument();

    // Nothing that could be mistaken for a real measurement of zero.
    expect(screen.queryByText(/0 correct/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/0%/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('does not render a blank page when the fetch fails, and offers a retry', async () => {
    server.use(...practiceHandlers({ sessions: [], sessionsStatus: 500 }));
    renderPractice();

    // The rest of the page is still there — this is not a blank screen.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Practice' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /start a quick 5/i }),
    ).toBeInTheDocument();

    expect(
      await screen.findByText(/recent practice could not be loaded/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Loading and unfinished-setup states
// -----------------------------------------------------------------------------

describe('loading and unfinished setup', () => {
  it('shows a loading state rather than a blank page while the profile loads', async () => {
    server.use(
      http.get(`${API_BASE}/journey/profile`, async () => {
        await delay(50);
        return HttpResponse.json({
          data: { profile: ORIENTED_PROFILE, testVersions: [], states: [] },
        });
      }),
      ...practiceHandlers({ sessions: [] }),
    );
    renderPractice();

    expect(screen.getByRole('status', { name: /loading practice/i })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Practice' }),
    ).toBeInTheDocument();
  });

  it('tells an unoriented learner what is missing instead of showing empty practice', async () => {
    server.use(...practiceHandlers({ sessions: [] }));
    renderPractice({ profile: UNORIENTED_PROFILE });

    expect(
      await screen.findByText(/don.t know which civics test applies to you yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /open your plan/i }),
    ).toHaveAttribute('href', '/settings/journey');
    // No Quick 5 button to click when there is nothing to practise.
    expect(
      screen.queryByRole('button', { name: /start a quick 5/i }),
    ).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The mock interview band (#145, epic #57 / E8)
// -----------------------------------------------------------------------------

describe('the mock interview band', () => {
  it('offers the mock interview as its own band, pointing at a real route', async () => {
    server.use(...practiceHandlers({ sessions: [] }));
    renderPractice();

    const link = await screen.findByRole('link', {
      name: /start a mock interview/i,
    });
    // The START SCREEN, not a session id this page invented: unlike Quick 5,
    // an interview needs the retention decision (§8.1) that screen asks for
    // before one exists at all.
    expect(link).toHaveAttribute('href', '/practice/interviews');

    // Its own `h2`, alongside Quick 5's and the category band's — not a third
    // button inside "Start practising". A Quick 5 and a rehearsal are not the
    // same kind of act, and presenting them as peers inside one band would let
    // a learner tap into the second expecting the first.
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toContain('Mock interview');
    expect(headings).toContain('Start practising');
  });

  it('says what an interview is before the learner commits to one', async () => {
    // Both surprises, stated here rather than discovered mid-rehearsal: it
    // runs longer than five questions, and it says nothing until it finishes.
    server.use(...practiceHandlers({ sessions: [] }));
    renderPractice();

    const copy = await screen.findByText(/longer than five questions/i);
    expect(copy).toBeInTheDocument();
    expect(copy).toHaveTextContent(/tells you nothing until it finishes/i);
  });

  it('navigates to the mock interview screen', async () => {
    server.use(...practiceHandlers({ sessions: [] }));
    const user = userEvent.setup();
    renderPractice();

    await user.click(
      await screen.findByRole('link', { name: /start a mock interview/i }),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Mock interview' }),
    ).toBeInTheDocument();
  });

  it('is not offered when there is no test version to interview against', async () => {
    // The same gate the rest of the page's actions sit behind: with no
    // resolved test version there are no questions, so there is no interview
    // to sit either.
    server.use(...practiceHandlers({ sessions: [] }));
    renderPractice({ profile: UNORIENTED_PROFILE });

    expect(await screen.findByRole('link', { name: /open your plan/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /start a mock interview/i }),
    ).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Mobile and theme
// -----------------------------------------------------------------------------

describe('at 360px and in both themes', () => {
  it('renders every band at a 360px viewport with nothing width-gated away', async () => {
    setViewportWidth(PHONE);
    server.use(
      ...practiceHandlers({ sessions: [COMPLETED_SESSION, IN_PROGRESS_SESSION] }),
    );
    renderPractice();

    expect(
      await screen.findByRole('button', { name: /start a quick 5/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: new RegExp(CATEGORY_DEMOCRACY.name) }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /resume/i })).toBeInTheDocument();
  });

  it('renders the same content in the dark theme', async () => {
    server.use(...practiceHandlers({ sessions: [COMPLETED_SESSION] }));
    renderPractice({ mode: 'dark' });

    expect(
      await screen.findByRole('button', { name: /start a quick 5/i }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /quick 5/i })).toBeInTheDocument();
  });
});
