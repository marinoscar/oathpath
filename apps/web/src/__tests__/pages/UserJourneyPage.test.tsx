/**
 * `/settings/journey` — the ongoing plan page (issue #77, epic #50).
 *
 * What these tests pin, in order of how much it would cost to get wrong:
 *
 *   1. THE FILING-DATE CHANGE IS SURFACED BEFORE IT IS SAVED. This is the one
 *      thing that genuinely differs between this chrome and `/setup/journey`:
 *      here a version already exists, so a new date REPLACES the question bank
 *      the learner has been studying. Silently swapping it is the failure.
 *   2. THE SAVE DOES NOT RE-RUN ORIENTATION. The body carries no flag that
 *      could reset `orientationCompletedAt` or the stage, and what the app
 *      holds afterwards is the server's own answer.
 *   3. THE HUB TILE AND THE ROUTE AGREE — a card whose route is missing lands
 *      the learner on Home via the catch-all, which looks like nothing
 *      happened.
 *   4. Every field can be changed and persists; a validation failure is
 *      announced and sends nothing; both work at 360px and in both themes.
 *
 * The form itself is `/setup/journey`'s, and `JourneyFormIsShared.test.tsx`
 * proves that structurally rather than by inspection. `OrientationPage.test.tsx`
 * already covers the form's own field-level behaviour, so this suite exercises
 * it only where the settings chrome changes what it means.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import UserJourneyPage from '../../pages/UserJourneyPage';
import UserSettingsHubPage from '../../pages/UserSettingsHubPage';
import {
  LearnerProfileProvider,
  useLearnerProfile,
} from '../../contexts/LearnerProfileContext';
import { AuthContext } from '../../contexts/AuthContext';
import { mockUser } from '../utils/test-utils';
import { ORIENTED_PROFILE, profileResponse } from '../utils/journey-fixtures';
import type { JourneyProfile } from '../../types';

/** Bodies the page actually `PUT`s, in order. */
let savedBodies: Array<Record<string, unknown>> = [];
let profileReads = 0;

function mockJourneyApi(
  profile: JourneyProfile = ORIENTED_PROFILE,
  saved: JourneyProfile = ORIENTED_PROFILE,
) {
  savedBodies = [];
  profileReads = 0;
  server.use(
    http.get('*/api/journey/profile', () => {
      profileReads += 1;
      return HttpResponse.json({ data: profileResponse(profile) });
    }),
    http.put('*/api/journey/profile', async ({ request }) => {
      savedBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ data: profileResponse(saved) });
    }),
  );
}

/**
 * Renders whatever the context holds, so "the stage was not reset" and "the
 * rest of the app agrees" are assertions about SHARED state rather than about
 * this page's own markup.
 */
function ProfileProbe() {
  const { profile } = useLearnerProfile();
  if (!profile) return null;
  return (
    <div
      data-testid="profile-probe"
      data-stage={profile.stage}
      data-completed-at={profile.orientationCompletedAt ?? ''}
      data-goal={String(profile.dailyGoalMinutes)}
    />
  );
}

/**
 * The page inside the route tree it really lives in: the hub at `/settings` and
 * the page at `/settings/journey`, so "the tile and the route agree" is a claim
 * about navigation rather than about a component rendered in isolation.
 */
