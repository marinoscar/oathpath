/**
 * `/setup/journey` and the shared `JourneyProfileForm` (issue #72, epic #50).
 *
 * What these tests pin, in order of how much it would cost to get wrong:
 *
 *   1. THE REQUEST BODY. Every field the learner answered has to reach the
 *      server, and the filing date has to travel as `filingDate` — never as a
 *      `testVersionCode` the browser resolved for itself, which the API rejects
 *      outright when both are present.
 *   2. THE TEST-VERSION PREVIEW, derived from the server's `filedFrom` and not
 *      from a cutoff date copied into the UI. The fixture's bound is asserted
 *      from both sides so a hardcoded '2025-10-20' comparison could not pass.
 *   3. THE HAND-OFF: saving releases the gate and lands the learner where they
 *      were going, with no page reload and no second GET.
 *   4. The screen is legible at 360px, correct in both themes, and every
 *      control has a real label.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import OrientationPage from '../../pages/OrientationPage';
import { resolveTestVersionForFilingDate } from '../../components/journey/JourneyProfileForm';
import { LearnerProfileProvider } from '../../contexts/LearnerProfileContext';
import { RequireOrientation } from '../../components/common/RequireOrientation';
import { AuthContext } from '../../contexts/AuthContext';
import { mockAdminUser, mockUser } from '../utils/test-utils';
import {
  ORIENTED_PROFILE,
  TEST_VERSIONS,
  UNORIENTED_PROFILE,
  profileResponse,
} from '../utils/journey-fixtures';
import type { JourneyProfile } from '../../types';

/** Bodies the form actually `PUT`s, in order. */
let savedBodies: Array<Record<string, unknown>> = [];
let profileReads = 0;
const logout = vi.fn();

