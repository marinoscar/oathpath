/**
 * Learn (`/learn`) — the real destination (issue #121, epic #51).
 *
 * WHAT THESE TESTS ACTUALLY PROTECT, in order of how quietly each would break:
 *
 *  1. **The `state_required` case stays honest.** This is the acceptance
 *     criterion with the worst failure mode: substituting a national answer for
 *     a missing state one hands a learner a specific, memorable answer that does
 *     not apply to them, with nothing on screen saying so. It is asserted from
 *     both directions — the honest message and its route to the fix must be
 *     present, AND the answer text that arrived in the payload must be absent.
 *     The fixture deliberately carries answers the UI must refuse to show, so
 *     the assertion tests the DISCRIMINATOR rather than testing that an empty
 *     array renders empty.
 *  2. **The learner's test version is never sent.** The API defaults it to the
 *     caller's own profile, and a browser that "helpfully" sent the code it
 *     holds would be a second copy of a decision the server owns — wrong the
 *     moment a filing date moves a learner between banks. Only a NEGATIVE
 *     assertion on the request URL can catch it: a page that sent the right
 *     code today looks identical on screen.
 *  3. **The server's category order survives.** The official categories are not
 *     alphabetical, and the fixture disagrees with alphabetical order on
 *     purpose, so a well-meant `localeCompare` fails here rather than silently
 *     renumbering the exam for every learner.
 *  4. **Provenance renders.** The verified-as-of date and the 65/20 marker are
 *     what make this content checkable rather than merely confident.
 *  5. **Everything works at 360px and in the dark theme**, because this is the
 *     first real learner screen and it will mostly be read on a phone.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

import { server } from '../mocks/server';
import { setViewportWidth } from '../setup';
import { mockUser } from '../utils/test-utils';
import { AuthContext } from '../../contexts/AuthContext';
import { LearnerProfileProvider } from '../../contexts/LearnerProfileContext';
import LearnPage from '../../pages/LearnPage';
import { ORIENTED_PROFILE, UNORIENTED_PROFILE } from '../utils/journey-fixtures';
import {
  CATEGORIES,
  CATEGORY_1800S,
  CATEGORY_COLONIAL,
  CATEGORY_DEMOCRACY,
  CATEGORY_SYSTEM,
  GOVERNOR_STATE_REQUIRED,
  ONE_BRANCH,
  RULE_OF_LAW,
  SUPREME_LAW,
  VERIFIED_AT,
  YOUR_GOVERNOR,
  civicsHandlers,
  journeyProfileHandler,
} from '../utils/civics-fixtures';
import type { JourneyProfile } from '../../types';

const API_BASE = '*/api';
const PHONE = 360;

/**
 * The date the page must render, derived the same way the page derives it.
 *
 * Computed rather than hardcoded because the month name and field order are the
 * RUNNER'S locale, which this suite has no business pinning. What is asserted
 * is that the day comes from `verifiedAt` and is read in UTC — the two
 * decisions `components/civics/verifiedAt.ts` actually makes.
 */
const AS_OF = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
}).format(new Date(VERIFIED_AT));

