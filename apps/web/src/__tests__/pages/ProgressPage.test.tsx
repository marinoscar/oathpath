/**
 * Progress (`/progress`) — coverage and mastery, by category, plus the weak
 * list (issue #94, epic #54 / E5 "Memory").
 *
 * Shaped after `PracticePage.test.tsx`: a real `LearnerProfileProvider` layout
 * route over MSW, so `useLearnerProfile` and `useProgressMastery` both run for
 * real rather than being stubbed away.
 *
 * WHAT THESE TESTS ACTUALLY PROTECT, in the same spirit as `PracticePage.test.tsx`:
 *
 *  1. **Loading, empty (`attempted === 0`) and failed stay three different
 *     screens** — `ProgressPage.tsx`'s own header names this discipline
 *     explicitly, and each is only checkable by asserting the ABSENCE of the
 *     other two, not just the presence of the one under test.
 *  2. **The overall summary and the per-category grid render the server's own
 *     numbers**, not a client-side recomputation — this page's header states
 *     it renders the response "and nothing it computed itself".
 *  3. **The retry flow starts a `category`-kind session scoped to the right
 *     category and lands on it** — the one behaviour this page owns that
 *     `CategoryMasteryCard.test.tsx` deliberately leaves to this file (see
 *     that file's own header).
 *  4. **The error state is a region assistive technology announces**, and one
 *     real `<h1>` exists throughout, in a sane heading order.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import { LearnerProfileProvider } from '../../contexts/LearnerProfileContext';
import ProgressPage from '../../pages/ProgressPage';
import { ORIENTED_PROFILE, UNORIENTED_PROFILE } from '../utils/journey-fixtures';
import { journeyProfileHandler } from '../utils/civics-fixtures';
import {
  cappedReadinessSnapshot,
  readinessHistoryResponse,
  readinessSnapshot,
} from '../utils/readiness-fixtures';
import { TRUST_FOOTER_TEXT } from '../../components/journey/TrustFooter';
import type {
  CreatePracticeSessionInput,
  JourneyProfile,
  ProgressMastery,
  PracticeSessionState,
  ReadinessSnapshotResponse,
} from '../../types';

const API_BASE = '*/api';

// -----------------------------------------------------------------------------
// Mastery fixtures — shaped from `apps/api` DTOs via `ProgressMastery`
// (`types/index.ts`), the same discipline `civics-fixtures.ts` and
// `journey-fixtures.ts` already follow.
// -----------------------------------------------------------------------------

const CATEGORY_DEMOCRACY_MASTERY = {
  categoryId: 'category-democracy',
  categoryName: 'Principles of American Democracy',
  totalQuestions: 12,
  byState: { new: 4, learning: 3, review: 2, lapsed: 0, mastered: 3 },
  masteredCount: 3,
};

const CATEGORY_HISTORY_MASTERY = {
  categoryId: 'category-history',
  categoryName: 'Recent American History',
  totalQuestions: 10,
  byState: { new: 2, learning: 1, review: 2, lapsed: 3, mastered: 2 },
  masteredCount: 2,
};

const MASTERY: ProgressMastery = {
  testVersionCode: 'v2008',
  totalQuestions: 22,
  attempted: 13,
  byState: { new: 6, learning: 4, review: 4, lapsed: 3, mastered: 5 },
  categories: [CATEGORY_DEMOCRACY_MASTERY, CATEGORY_HISTORY_MASTERY],
};

const EMPTY_MASTERY: ProgressMastery = {
  testVersionCode: 'v2008',
  totalQuestions: 100,
  attempted: 0,
  byState: { new: 100, learning: 0, review: 0, lapsed: 0, mastered: 0 },
  categories: [],
};

