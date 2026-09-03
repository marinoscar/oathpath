/**
 * Mock interview — the start screen (`/practice/interviews`), issue #140,
 * epic #57 / E8.
 *
 * WHAT THESE TESTS PROTECT, in order of how quietly each would break:
 *
 *  1. **THE LOAD-BEARING ONE: retention is OFF unless the learner turns it
 *     on**, and the request says so explicitly. `mock-interview.md` §15 rejects
 *     retention-on-by-default with "the conservative-handling posture applies
 *     to the DEFAULT, not only to the OPTION". A regression here is one
 *     character wide, changes nothing visible, and silently starts keeping the
 *     most sensitive text this product touches.
 *  2. **The choice is offered here and the interview starts from here** — one
 *     press, straight into `/practice/interviews/:id`.
 *  3. **The three surprises are said before the interview, not discovered
 *     during it**: no feedback until the end, it can stop early, and the
 *     reading and writing tests are not in it yet.
 *  4. **The history band (#145) keeps loading, empty and failed as three
 *     different things to say**, and an empty history is an EMPTY STATE rather
 *     than a fabricated zero. A "0 interviews" line is indistinguishable at a
 *     glance from a real measurement, which is the one failure a screenshot
 *     review would not catch. A completed row links to its DEBRIEF and an
 *     unfinished one RESUMES — two different acts, two different affordances.
 *  5. **A row for an unfinished interview carries no counts.**
 *     `docs/specs/mock-interview.md` §10 is a rule about the whole surface: a
 *     learner mid-interview who could read "2 correct" off this list has been
 *     handed the running score the live screen refuses them, through a second
 *     door.
 *  6. **Legible at 360px**, and a failure is prose rather than a stack trace.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import InterviewStartPage from '../../pages/InterviewStartPage';
import type { InterviewListItem } from '../../types';

const API_BASE = '*/api';
const PHONE = 360;
const INTERVIEW_ID = 'interview-1';

/** One header row, as `GET /api/interviews` sends it. */
function interviewRow(
  overrides: Partial<InterviewListItem> = {},
): InterviewListItem {
  return {
    id: 'past-1',
    mode: 'text',
    status: 'completed',
    testVersionCode: 'v2008',
    seniorExemption: false,
    transcriptRetained: false,
    startedAt: '2026-02-20T12:00:00.000Z',
    completedAt: '2026-02-20T12:20:00.000Z',
    civicsAsked: 8,
    civicsCorrect: 6,
    passedCivics: true,
    ...overrides,
  };
}

interface StartOptions {
  onCreate?: (body: { transcriptRetained?: boolean }) => void;
  failWith?: string;
  /** The history band's rows. Empty by default — a learner's first visit. */
  history?: InterviewListItem[];
  /** Make the history read fail, to exercise the third of its three states. */
  historyStatus?: number;
}