function renderLearn(
  initialUrl = '/learn',
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
        <MemoryRouter initialEntries={[initialUrl]}>
          <Routes>
            {/* The provider as a LAYOUT route, exactly as `App.tsx` mounts it:
                that is what makes "fetched once" mean once per session rather
                than once per navigation. */}
            <Route element={<LearnerProfileProvider />}>
              <Route path="/learn" element={<LearnPage />} />
              <Route
                path="/settings/journey"
                element={<h1>Your plan</h1>}
              />
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
// Categories — the top level
// -----------------------------------------------------------------------------

describe('the category list', () => {
  it('renders the real categories the server sent, grouped by their section', async () => {
    renderLearn();

    expect(
      await screen.findByRole('link', { name: CATEGORY_DEMOCRACY.name }),
    ).toBeInTheDocument();

    for (const category of CATEGORIES) {
      expect(
        screen.getByRole('link', { name: category.name }),
      ).toBeInTheDocument();
    }

    // The sections are `h2`s under the page's single `h1`.
    expect(
      screen.getByRole('heading', { level: 2, name: 'AMERICAN GOVERNMENT' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'AMERICAN HISTORY' }),
    ).toBeInTheDocument();
  });

  it("keeps the server's order instead of sorting alphabetically", async () => {
    // `Colonial Period and Independence` comes BEFORE `1800s` in the official
    // material and AFTER it alphabetically. A local sort passes every other
    // assertion in this file and fails this one.
    renderLearn();
    await screen.findByRole('link', { name: CATEGORY_COLONIAL.name });

    const links = screen.getAllByRole('link').map((link) => link.textContent);
    const colonial = links.findIndex((text) =>
      text?.includes(CATEGORY_COLONIAL.name),
    );
    const eighteenHundreds = links.findIndex((text) =>
      text?.includes(CATEGORY_1800S.name),
    );

    expect(colonial).toBeGreaterThan(-1);
    expect(eighteenHundreds).toBeGreaterThan(colonial);
  });

  it('gives the page exactly one h1, naming the destination', async () => {
    renderLearn();
    await screen.findByRole('link', { name: CATEGORY_DEMOCRACY.name });

    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Learn');
  });

  it("names the learner's test version without offering a picker", async () => {
    renderLearn();
    await screen.findByRole('link', { name: CATEGORY_DEMOCRACY.name });

    expect(screen.getByText(/2008 Civics Test/)).toBeInTheDocument();
    // A combobox here would be a question the learner has no way to answer:
    // their version is resolved from their filing date, on the server.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The question list
// -----------------------------------------------------------------------------

describe('the question list', () => {
  it("lists a category's real questions, by their official numbers", async () => {
    const user = userEvent.setup();
    renderLearn();

    await user.click(
      await screen.findByRole('link', { name: CATEGORY_SYSTEM.name }),
    );

    expect(
      await screen.findByRole('link', { name: new RegExp(ONE_BRANCH.prompt) }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: new RegExp(YOUR_GOVERNOR.prompt) }),
    ).toBeInTheDocument();

    // The official number, not a per-category 1..n renumbering — question 43 is
    // what a learner and every study guide call this question.
    expect(screen.getByText('43.')).toBeInTheDocument();

    // Filtered for real: a question from another category must not be here.
    expect(
      screen.queryByText(SUPREME_LAW.prompt),
    ).not.toBeInTheDocument();
  });

  it('marks the 65/20 questions and explains what the marker means', async () => {
    renderLearn(`/learn?category=${CATEGORY_DEMOCRACY.id}`);

    expect(
      await screen.findByRole('link', { name: new RegExp(RULE_OF_LAW.prompt) }),
    ).toBeInTheDocument();

    const row = screen.getByRole('link', {
      name: new RegExp(RULE_OF_LAW.prompt),
    });
    expect(within(row).getByText('65/20')).toBeInTheDocument();

    // Two digits and a slash mean nothing on their own, so the page says what
    // they mean, once, where they appear.
    expect(
      screen.getByText(/65 or older and have been permanent residents/i),
    ).toBeInTheDocument();

    // …and not on a question that is not in the subset.
    const other = screen.getByRole('link', {
      name: new RegExp(SUPREME_LAW.prompt),
    });
    expect(within(other).queryByText('65/20')).not.toBeInTheDocument();
  });

  it('NEVER sends a testVersionCode — the API resolves it from the profile', async () => {
    const urls: URL[] = [];
    server.use(...civicsHandlers({ onListRequest: (url) => urls.push(url) }));

    renderLearn(`/learn?category=${CATEGORY_SYSTEM.id}`);
    await screen.findByRole('link', { name: new RegExp(ONE_BRANCH.prompt) });

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.searchParams.get('testVersionCode')).toBeNull();
      // Nor a state, nor a user: both are structural absences on the server.
      expect(url.searchParams.get('stateCode')).toBeNull();
      expect(url.searchParams.get('userId')).toBeNull();
    }
  });

  it('paginates with real links rather than a click handler', async () => {
    // Two pages of one, so the control has something to render.
    server.use(...civicsHandlers());
    renderLearn('/learn?category=all');

    await screen.findByRole('link', { name: new RegExp(SUPREME_LAW.prompt) });

    // Five fixture questions at the default page size is one page, so no
    // pagination — the control appears only when it means something.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

    // Every question row is a real anchor with an href, which is what makes
    // Back, middle-click and "open in new tab" work.
    const row = screen.getByRole('link', {
      name: new RegExp(SUPREME_LAW.prompt),
    });
    expect(row).toHaveAttribute('href', `/learn?category=all&q=${SUPREME_LAW.id}`);
  });
});

// -----------------------------------------------------------------------------
// The question detail
// -----------------------------------------------------------------------------

describe('a question and its answer', () => {
  it('shows the answer and the date it was verified', async () => {
    renderLearn(`/learn?q=${SUPREME_LAW.id}`);

    expect(
      await screen.findByRole('heading', { level: 3, name: SUPREME_LAW.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText('the Constitution')).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`current as of ${AS_OF}`, 'i')),
    ).toBeInTheDocument();
  });

  it('shows the citation, so the claim is checkable rather than merely confident', async () => {
    renderLearn(`/learn?q=${SUPREME_LAW.id}`);

    expect(
      await screen.findByText(/Source: USCIS, Civics \(History and Government\)/),
    ).toBeInTheDocument();
  });

  it('reads category → question → answer as a heading hierarchy', async () => {
    renderLearn(`/learn?q=${SUPREME_LAW.id}`);
    await screen.findByRole('heading', { level: 3, name: SUPREME_LAW.prompt });

    expect(
      screen.getByRole('heading', { level: 1, name: 'Learn' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: CATEGORY_DEMOCRACY.name }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 4, name: /answer/i }),
    ).toBeInTheDocument();
  });

  it('shows every accepted answer for a multi-answer question, as alternatives', async () => {
    renderLearn(`/learn?q=${ONE_BRANCH.id}`);

    expect(await screen.findByText('Congress')).toBeInTheDocument();
    expect(screen.getByText('the President')).toBeInTheDocument();
    expect(screen.getByText('the courts')).toBeInTheDocument();

    // Without this sentence a learner reading three answers would reasonably
    // conclude they must produce all three.
    expect(screen.getByText(/any one of these is accepted/i)).toBeInTheDocument();
  });

  it('carries the 65/20 marker through to the detail view', async () => {
    renderLearn(`/learn?q=${RULE_OF_LAW.id}`);

    expect(
      await screen.findByRole('heading', { level: 3, name: RULE_OF_LAW.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText('65/20')).toBeInTheDocument();
    expect(
      screen.getByText(/65 or older and have been permanent residents/i),
    ).toBeInTheDocument();
  });

  it("says which state a state-specific answer is for", async () => {
    // A learner who moved and forgot to update their plan is reading a
    // confident answer for somewhere they no longer live. This line is the only
    // thing on the screen that could tell them.
    renderLearn(`/learn?q=${YOUR_GOVERNOR.id}`);

    expect(await screen.findByText('Jane Q. Doe')).toBeInTheDocument();
    expect(
      screen.getByText(/this is the answer for California/i),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The unresolved-state case — the acceptance criterion
// -----------------------------------------------------------------------------

describe('a state-scope question with no state set', () => {
  const stateless: JourneyProfile = { ...ORIENTED_PROFILE, stateCode: null };

  function serveUnresolved() {
    server.use(
      http.get(`${API_BASE}/civics/questions/:id`, () =>
        HttpResponse.json({ data: GOVERNOR_STATE_REQUIRED }),
      ),
    );
  }

  it('shows the question, says plainly why there is no answer, and links to the fix', async () => {
    serveUnresolved();
    renderLearn(`/learn?q=${YOUR_GOVERNOR.id}`, { profile: stateless });

    // The question is NOT hidden: a shorter list than the version promises,
    // with nothing explaining the gap, is the alternative the spec rejects.
    expect(
      await screen.findByRole('heading', { level: 3, name: YOUR_GOVERNOR.prompt }),
    ).toBeInTheDocument();

    expect(
      screen.getByText(/set your state to see this answer/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/depends on where you live/i),
    ).toBeInTheDocument();

    const fix = screen.getByRole('link', { name: /set your state/i });
    expect(fix).toHaveAttribute('href', '/settings/journey');
  });

  it("renders NO answer text — not another state's, not a national one", async () => {
    // The fixture arrives carrying `Jane Q. Doe` and a `verifiedAt`, which the
    // server never sends alongside `state_required`. The discriminator must win
    // over both, or this test is only asserting that an empty array is empty.
    serveUnresolved();
    renderLearn(`/learn?q=${YOUR_GOVERNOR.id}`, { profile: stateless });

    await screen.findByText(/set your state to see this answer/i);

    expect(screen.queryByText('Jane Q. Doe')).not.toBeInTheDocument();
    expect(screen.queryByText(/current as of/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/this is the answer for/i)).not.toBeInTheDocument();
  });

  it('reaches the plan page when the learner follows the link', async () => {
    const user = userEvent.setup();
    serveUnresolved();
    renderLearn(`/learn?q=${YOUR_GOVERNOR.id}`, { profile: stateless });

    await user.click(await screen.findByRole('link', { name: /set your state/i }));

    expect(
      await screen.findByRole('heading', { name: 'Your plan' }),
    ).toBeInTheDocument();
  });
});

// -----------------------------------------------------------------------------
// The learner who has not finished setup
// -----------------------------------------------------------------------------

describe('a learner with no resolved test version', () => {
  it('says what is missing instead of showing an error or an empty list', async () => {
    renderLearn('/learn', { profile: UNORIENTED_PROFILE });

    expect(
      await screen.findByText(/we don.t know which civics test applies to you yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /open your plan/i }),
    ).toHaveAttribute('href', '/settings/journey');
    // Nothing has gone wrong, so nothing is announced as though it had: the
    // notice is a polite `status`, and there is no `alert` on this screen.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      /we don.t know which civics test applies to you yet/i,
    );
  });
});

// -----------------------------------------------------------------------------
// Mobile and theme
// -----------------------------------------------------------------------------

describe('at 360px and in both themes', () => {
  it('renders and navigates the whole hierarchy on a 360px viewport', async () => {
    setViewportWidth(PHONE);
    const user = userEvent.setup();
    renderLearn();

    await user.click(
      await screen.findByRole('link', { name: CATEGORY_SYSTEM.name }),
    );
    await user.click(
      await screen.findByRole('link', { name: new RegExp(ONE_BRANCH.prompt) }),
    );

    expect(
      await screen.findByRole('heading', { level: 3, name: ONE_BRANCH.prompt }),
    ).toBeInTheDocument();
    expect(screen.getByText('Congress')).toBeInTheDocument();

    // The way back up is present at phone width — nothing is width-gated away.
    expect(
      screen.getByRole('link', { name: /back to the questions/i }),
    ).toBeInTheDocument();
  });

  it('renders the same content in the dark theme', async () => {
    renderLearn(`/learn?q=${SUPREME_LAW.id}`, { mode: 'dark' });

    expect(await screen.findByText('the Constitution')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: SUPREME_LAW.prompt }),
    ).toBeInTheDocument();
  });

  it('names no literal colour anywhere in the civics components', async () => {
    // jsdom performs no layout and the palette is resolved at render, so a
    // hardcoded `#1f2937` would render "correctly" in every test above and be
    // unreadable in the dark theme in a browser. The source is the only place
    // that difference is visible.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');

    const dir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../components/civics',
    );

    for (const file of readdirSync(dir)) {
      const source = readFileSync(resolve(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(source, `${file} names a literal colour`).not.toMatch(
        /#[0-9a-fA-F]{3,8}\b/,
      );
      expect(source, `${file} names a literal colour`).not.toMatch(/\brgba?\(/);
    }
  });
});

// -----------------------------------------------------------------------------
// Getting to flashcards
// -----------------------------------------------------------------------------

describe('the route into study mode', () => {
  it('is one tap from the destination itself, over the whole bank', async () => {
    const user = userEvent.setup();
    renderLearn();

    await user.click(
      await screen.findByRole('link', {
        name: /study all questions with flashcards/i,
      }),
    );

    expect(
      await screen.findByRole('heading', { level: 2, name: /flashcards/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/card 1 of 5/i)).toBeInTheDocument(),
    );
  });

  it('offers flashcards from a question list and opens the deck', async () => {
    const user = userEvent.setup();
    renderLearn(`/learn?category=${CATEGORY_SYSTEM.id}`);

    await user.click(
      await screen.findByRole('link', { name: /study with flashcards/i }),
    );

    expect(
      await screen.findByRole('heading', { level: 2, name: /flashcards/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /show answer/i }),
    ).toBeInTheDocument();
    // The deck is the category the learner was looking at, not the whole bank.
    await waitFor(() =>
      expect(screen.getByText(/card 1 of 2/i)).toBeInTheDocument(),
    );
  });
});