function sessionStartResponse(
  input: CreatePracticeSessionInput,
): PracticeSessionState {
  return {
    session: {
      id: `session-retry-${input.categoryId}`,
      kind: input.kind,
      status: 'in_progress',
      testVersionCode: 'v2008',
      categoryId: input.categoryId ?? null,
      plannedCount: 5,
      startedAt: '2026-03-03T00:00:00.000Z',
      completedAt: null,
      summary: null,
    },
    nextQuestion: {
      id: 'question-first',
      number: 1,
      prompt: 'What is the supreme law of the land?',
      categoryId: input.categoryId ?? CATEGORY_DEMOCRACY_MASTERY.categoryId,
      dynamicScope: 'none',
    },
    progress: { answered: 0, planned: 5 },
  };
}

interface MasteryHandlerOptions {
  mastery?: ProgressMastery;
  status?: number;
  delayMs?: number;
  onCreateSession?: (input: CreatePracticeSessionInput) => void;
  createSessionStatus?: number;
}

function progressHandlers(options: MasteryHandlerOptions = {}) {
  return [
    http.get(`${API_BASE}/progress/mastery`, async () => {
      if (options.delayMs) await delay(options.delayMs);
      if (options.status && options.status >= 400) {
        return HttpResponse.json(
          { message: 'Your progress could not be loaded.' },
          { status: options.status },
        );
      }
      return HttpResponse.json({ data: options.mastery ?? MASTERY });
    }),

    http.post(`${API_BASE}/practice/sessions`, async ({ request }) => {
      const input = (await request.json()) as CreatePracticeSessionInput;
      options.onCreateSession?.(input);
      if (options.createSessionStatus && options.createSessionStatus >= 400) {
        return HttpResponse.json(
          { message: 'A practice session could not be started.' },
          { status: options.createSessionStatus },
        );
      }
      return HttpResponse.json({ data: sessionStartResponse(input) });
    }),
  ];
}

/** Serve one readiness snapshot (and its one-item history) for the next render. */
function serveReadiness(snapshot: ReadinessSnapshotResponse): void {
  server.use(
    http.get(`${API_BASE}/readiness`, () => HttpResponse.json({ data: snapshot })),
    http.get(`${API_BASE}/readiness/history`, () =>
      HttpResponse.json({ data: readinessHistoryResponse([snapshot]) }),
    ),
  );
}

/**
 * Reads the ACTUAL react-router param, never the mocked global
 * `window.location` `setup.ts` freezes — see `PracticePage.test.tsx`'s own
 * `SessionStub` for why that distinction matters for "did it navigate".
 */
function SessionStub() {
  const { id } = useParams<{ id: string }>();
  return <h1>Practice session {id}</h1>;
}