function renderPage(
  initial = '/settings/journey',
  mode: 'light' | 'dark' = 'light',
) {
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
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route element={<LearnerProfileProvider />}>
              <Route path="/settings" element={<UserSettingsHubPage />} />
              <Route
                path="/settings/journey"
                element={
                  <>
                    <UserJourneyPage />
                    <ProfileProbe />
                  </>
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

const FILING_DATE = /when did you file your form n-400/i;
const SAVE = { name: /save changes/i } as const;

beforeEach(() => {
  setViewportWidth(1440);
  mockJourneyApi();
});

// -----------------------------------------------------------------------------
// The hub tile and the route
// -----------------------------------------------------------------------------

describe('/settings/journey — the hub tile and the route agree', () => {
  it('offers a Your plan card on the settings hub that navigates to the page', async () => {
    const user = userEvent.setup();
    renderPage('/settings');

    // The card, from `USER_SETTINGS_SECTIONS` — rendered by the SHARED
    // `SettingsHub`, which this issue does not touch.
    const card = await screen.findByRole('heading', { level: 6, name: 'Your plan' });
    expect(card).toBeInTheDocument();

    await user.click(card);

    // The route exists and renders the page. Without it the click would fall
    // through the catch-all and the learner would silently land on Home.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your plan' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(FILING_DATE)).toBeInTheDocument();
  });

  it('is reachable by a learner holding no permissions at all', async () => {
    // The card declares none and the route is ungated, matching a controller
    // that is `@Auth()` with no permissions. A learner locked out of their own
    // plan is the failure this prevents.
    const auth = {
      user: { ...mockUser, permissions: [], roles: [{ name: 'viewer' }] },
      isLoading: false,
      isAuthenticated: true,
      providers: [],
      login: vi.fn(),
      logout: vi.fn(),
      refreshUser: vi.fn(),
    };

    render(
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter initialEntries={['/settings']}>
          <Routes>
            <Route path="/settings" element={<UserSettingsHubPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(
      screen.getByRole('heading', { level: 6, name: 'Your plan' }),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// What the page shows
// -----------------------------------------------------------------------------

describe('/settings/journey — what it shows', () => {
  it('renders one h1 and every question, seeded from the stored profile', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your plan' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    // `getByLabelText` throughout: it passes only when each control is really
    // associated with its label, which is what a screen reader needs.
    expect(screen.getByLabelText(FILING_DATE)).toBeInTheDocument();
    expect(screen.getByLabelText(/yes, both are true/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/do you have an interview date yet/i)).toHaveValue(
      '2026-11-04',
    );
    expect(screen.getByLabelText(/which state or territory/i)).toHaveValue('CA');
    expect(screen.getByLabelText(/how many minutes a day/i)).toHaveValue(15);
    expect(screen.getByLabelText(/what language should we use/i)).toHaveValue('es');
  });

  it('labels its action for a learner who is already where they want to be', async () => {
    renderPage();
    expect(await screen.findByRole('button', SAVE)).toBeInTheDocument();
    // Orientation's hand-off label has no meaning here — nothing continues.
    expect(
      screen.queryByRole('button', { name: /save and continue/i }),
    ).not.toBeInTheDocument();
  });

  it('names the test the learner already has, though no filing date is stored', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    expect(screen.getByText(/Your test: 2008 Civics Test/)).toBeInTheDocument();
    expect(screen.getByLabelText(FILING_DATE)).toHaveValue('');
  });
});

// -----------------------------------------------------------------------------
// THE test-version change, surfaced before the save
// -----------------------------------------------------------------------------

describe('/settings/journey — a filing date that changes the test version', () => {
  it('says what is being replaced, with what, BEFORE anything is saved', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(screen.getByLabelText(FILING_DATE), '2025-10-20');

    expect(
      await screen.findByText(
        /this date changes your test from the 2008 Civics Test to the 2025 Civics Test/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the questions you practice will change to match/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing changes until you save/i)).toBeInTheDocument();

    // BEFORE it is saved, in the only sense that matters: no request has been
    // made, and the learner can still change their mind.
    expect(savedBodies).toHaveLength(0);
  });

  it('reframes the preview as the version that will apply AFTER saving', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(screen.getByLabelText(FILING_DATE), '2025-10-20');

    expect(
      await screen.findByText(/Your test after you save: 2025 Civics Test/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/20 questions at the interview, and 12 correct to pass/i),
    ).toBeInTheDocument();
    // The stale claim is gone: the learner is not told they still have the
    // 2008 test while the notice says it is changing.
    expect(screen.queryByText(/Your test: 2008 Civics Test/)).not.toBeInTheDocument();
  });

  it('announces it politely, as a status and never as an alert', async () => {
    // #72 made the version preview a polite `role="status"` on purpose: an
    // assertive role interrupts a screen reader mid-form on every date digit.
    // The change notice rides inside that same region rather than regressing
    // it to an `Alert`.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(screen.getByLabelText(FILING_DATE), '2025-10-20');

    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(/changes your test from the 2008 Civics Test/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says nothing about a change when the date resolves to the same test', async () => {
    // A learner correcting a typo in a date that lands in the same era is not
    // changing anything, and telling them otherwise would be alarming noise.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(screen.getByLabelText(FILING_DATE), '2024-03-15');

    expect(await screen.findByText(/Your test: 2008 Civics Test/)).toBeInTheDocument();
    expect(screen.queryByText(/changes your test from/i)).not.toBeInTheDocument();
  });

  it('sends the DATE and never a version code the browser resolved', async () => {
    // The cutoff rule lives on the server; the API rejects a body carrying
    // both. The preview above is presentation, not a second authority.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(screen.getByLabelText(FILING_DATE), '2025-10-20');
    await user.click(screen.getByRole('button', SAVE));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0]).toHaveProperty('filingDate', '2025-10-20');
    expect(savedBodies[0]).not.toHaveProperty('testVersionCode');
  });
});

// -----------------------------------------------------------------------------
// Saving
// -----------------------------------------------------------------------------

describe('/settings/journey — saving', () => {
  it('persists every field the learner changed', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(screen.getByLabelText(FILING_DATE), '2024-03-15');
    await user.click(screen.getByLabelText(/yes, both are true/i));
    await user.clear(screen.getByLabelText(/do you have an interview date yet/i));
    await user.type(
      screen.getByLabelText(/do you have an interview date yet/i),
      '2027-01-15',
    );
    await user.selectOptions(screen.getByLabelText(/which state or territory/i), 'TX');
    await user.clear(screen.getByLabelText(/how many minutes a day/i));
    await user.type(screen.getByLabelText(/how many minutes a day/i), '30');
    await user.selectOptions(screen.getByLabelText(/what language should we use/i), 'vi');

    await user.click(screen.getByRole('button', SAVE));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0]).toMatchObject({
      filingDate: '2024-03-15',
      seniorExemption: true,
      interviewDate: '2027-01-15',
      stateCode: 'TX',
      dailyGoalMinutes: 30,
      explanationLanguage: 'vi',
    });
  });

  it('clears a cancelled interview with an explicit null', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.clear(screen.getByLabelText(/do you have an interview date yet/i));
    await user.click(screen.getByRole('button', SAVE));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    // Absent means "unchanged" under the merge semantics; only an explicit
    // null can say the interview is off.
    expect(savedBodies[0].interviewDate).toBeNull();
  });

  it('does not re-run orientation: nothing in the body could reset it', async () => {
    // The API infers completion from the stored data and guards the inference
    // on `orientationCompletedAt === null`, so a second save touches neither
    // the timestamp nor the stage (`apps/api/src/journey/journey.service.ts`).
    // The web's half of that contract is to add NO client flag — there is no
    // field in the DTO that could claim otherwise, and this is what keeps one
    // from being introduced here.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.clear(screen.getByLabelText(/how many minutes a day/i));
    await user.type(screen.getByLabelText(/how many minutes a day/i), '25');
    await user.click(screen.getByRole('button', SAVE));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    const body = savedBodies[0];
    for (const forbidden of [
      'stage',
      'orientationCompletedAt',
      'orientationCompleted',
      'orientation',
      'testVersionCode',
    ]) {
      expect(body, `${forbidden} must never be sent from this page`).not.toHaveProperty(
        forbidden,
      );
    }
    // Exactly the fields the form owns, and no more.
    expect(Object.keys(body).sort()).toEqual(
      [
        'dailyGoalMinutes',
        'explanationLanguage',
        'interviewDate',
        'seniorExemption',
        'stateCode',
        'timezone',
      ].sort(),
    );
  });

  it('leaves the stage and the completion timestamp exactly as the server reports them', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    const before = screen.getByTestId('profile-probe');
    expect(before).toHaveAttribute('data-stage', 'oriented');
    expect(before).toHaveAttribute('data-completed-at', '2026-09-02T10:00:00.000Z');

    await user.clear(screen.getByLabelText(/how many minutes a day/i));
    await user.type(screen.getByLabelText(/how many minutes a day/i), '25');
    await user.click(screen.getByRole('button', SAVE));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    const after = await screen.findByTestId('profile-probe');
    expect(after).toHaveAttribute('data-stage', 'oriented');
    expect(after).toHaveAttribute('data-completed-at', '2026-09-02T10:00:00.000Z');
  });

  it('confirms the save where the learner can see it, and stays on the page', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.click(screen.getByRole('button', SAVE));

    const confirmation = await screen.findByText(/saved\. your plan is up to date/i);
    expect(confirmation).toBeInTheDocument();
    // A confirmation assistive technology announces, politely — nothing has
    // gone wrong, so it is a status and not an alert. (Two polite regions are
    // on screen by now: the test-version preview, and this.)
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((region) => /saved/i.test(region.textContent ?? ''))).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Still here. A learner who came to change one thing may want to change
    // another, and a navigation would take that away.
    expect(screen.getByRole('heading', { level: 1, name: 'Your plan' })).toBeInTheDocument();
  });

  it('makes the rest of the app agree without spending a second round trip', async () => {
    // The `PUT` answers with exactly the payload `GET` answers with, and the
    // form pushes it into the context. A `refresh()` on top would re-read what
    // the server just said — one extra request, and a window where the two
    // answers could differ.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.click(screen.getByRole('button', SAVE));
    await screen.findByText(/saved\. your plan is up to date/i);

    expect(profileReads).toBe(1);
    expect(await screen.findByTestId('profile-probe')).toHaveAttribute('data-goal', '15');
  });
});