function renderStart({
  onCreate,
  failWith,
  history = [],
  historyStatus,
}: StartOptions = {}) {
  server.use(
    http.get(`${API_BASE}/interviews`, () => {
      if (historyStatus && historyStatus >= 400) {
        return HttpResponse.json(
          { message: 'Your past interviews could not be loaded.' },
          { status: historyStatus },
        );
      }
      return HttpResponse.json({
        data: {
          items: history,
          total: history.length,
          page: 1,
          pageSize: 5,
          totalPages: 1,
        },
      });
    }),
    http.post(`${API_BASE}/interviews`, async ({ request }) => {
      const body = (await request.json()) as { transcriptRetained?: boolean };
      onCreate?.(body);

      if (failWith) {
        return HttpResponse.json(
          { code: 'bad_request', message: failWith },
          { status: 400 },
        );
      }

      return HttpResponse.json(
        {
          data: {
            interview: { id: INTERVIEW_ID },
            officerTurns: [],
            progress: { civicsAsked: 0, civicsPlanned: 10 },
            awaitingCompletion: false,
          },
        },
        { status: 201 },
      );
    }),
  );

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
        <MemoryRouter initialEntries={['/practice/interviews']}>
          <Routes>
            <Route path="/practice/interviews" element={<InterviewStartPage />} />
            <Route
              path="/practice/interviews/:id"
              element={<div>the interview screen</div>}
            />
            <Route
              path="/practice/interviews/:id/debrief"
              element={<div>the debrief</div>}
            />
            <Route path="/practice" element={<div>Practice destination</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

describe('InterviewStartPage — the retention choice', () => {
  it('starts the interview with retention OFF when the learner does not touch it', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderStart({ onCreate });

    expect(
      screen.getByRole('switch', { name: /keep a transcript of this interview/i }),
    ).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: /start the interview/i }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    // EXPLICIT `false`, not an omitted field. The API defaults the same way,
    // but a request that says what the learner chose is a request whose
    // meaning does not depend on somebody else's default staying put.
    expect(onCreate).toHaveBeenCalledWith({ transcriptRetained: false });
  });

  it('sends retention on only when the learner turns it on', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderStart({ onCreate });

    await user.click(
      screen.getByRole('switch', { name: /keep a transcript of this interview/i }),
    );
    await user.click(screen.getByRole('button', { name: /start the interview/i }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({ transcriptRetained: true }),
    );
  });

  it('offers the choice exactly once, before the interview exists', async () => {
    const user = userEvent.setup();
    renderStart();

    expect(screen.getAllByRole('switch')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /start the interview/i }));
    expect(await screen.findByText('the interview screen')).toBeInTheDocument();
    // Gone with the screen that asked it: it is a per-interview decision made
    // before there is anything to retain, never re-asked mid-interview.
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('InterviewStartPage — what it says before you begin', () => {
  it('warns that no feedback arrives until the end', () => {
    renderStart();
    expect(screen.getByText(/no score, no tick and no correction/i)).toBeInTheDocument();
  });

  it('warns that the civics section can finish early, in either direction', () => {
    renderStart();
    expect(screen.getByText(/can finish early, in either direction/i)).toBeInTheDocument();
  });

  it('says the reading and writing tests are not in this rehearsal yet', () => {
    // §2.4: honest about what was NOT covered, so nobody believes they
    // rehearsed a segment they never saw.
    renderStart();
    expect(
      screen.getByText(/reading and writing tests are not part of this rehearsal yet/i),
    ).toBeInTheDocument();
  });

  it('has exactly one h1', () => {
    renderStart();
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Mock interview');
  });
});

describe('InterviewStartPage — failures and width', () => {
  it('renders a refusal as prose and leaves the learner where they are', async () => {
    const user = userEvent.setup();
    renderStart({ failWith: 'Finish setting up your plan first.' });

    await user.click(screen.getByRole('button', { name: /start the interview/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /finish setting up your plan first/i,
    );
    expect(screen.queryByText('the interview screen')).toBeNull();
    // Still pressable: a 400 the learner can fix is not a dead end.
    expect(screen.getByRole('button', { name: /start the interview/i })).toBeEnabled();
  });

  it('renders at 360px', () => {
    setViewportWidth(PHONE);
    renderStart();

    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
    expect(screen.getByRole('button', { name: /start the interview/i })).toBeVisible();
    // The switch's own `<input>` is visually hidden by MUI's design, so the
    // thing checked here is the label a learner actually reads and presses.
    expect(screen.getByText('Keep a transcript of this interview')).toBeVisible();
  });
});

// -----------------------------------------------------------------------------
// The history band (#145)
// -----------------------------------------------------------------------------

describe('InterviewStartPage — your past interviews', () => {
  it('says plainly that there are none yet, and invents no zero', async () => {
    // THE ASSERTION THAT ONLY AN HONEST EMPTY STATE PASSES. A "0 interviews"
    // line, a flat chart or a ring at zero is indistinguishable at a glance
    // from a real measurement, and a learner cannot tell which one they are
    // looking at — `VISION.md`'s honesty rule, the same one `/practice`'s
    // recent-sessions band follows.
    const { container } = renderStart();

    expect(
      await screen.findByText(/you haven’t sat a mock interview yet/i),
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b0\s+interviews?\b/i);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('links a completed interview to its debrief', async () => {
    renderStart({ history: [interviewRow({ id: 'past-1' })] });

    const link = await screen.findByRole('link', { name: /mock interview/i });
    expect(link).toHaveAttribute('href', '/practice/interviews/past-1/debrief');
    // The verdict is words, not only a colour.
    expect(screen.getByText('Civics passed')).toBeInTheDocument();
    expect(screen.getByText(/8 asked · 6 correct/)).toBeInTheDocument();
  });

  it('offers to resume an unfinished interview, and shows it no counts', async () => {
    const { container } = renderStart({
      history: [
        interviewRow({
          id: 'past-2',
          status: 'in_progress',
          completedAt: null,
          civicsAsked: 3,
          civicsCorrect: 2,
          passedCivics: false,
        }),
      ],
    });

    const resume = await screen.findByRole('link', { name: /resume/i });
    expect(resume).toHaveAttribute('href', '/practice/interviews/past-2');

    // §10 THROUGH A SECOND DOOR: the row knows `civicsCorrect` — the header
    // carries it — and must not render it, or a learner could read their
    // running score off this list mid-interview.
    expect(container.textContent).not.toContain('2 correct');
    expect(container.textContent).not.toContain('3 asked');
    // And no verdict it has not earned: an unfinished interview has not
    // failed the civics section, it simply has not finished it.
    expect(screen.queryByText(/civics not passed/i)).toBeNull();
  });

  it('keeps a failed read distinct from an empty one, with a retry', async () => {
    renderStart({ historyStatus: 500 });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /past interviews could not be loaded/i,
    );
    // NOT the empty state. "We asked and it failed" and "we asked and there is
    // nothing" are two different things to say, and only the second one is an
    // empty state.
    expect(screen.queryByText(/you haven’t sat a mock interview yet/i)).toBeNull();
    expect(screen.getByRole('button', { name: /try again/i })).toBeEnabled();
  });

  it('does not hold the start control behind the history read', async () => {
    // The band is a convenience; starting an interview is what this screen is
    // for. A slow or failed history must not take the button off the screen.
    renderStart({ historyStatus: 500 });

    expect(
      screen.getByRole('button', { name: /start the interview/i }),
    ).toBeEnabled();
  });
});
