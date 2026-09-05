/**
 * Getting to reading practice (issue #144, epic #59 / E10).
 *
 * The acceptance criterion is "entry points exist from Learn and Practice", and
 * it is worth its own file for one reason: a screen nobody can reach is a screen
 * that does not exist, and neither `LearnPage.test.tsx` nor `PracticePage.test.tsx`
 * would fail if the link were dropped. Both are about their own page's content.
 *
 * Two things are asserted at each entry point, and the second matters as much as
 * the first:
 *
 *  1. The affordance is a **link** — a real `<a href>` — not a button. Nothing
 *     is created by pressing it (unlike Quick 5, which POSTs a session into
 *     existence before it has a URL), so middle-click and "open in new tab"
 *     must work. A `<button>` here would be a promise the router cannot keep.
 *  2. It points at `/practice/reading`, the route `App.tsx` actually mounts.
 *     A next step pointing at an unmounted route lands the learner on the
 *     catch-all redirect to `/` — the exact debt `components/interview/paths.ts`
 *     records for the debrief link before #145 mounted it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../mocks/server';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import { LearnerProfileProvider } from '../../contexts/LearnerProfileContext';
import LearnPage from '../../pages/LearnPage';
import PracticePage from '../../pages/PracticePage';
import { READING_PRACTICE_PATH } from '../../components/english/paths';
import { ORIENTED_PROFILE } from '../utils/journey-fixtures';
import { civicsHandlers, journeyProfileHandler } from '../utils/civics-fixtures';
import type { PracticeQueue } from '../../types';

const API_BASE = '*/api';

const EMPTY_QUEUE: PracticeQueue = {
  testVersionCode: 'v2008',
  total: 10,
  due: 0,
  weak: 0,
  new: { total: 10, byCategory: [] },
  learning: 0,
  mastered: 0,
};

function renderAt(initialUrl: string, element: React.ReactElement) {
  server.use(journeyProfileHandler(ORIENTED_PROFILE));

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
    <ThemeProvider theme={createTheme({ palette: { mode: 'light' } })}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter initialEntries={[initialUrl]}>
          <Routes>
            {/* The provider as a LAYOUT route, exactly as `App.tsx` mounts it. */}
            <Route element={<LearnerProfileProvider />}>
              <Route path={initialUrl} element={element} />
              <Route path="/settings/journey" element={<h1>Your plan</h1>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  server.use(
    ...civicsHandlers(),
    http.get(`${API_BASE}/practice/sessions`, () =>
      HttpResponse.json({
        data: { items: [], total: 0, page: 1, pageSize: 5, totalPages: 1 },
      }),
    ),
    http.get(`${API_BASE}/practice/queue`, () =>
      HttpResponse.json({ data: EMPTY_QUEUE }),
    ),
  );
});

describe('entry points to reading practice', () => {
  it('Practice offers it as its own band, saying what it is before the click', async () => {
    renderAt('/practice', <PracticePage />);

    const link = await screen.findByRole('link', { name: /practise reading aloud/i });
    expect(link).toHaveAttribute('href', READING_PRACTICE_PATH);

    // The copy has to distinguish it from the civics drills above it —
    // otherwise a learner reads "practise reading" as "read the questions".
    expect(
      screen.getByText(/the english part of the interview, not the civics part/i),
    ).toBeInTheDocument();
  });

  it('Learn offers it beside the flashcards, without taking their place', async () => {
    renderAt('/learn', <LearnPage />);

    const link = await screen.findByRole('link', { name: /practise reading aloud/i });
    expect(link).toHaveAttribute('href', READING_PRACTICE_PATH);

    // The flashcard entry is still the primary action of that screen — this
    // link sits beside it, never instead of it.
    expect(
      screen.getByRole('link', { name: /study all questions with flashcards/i }),
    ).toBeInTheDocument();
  });

  it('points at a path under /practice, so the navigation rail keeps its answer', () => {
    // `config/destinations.ts` owns `/practice` by segment boundary, which is
    // what lets this screen be content WITHIN the Practice destination rather
    // than a destination of its own — no `DESTINATION_ROUTES` key, no rail
    // entry, no AppBar special case.
    expect(READING_PRACTICE_PATH.startsWith('/practice/')).toBe(true);
  });
});
