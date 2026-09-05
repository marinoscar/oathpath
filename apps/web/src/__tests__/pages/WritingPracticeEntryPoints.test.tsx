/**
 * Getting to writing practice (issue #147, epic #59 / E10).
 *
 * A sibling of `ReadingPracticeEntryPoints.test.tsx`, and its own file for the
 * reason that one gives: a screen nobody can reach is a screen that does not
 * exist, and neither `LearnPage.test.tsx` nor `PracticePage.test.tsx` would fail
 * if the link were dropped — both are about their own page's content.
 *
 * Three things are asserted at each entry point:
 *
 *  1. The affordance is a **link** — a real `<a href>`, not a button. Nothing is
 *     created by pressing it (unlike Quick 5, which POSTs a session into
 *     existence before it has a URL), so middle-click and "open in new tab"
 *     must work.
 *  2. It points at `/practice/writing`, the route `App.tsx` actually mounts. A
 *     next step pointing at an unmounted route lands the learner on the
 *     catch-all redirect to `/`.
 *  3. **The reading link is still there beside it.** This is the assertion the
 *     reading file cannot make, and the one worth having: the English segment
 *     has two halves that are tested separately, and a learner offered only the
 *     reading one would reasonably conclude that is all the English there is.
 *     Replacing one entry with the other is a plausible tidy-up, and it would
 *     silently hide half the exercise.
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
import {
  READING_PRACTICE_PATH,
  WRITING_PRACTICE_PATH,
} from '../../components/english/paths';
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

describe('entry points to writing practice', () => {
  it('Practice offers it as its own band, saying what it is before the click', async () => {
    renderAt('/practice', <PracticePage />);

    const link = await screen.findByRole('link', {
      name: /practise writing from dictation/i,
    });
    expect(link).toHaveAttribute('href', WRITING_PRACTICE_PATH);

    // The copy has to say the sentence is never shown BEFORE the click. It is
    // the whole shape of the exercise, and discovering it afterwards reads as a
    // broken screen rather than as the test it is.
    expect(screen.getByText(/you never see it/i)).toBeInTheDocument();

    // Reading is still offered. Two halves, two links.
    expect(
      screen.getByRole('link', { name: /practise reading aloud/i }),
    ).toHaveAttribute('href', READING_PRACTICE_PATH);
  });

  it('Learn offers it beside reading, without taking the flashcards’ place', async () => {
    renderAt('/learn', <LearnPage />);

    const link = await screen.findByRole('link', {
      name: /practise writing from dictation/i,
    });
    expect(link).toHaveAttribute('href', WRITING_PRACTICE_PATH);

    expect(
      screen.getByRole('link', { name: /practise reading aloud/i }),
    ).toBeInTheDocument();
    // The flashcard entry is still the primary action of that screen — both
    // English links sit beside it, never instead of it.
    expect(
      screen.getByRole('link', { name: /study all questions with flashcards/i }),
    ).toBeInTheDocument();
  });

  it('points at a path under /practice, so the navigation rail keeps its answer', () => {
    // `config/destinations.ts` owns `/practice` by segment boundary, which is
    // what lets this screen be content WITHIN the Practice destination rather
    // than a destination of its own — no `DESTINATION_ROUTES` key, no rail
    // entry, no AppBar special case.
    expect(WRITING_PRACTICE_PATH.startsWith('/practice/')).toBe(true);
    expect(WRITING_PRACTICE_PATH).not.toBe(READING_PRACTICE_PATH);
  });
});