function mockJourneyApi(
  profile: JourneyProfile,
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
 * The screen inside the route tree it really lives in.
 *
 * `/setup/journey` OUTSIDE the gate, Home INSIDE it — so "saving lands the
 * learner on Home" is a claim about the gate opening, not about a `navigate`
 * call being made.
 */
function renderPage(
  initial = '/setup/journey',
  user: typeof mockUser = mockUser,
  mode: 'light' | 'dark' = 'light',
) {
  const auth = {
    user,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout,
    refreshUser: vi.fn(),
  };

  return render(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <CssBaseline />
      <AuthContext.Provider value={auth as never}>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route element={<LearnerProfileProvider />}>
              <Route path="/setup/journey" element={<OrientationPage />} />
              <Route element={<RequireOrientation />}>
                <Route path="/" element={<h1>Welcome back</h1>} />
                <Route path="/learn" element={<h1>Learn</h1>} />
              </Route>
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
}

/** Fill in the two required answers and submit. */
async function completeForm(
  user: ReturnType<typeof userEvent.setup>,
  overrides: { filingDate?: string; state?: string } = {},
) {
  await user.type(
    screen.getByLabelText(/when did you file your form n-400/i),
    overrides.filingDate ?? '2024-03-15',
  );
  await user.selectOptions(
    screen.getByLabelText(/which state or territory/i),
    overrides.state ?? 'CA',
  );
}

beforeEach(() => {
  logout.mockReset();
  mockJourneyApi(UNORIENTED_PROFILE);
});

// -----------------------------------------------------------------------------
// The version resolution, on its own
// -----------------------------------------------------------------------------

describe('resolveTestVersionForFilingDate', () => {
  // Unit-tested separately because a preview that quietly names the WRONG test
  // is worse than no preview, and no integration assertion would notice.
  it('picks the version whose bound the date clears', () => {
    expect(
      resolveTestVersionForFilingDate('2025-10-20', TEST_VERSIONS)?.code,
    ).toBe('v2025');
    expect(
      resolveTestVersionForFilingDate('2025-10-19', TEST_VERSIONS)?.code,
    ).toBe('v2008');
  });

  it('falls back to the version with no lower bound', () => {
    expect(
      resolveTestVersionForFilingDate('1999-01-01', TEST_VERSIONS)?.code,
    ).toBe('v2008');
  });

  it('reads the bound from the data, so a third revision needs no code change', () => {
    // THE assertion that proves the cutoff is not hardcoded anywhere in the
    // web. A version the repository has never heard of, with a later bound, is
    // picked purely because the server said `filedFrom`.
    const withFuture = [
      ...TEST_VERSIONS,
      {
        code: 'v2030',
        label: '2030 Civics Test',
        questionsAsked: 25,
        passThreshold: 15,
        seniorQuestionsAsked: 12,
        seniorPassThreshold: 7,
        filedFrom: '2030-01-01',
      },
    ];
    expect(resolveTestVersionForFilingDate('2030-06-01', withFuture)?.code).toBe(
      'v2030',
    );
    expect(resolveTestVersionForFilingDate('2029-12-31', withFuture)?.code).toBe(
      'v2025',
    );
  });

  it('answers null for no date at all', () => {
    expect(resolveTestVersionForFilingDate('', TEST_VERSIONS)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The screen
// -----------------------------------------------------------------------------

describe('OrientationPage — what it asks', () => {
  it('renders §7 heading, intro and all six questions with real labels', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: /let's set up your plan/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/a few quick questions help us show you the right test/i),
    ).toBeInTheDocument();

    // `getByLabelText` is the assertion: it passes only if each control is
    // actually associated with its label, which is what a screen reader needs.
    expect(screen.getByLabelText(/when did you file your form n-400/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/yes, both are true/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/do you have an interview date yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/which state or territory do you live in/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/how many minutes a day/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/what language should we use/i)).toBeInTheDocument();
  });

  it('carries §7 helper text word for word', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    expect(
      screen.getByText(/the test changed for people who filed on or after october 20, 2025/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/answer honestly — this changes what we ask you to practice/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/if you don't have one yet, that's completely normal/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/like the name of your state's current governor/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/a short streak beats a skipped week/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/questions and official answers stay in english/i),
    ).toBeInTheDocument();
  });

  it('has one h1 and keeps the state list the server sent, territories included', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    const stateSelect = screen.getByLabelText(/which state or territory/i);
    expect(within(stateSelect).getByRole('option', { name: 'Puerto Rico' })).toBeInTheDocument();
  });

  it('defaults the daily goal to five minutes', async () => {
    renderPage();
    expect(await screen.findByLabelText(/how many minutes a day/i)).toHaveValue(5);
  });
});

describe('OrientationPage — the test version the filing date resolves', () => {
  it('says nothing until a date is given, rather than naming a default', async () => {
    // journey-shell.md §10: a default here would be an unverified claim about
    // this learner, and nothing on screen could distinguish it from an answer.
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    expect(
      screen.getByText(/once you add your filing date, we will show you here/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/2008 Civics Test/)).not.toBeInTheDocument();
  });

  it('names the 2008 test for a filing before the bound', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(
      screen.getByLabelText(/when did you file your form n-400/i),
      '2024-03-15',
    );

    expect(await screen.findByText(/2008 Civics Test/)).toBeInTheDocument();
    expect(screen.getByText(/10 questions at the interview, and 6 correct to pass/i)).toBeInTheDocument();
  });

  it('names the 2025 test on the bound day itself', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(
      screen.getByLabelText(/when did you file your form n-400/i),
      '2025-10-20',
    );

    expect(await screen.findByText(/2025 Civics Test/)).toBeInTheDocument();
    expect(screen.getByText(/20 questions at the interview, and 12 correct to pass/i)).toBeInTheDocument();
  });

  it('shows the shorter accommodation once the learner claims it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(
      screen.getByLabelText(/when did you file your form n-400/i),
      '2025-10-20',
    );
    await user.click(screen.getByLabelText(/yes, both are true/i));

    expect(
      await screen.findByText(/10 questions at the interview, and 6 correct to pass, with the accommodation/i),
    ).toBeInTheDocument();
  });
});