// -----------------------------------------------------------------------------
// When something is wrong
// -----------------------------------------------------------------------------

describe('/settings/journey — when something is wrong', () => {
  it('announces a validation failure and sends nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.selectOptions(screen.getByLabelText(/which state or territory/i), '');
    await user.click(screen.getByRole('button', SAVE));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/choose your state or territory/i);
    // The failure is local — the learner does not wait on a round trip to
    // find out.
    expect(savedBodies).toHaveLength(0);
  });

  it('rejects a daily goal the API would refuse, in place', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.clear(screen.getByLabelText(/how many minutes a day/i));
    await user.type(screen.getByLabelText(/how many minutes a day/i), '900');
    await user.click(screen.getByRole('button', SAVE));

    expect(await screen.findByRole('alert')).toHaveTextContent(/between 1 and 480/i);
    expect(savedBodies).toHaveLength(0);
  });

  it('does not force a learner changing one answer to re-enter their filing date', async () => {
    // The date is an input the server resolves from, never a stored column, so
    // there is nothing to redisplay — and demanding it back to change a daily
    // goal would be asking for a document the learner has to go and find.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.clear(screen.getByLabelText(/how many minutes a day/i));
    await user.type(screen.getByLabelText(/how many minutes a day/i), '20');
    await user.click(screen.getByRole('button', SAVE));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0]).not.toHaveProperty('filingDate');
  });

  it('surfaces a failed save without losing what the learner typed', async () => {
    server.use(
      http.put('*/api/journey/profile', () =>
        HttpResponse.json({ message: 'Unknown test version "v9999".' }, { status: 400 }),
      ),
    );

    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.selectOptions(screen.getByLabelText(/which state or territory/i), 'NY');
    await user.click(screen.getByRole('button', SAVE));

    expect(await screen.findByRole('alert')).toHaveTextContent(/unknown test version/i);
    // Still on the form, still holding the answer.
    expect(screen.getByLabelText(/which state or territory/i)).toHaveValue('NY');
  });
});