function renderProgress({
  profile = ORIENTED_PROFILE,
}: { profile?: JourneyProfile } = {}) {
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
    <ThemeProvider theme={createTheme()}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter initialEntries={['/progress']}>
          <Routes>
            <Route element={<LearnerProfileProvider />}>
              <Route path="/progress" element={<ProgressPage />} />
              <Route path="/practice/sessions/:id" element={<SessionStub />} />
              <Route path="/settings/journey" element={<h1>Your plan</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

describe('loading', () => {
  it('shows a loading state rather than a blank page while mastery loads', async () => {
    server.use(...progressHandlers({ delayMs: 50 }));
    renderProgress();

    expect(
      screen.getByRole('status', { name: /loading progress/i }),
    ).toBeInTheDocument();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Progress' }),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Success — the overall summary and one card per category
// -----------------------------------------------------------------------------

describe('success', () => {
  it("renders the overall summary numbers from the server's own response", async () => {
    server.use(...progressHandlers());
    renderProgress();

    expect(
      await screen.findByText('13 of 22 questions attempted'),
    ).toBeInTheDocument();

    // The overall breakdown bar carries the same numbers, as an accessible
    // summary — not a client-side recomputation from the categories.
    expect(
      screen.getByRole('img', { name: /mastery breakdown across all 22 questions/i }),
    ).toBeInTheDocument();
  });

  it('renders one card per category, each with its own coverage line', async () => {
    server.use(...progressHandlers());
    renderProgress();

    expect(
      await screen.findByRole('heading', {
        level: 3,
        name: CATEGORY_DEMOCRACY_MASTERY.categoryName,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: CATEGORY_HISTORY_MASTERY.categoryName,
      }),
    ).toBeInTheDocument();

    expect(screen.getByText('3 of 12 mastered')).toBeInTheDocument();
    expect(screen.getByText('2 of 10 mastered')).toBeInTheDocument();
  });

  it('lists only categories with a lapsed question under "Needs review", worst first', async () => {
    server.use(...progressHandlers());
    renderProgress();

    const weakHeading = await screen.findByRole('heading', {
      level: 2,
      name: 'Needs review',
    });
    expect(weakHeading).toBeInTheDocument();

    // Democracy has zero lapsed and must not appear in the weak list, even
    // though it does appear in the category grid below.
    const weakSection = weakHeading.closest('section') as HTMLElement;
    expect(weakSection).not.toBeNull();
    expect(
      weakSection.textContent?.includes(CATEGORY_DEMOCRACY_MASTERY.categoryName),
    ).toBe(false);
    expect(
      weakSection.textContent?.includes(CATEGORY_HISTORY_MASTERY.categoryName),
    ).toBe(true);
  });

  it('starts a category-kind retry scoped to the right category and lands on the new session', async () => {
    const created: CreatePracticeSessionInput[] = [];
    server.use(
      ...progressHandlers({ onCreateSession: (input) => created.push(input) }),
    );
    const user = userEvent.setup();
    renderProgress();

    // Two "Practice this section" controls render — the weak-list row and the
    // category card's own button, both for the one category with a lapsed
    // question. Click the weak-list one.
    const retryButtons = await screen.findAllByRole('button', {
      name: /practice this section/i,
    });
    expect(retryButtons.length).toBeGreaterThan(0);
    await user.click(retryButtons[0]);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      kind: 'category',
      categoryId: CATEGORY_HISTORY_MASTERY.categoryId,
    });

    expect(
      await screen.findByRole('heading', {
        name: `Practice session session-retry-${CATEGORY_HISTORY_MASTERY.categoryId}`,
      }),
    ).toBeInTheDocument();
  });

  it('shows a retry error inline and does not navigate when starting a session fails', async () => {
    server.use(...progressHandlers({ createSessionStatus: 500 }));
    const user = userEvent.setup();
    renderProgress();

    const retryButtons = await screen.findAllByRole('button', {
      name: /practice this section/i,
    });
    await user.click(retryButtons[0]);

    expect(
      await screen.findByText('A practice session could not be started.'),
    ).toBeInTheDocument();
    // Still on Progress — no navigation happened.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Progress' }),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Empty — a brand-new learner, `attempted: 0`
// -----------------------------------------------------------------------------

describe('the empty state', () => {
  it('renders honest new-learner messaging, not a zero-valued chart or ring', async () => {
    server.use(...progressHandlers({ mastery: EMPTY_MASTERY }));
    renderProgress();

    expect(
      await screen.findByText(/haven.t practised yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /go to practice/i }),
    ).toHaveAttribute('href', '/practice');

    // Nothing that could be mistaken for a real measurement of zero. Scoped
    // to the mastery empty-state region: the Readiness section above it (a
    // separate, independently-loaded source, per this page's own header)
    // legitimately renders its own real percentages — `50%`/`80%`/`100%`
    // among them — and an unscoped `/0%/` substring match would collide
    // with those rather than saying anything about the mastery empty state
    // under test here.
    const emptyStateHeading = screen.getByRole('heading', {
      level: 2,
      name: 'Nothing to show yet',
    });
    const emptyStateSection = emptyStateHeading.closest('section') as HTMLElement;
    expect(within(emptyStateSection).queryByText(/0 of 100/)).not.toBeInTheDocument();
    expect(within(emptyStateSection).queryByText(/0%/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /mastery breakdown/i })).not.toBeInTheDocument();
    // The dial in the Readiness section above legitimately renders a real
    // `progressbar` — this asserts the MASTERY section contributes none,
    // via the same scoped query.
    expect(within(emptyStateSection).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it("treats an unfinished plan (no resolved test version) as its own distinct notice, not the attempted-0 empty state", async () => {
    server.use(...progressHandlers());
    renderProgress({ profile: UNORIENTED_PROFILE });

    expect(
      await screen.findByText(/don.t know which civics test applies to you yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /open your plan/i }),
    ).toHaveAttribute('href', '/settings/journey');
    expect(screen.queryByText(/haven.t practised yet/i)).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

describe('the error state', () => {
  it('renders the failure in a region assistive technology announces, with a retry, and no blank page', async () => {
    server.use(...progressHandlers({ status: 500 }));
    renderProgress();

    // Still Progress, not a blank screen.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Progress' }),
    ).toBeInTheDocument();

    // MUI's `Alert` with `severity="error"` renders `role="alert"`, an
    // implicit ARIA live region — the async error is announced, not merely
    // painted on screen.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your progress could not be loaded.');
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();

    // No content from the success path leaked through underneath the error.
    expect(screen.queryByText(/questions attempted/i)).not.toBeInTheDocument();
  });

  it('recovers into the success view on a successful retry', async () => {
    let failing = true;
    server.use(
      http.get(`${API_BASE}/progress/mastery`, () => {
        if (failing) {
          return HttpResponse.json(
            { message: 'Your progress could not be loaded.' },
            { status: 500 },
          );
        }
        return HttpResponse.json({ data: MASTERY });
      }),
    );
    const user = userEvent.setup();
    renderProgress();

    await screen.findByRole('alert');

    failing = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(
      await screen.findByText('13 of 22 questions attempted'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Readiness — score, breakdown honesty rule, the cap, the recommendation
// (issues #139/#142, epic #55 / E6)
// -----------------------------------------------------------------------------

describe('readiness', () => {
  it("renders the score and stage from the server's own snapshot", async () => {
    server.use(...progressHandlers());
    serveReadiness(readinessSnapshot({ score: 59, stage: 'practicing' }));
    renderProgress();

    expect(
      await screen.findByRole('progressbar', {
        name: 'Readiness score: 59 out of 100',
      }),
    ).toHaveAttribute('aria-valuenow', '59');
    expect(screen.getByText('Practicing')).toBeInTheDocument();
  });

  it('renders "No evidence yet" for english/spoken/interview when their evidence is zero, never a 0%', async () => {
    server.use(...progressHandlers());
    // The Day 1 fixture: no spoken and no interview evidence at all.
    serveReadiness(cappedReadinessSnapshot());
    renderProgress();

    await screen.findByRole('progressbar', { name: /readiness score/i });

    const evidenceRows = screen.getAllByText('No evidence yet');
    expect(evidenceRows).toHaveLength(3);

    // Never a fabricated 0% standing in for "unmeasured" on any of the
    // three — the same honesty rule `ProgressMastery`'s own empty state
    // already enforces one section up.
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('does not claim "No evidence yet" for a currently-earnable component, even at a low value', async () => {
    server.use(...progressHandlers());
    serveReadiness(cappedReadinessSnapshot());
    renderProgress();

    await screen.findByRole('progressbar', { name: /readiness score/i });

    // `coverage` is 0.2 → 20% in the Day 1 fixture — a real, low, honest
    // number, not "no evidence yet".
    expect(screen.getByText('20%')).toBeInTheDocument();
  });

  it('renders the fixed cap sentence verbatim when capReason is typed_only', async () => {
    server.use(...progressHandlers());
    serveReadiness(cappedReadinessSnapshot());
    renderProgress();

    expect(
      await screen.findByText(
        'Your civics knowledge is strong, but you have limited interview practice. Completing two mock interviews is the best way to strengthen your readiness now.',
      ),
    ).toBeInTheDocument();
  });

  it('does not render the fixed cap sentence when capReason is null', async () => {
    server.use(...progressHandlers());
    serveReadiness(readinessSnapshot({ capReason: null }));
    renderProgress();

    await screen.findByRole('progressbar', { name: /readiness score/i });

    expect(
      screen.queryByText(/completing two mock interviews/i),
    ).not.toBeInTheDocument();
  });

  it("renders topRecommendation as a call to action, linking to the server's own path", async () => {
    server.use(...progressHandlers());
    serveReadiness(
      readinessSnapshot({
        topRecommendation: {
          componentKey: 'retention',
          title: 'A recommendation title from the server',
          reason: 'A recommendation reason from the server.',
          path: '/practice',
        },
      }),
    );
    renderProgress();

    expect(
      await screen.findByText('A recommendation title from the server'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('A recommendation reason from the server.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute(
      'href',
      '/practice',
    );
  });

  it('renders the narrative when present, and renders nothing for it when null', async () => {
    server.use(...progressHandlers());
    serveReadiness(readinessSnapshot({ narrative: 'You are making steady, real progress.' }));
    renderProgress();

    expect(
      await screen.findByText('You are making steady, real progress.'),
    ).toBeInTheDocument();
  });

  it('renders no narrative section, and no error, when narrative is null', async () => {
    server.use(...progressHandlers());
    serveReadiness(readinessSnapshot({ narrative: null }));
    renderProgress();

    await screen.findByRole('progressbar', { name: /readiness score/i });

    expect(screen.queryByText('Progress Guide')).not.toBeInTheDocument();
  });

  it('renders a trend sentence from two snapshots, and none from only one', async () => {
    server.use(...progressHandlers());
    const current = readinessSnapshot({ id: 'current', score: 65 });
    const previous = readinessSnapshot({ id: 'previous', score: 59 });
    server.use(
      http.get(`${API_BASE}/readiness`, () => HttpResponse.json({ data: current })),
      http.get(`${API_BASE}/readiness/history`, () =>
        HttpResponse.json({ data: readinessHistoryResponse([current, previous]) }),
      ),
    );
    renderProgress();

    expect(
      await screen.findByText('Up 6 points since your last check.'),
    ).toBeInTheDocument();
  });

  it('renders the readiness section in an error state independently of a healthy mastery section', async () => {
    server.use(...progressHandlers());
    server.use(
      http.get(`${API_BASE}/readiness`, () =>
        HttpResponse.json({ message: 'Your readiness could not be loaded.' }, { status: 500 }),
      ),
    );
    renderProgress();

    // The mastery section still renders successfully — one call's failure
    // does not block the other's success.
    expect(
      await screen.findByText('13 of 22 questions attempted'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Your readiness could not be loaded.'),
    ).toBeInTheDocument();
  });

  it("renders TrustFooter's exact standing disclaimer", async () => {
    server.use(...progressHandlers());
    renderProgress();

    expect(
      await screen.findByText(TRUST_FOOTER_TEXT),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// Heading structure
// -----------------------------------------------------------------------------

describe('heading structure', () => {
  it('has exactly one h1, and every h2 nests correctly under it', async () => {
    server.use(...progressHandlers());
    renderProgress();

    await screen.findByText('13 of 22 questions attempted');

    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Progress');

    const h2s = screen.getAllByRole('heading', { level: 2 });
    const h2Text = h2s.map((h) => h.textContent);
    expect(h2Text).toEqual(
      expect.arrayContaining(['Overall', 'Needs review', 'By section']),
    );

    // Category names are h3s, one level under the "By section" h2 — never a
    // heading that skips a level.
    const h3 = screen.getByRole('heading', {
      level: 3,
      name: CATEGORY_DEMOCRACY_MASTERY.categoryName,
    });
    expect(h3).toBeInTheDocument();
  });

  it('keeps exactly one h1 in the empty state too', async () => {
    server.use(...progressHandlers({ mastery: EMPTY_MASTERY }));
    renderProgress();

    await screen.findByText(/haven.t practised yet/i);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