describe('OrientationPage — saving', () => {
  it('PERSISTS EVERY FIELD and lands on Home at stage oriented', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.type(
      screen.getByLabelText(/when did you file your form n-400/i),
      '2024-03-15',
    );
    await user.click(screen.getByLabelText(/yes, both are true/i));
    await user.type(
      screen.getByLabelText(/do you have an interview date yet/i),
      '2026-11-04',
    );
    await user.selectOptions(screen.getByLabelText(/which state or territory/i), 'CA');
    await user.clear(screen.getByLabelText(/how many minutes a day/i));
    await user.type(screen.getByLabelText(/how many minutes a day/i), '15');
    await user.selectOptions(screen.getByLabelText(/what language should we use/i), 'es');

    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    // The gate opened: this is Home, behind `RequireOrientation`, reached
    // without a reload and without a second profile read.
    expect(await screen.findByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
    expect(profileReads).toBe(1);

    expect(savedBodies).toHaveLength(1);
    const body = savedBodies[0];
    expect(body).toMatchObject({
      filingDate: '2024-03-15',
      seniorExemption: true,
      interviewDate: '2026-11-04',
      stateCode: 'CA',
      dailyGoalMinutes: 15,
      explanationLanguage: 'es',
    });
    // Captured, not asked. A real IANA name, whatever this environment's is.
    expect(typeof body.timezone).toBe('string');
    expect((body.timezone as string).length).toBeGreaterThan(0);
  });

  it('sends `filingDate` and NEVER `testVersionCode`', async () => {
    // The API rejects a body carrying both, and the cutoff rule is the
    // server's. A form that resolved the version itself and sent the code would
    // pass every visual check and 400 on the first real save.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await completeForm(user);
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0]).toHaveProperty('filingDate', '2024-03-15');
    expect(savedBodies[0]).not.toHaveProperty('testVersionCode');
  });

  it('sends an explicit null when no interview date was given', async () => {
    // Absent means "unchanged" under the merge; only an explicit null clears —
    // which is the only way to say an interview was cancelled.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await completeForm(user);
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0].interviewDate).toBeNull();
  });

  it('returns the learner to where they were going, not to Home', async () => {
    const user = userEvent.setup();
    render(
      <AuthContext.Provider
        value={
          {
            user: mockUser,
            isLoading: false,
            isAuthenticated: true,
            providers: [],
            login: vi.fn(),
            logout,
            refreshUser: vi.fn(),
          } as never
        }
      >
        <MemoryRouter initialEntries={['/learn']}>
          <Routes>
            <Route element={<LearnerProfileProvider />}>
              <Route path="/setup/journey" element={<OrientationPage />} />
              <Route element={<RequireOrientation />}>
                <Route path="/" element={<h1>Welcome back</h1>} />
                <Route path="/learn" element={<h1>Learn</h1>} />
              </Route>
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    // Redirected here from `/learn`, which the gate recorded in `state.from`.
    await screen.findByRole('heading', { level: 1, name: /let's set up your plan/i });

    await completeForm(user);
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    expect(await screen.findByRole('heading', { name: 'Learn' })).toBeInTheDocument();
  });
});

describe('OrientationPage — when something is wrong', () => {
  it('announces validation errors in a region assistive technology reads', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/which civics test applies to you/i);
    expect(alert).toHaveTextContent(/choose your state or territory/i);
    // Nothing was sent — the failure is local, not a round trip the learner
    // waits on.
    expect(savedBodies).toHaveLength(0);
  });

  it('rejects a daily goal outside the range the API accepts', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await completeForm(user);
    await user.clear(screen.getByLabelText(/how many minutes a day/i));
    await user.type(screen.getByLabelText(/how many minutes a day/i), '900');
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/between 1 and 480/i);
    expect(savedBodies).toHaveLength(0);
  });

  it('surfaces a failed save without losing what the learner typed', async () => {
    server.use(
      http.put('*/api/journey/profile', () =>
        HttpResponse.json(
          { message: 'Unknown test version "v9999".' },
          { status: 400 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await completeForm(user);
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/unknown test version/i);
    // Still on the form, still holding the answers.
    expect(screen.getByLabelText(/which state or territory/i)).toHaveValue('CA');
  });
});

describe('OrientationPage — do not trap the user', () => {
  it('always offers sign-out', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(logout).toHaveBeenCalled();
  });

  it('offers an administrator the way into admin settings', async () => {
    renderPage('/setup/journey', mockAdminUser);
    await screen.findByRole('heading', { level: 1 });

    expect(
      screen.getByRole('link', { name: /administrator settings/i }),
    ).toHaveAttribute('href', '/admin/settings');
  });

  it('offers an ordinary learner no such link', async () => {
    renderPage();
    await screen.findByRole('heading', { level: 1 });

    expect(
      screen.queryByRole('link', { name: /administrator settings/i }),
    ).not.toBeInTheDocument();
  });
});