// -----------------------------------------------------------------------------
// 360px and both themes
// -----------------------------------------------------------------------------

describe('/settings/journey — 360px and both themes', () => {
  it('renders every question and the action at 360px', async () => {
    setViewportWidth(360);
    renderPage();

    await screen.findByRole('heading', { level: 1, name: 'Your plan' });
    expect(screen.getByLabelText(FILING_DATE)).toBeVisible();
    expect(screen.getByLabelText(/which state or territory/i)).toBeVisible();
    expect(screen.getByLabelText(/how many minutes a day/i)).toBeVisible();
    expect(screen.getByRole('button', SAVE)).toBeVisible();
  });

  it.each(['light', 'dark'] as const)('saves in the %s theme', async (mode) => {
    const user = userEvent.setup();
    renderPage('/settings/journey', mode);
    await screen.findByRole('heading', { level: 1, name: 'Your plan' });

    await user.clear(screen.getByLabelText(/how many minutes a day/i));
    await user.type(screen.getByLabelText(/how many minutes a day/i), '10');
    await user.click(screen.getByRole('button', SAVE));

    expect(await screen.findByText(/saved\. your plan is up to date/i)).toBeVisible();
  });

  it.each(['light', 'dark'] as const)(
    'reports a validation failure at 360px in the %s theme',
    async (mode) => {
      setViewportWidth(360);
      const user = userEvent.setup();
      renderPage('/settings/journey', mode);
      await screen.findByRole('heading', { level: 1, name: 'Your plan' });

      await user.selectOptions(screen.getByLabelText(/which state or territory/i), '');
      await user.click(screen.getByRole('button', SAVE));

      expect(await screen.findByRole('alert')).toBeVisible();
      expect(savedBodies).toHaveLength(0);
    },
  );

  it('surfaces the version change at 360px, where the notice has the least room', async () => {
    setViewportWidth(360);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(screen.getByLabelText(FILING_DATE), '2025-10-20');

    expect(
      await screen.findByText(/this date changes your test from the 2008 Civics Test/i),
    ).toBeVisible();
  });
});