describe('OrientationPage — 360px and both themes', () => {
  it('renders every question at 360px', async () => {
    setViewportWidth(360);
    renderPage();

    await screen.findByRole('heading', { level: 1, name: /let's set up your plan/i });
    expect(screen.getByLabelText(/when did you file your form n-400/i)).toBeVisible();
    expect(screen.getByLabelText(/which state or territory/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /save and continue/i })).toBeVisible();
  });

  it.each(['light', 'dark'] as const)('renders in the %s theme', async (mode) => {
    renderPage('/setup/journey', mockUser, mode);

    await screen.findByRole('heading', { level: 1, name: /let's set up your plan/i });
    expect(screen.getByRole('button', { name: /save and continue/i })).toBeVisible();
  });

  it('works at 360px in the dark theme, which is the phone case', async () => {
    setViewportWidth(360);
    const user = userEvent.setup();
    renderPage('/setup/journey', mockUser, 'dark');

    await screen.findByRole('heading', { level: 1 });
    await completeForm(user);
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    expect(await screen.findByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
  });
});

describe('OrientationPage — a learner who already answered', () => {
  it('SEEDS FROM THE STORED PROFILE, not from defaults', async () => {
    // `/setup/journey` stays mounted and reachable after orientation, so the
    // form has to render what the learner actually chose. Seeding from defaults
    // here is silent data loss: the next save writes 5 minutes and no state
    // back over their real answers.
    //
    // This is why the fields mount only after the context settles — a
    // `useState` initialiser does not re-run when its input arrives late.
    mockJourneyApi(ORIENTED_PROFILE);
    renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: /let's set up your plan/i }),
    ).toBeInTheDocument();

    expect(screen.getByLabelText(/how many minutes a day/i)).toHaveValue(15);
    expect(screen.getByLabelText(/which state or territory/i)).toHaveValue('CA');
    expect(screen.getByLabelText(/what language should we use/i)).toHaveValue('es');
    expect(screen.getByLabelText(/do you have an interview date yet/i)).toHaveValue(
      '2026-11-04',
    );
  });

  it('keeps naming their resolved test, though the filing date is never stored', async () => {
    // The filing date is an INPUT the server resolves from, not a column — so
    // the preview falls back to the profile's `testVersionCode` rather than
    // going blank and implying nothing was ever chosen.
    mockJourneyApi(ORIENTED_PROFILE);
    renderPage();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByText(/2008 Civics Test/)).toBeInTheDocument();
    expect(screen.getByLabelText(/when did you file your form n-400/i)).toHaveValue('');
  });

  it('does not force them to re-enter a filing date to save', async () => {
    mockJourneyApi(ORIENTED_PROFILE);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { level: 1 });
    await user.clear(screen.getByLabelText(/how many minutes a day/i));
    await user.type(screen.getByLabelText(/how many minutes a day/i), '20');
    await user.click(screen.getByRole('button', { name: /save and continue/i }));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0]).not.toHaveProperty('filingDate');
    expect(savedBodies[0]).toMatchObject({ dailyGoalMinutes: 20, stateCode: 'CA' });
  });
});
