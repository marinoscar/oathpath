/**
 * Home (`/`) — the journey (issue #74, epic #50).
 *
 * WHAT THESE TESTS ACTUALLY PROTECT, in order of how quietly each would break:
 *
 *  1. **The stage list is the server's.** `docs/specs/journey-shell.md` §6 puts
 *     the one declaration in the API and forbids a copy in the web app. A copy
 *     would render a perfectly convincing eight-dot path in every other test
 *     here, so the only assertion that can catch it is a NEGATIVE one: MSW
 *     serves a deliberately wrong registry — five invented stages with invented
 *     labels — and the page must render THAT. See "reads the registry from the
 *     server".
 *  2. **The Next-up card carries no copy of its own.** §4's recommender already
 *     wrote the title, the reason and the path. A `switch (kind)` in the
 *     browser would agree with the server today and diverge the first time
 *     either side is reworded, with both still rendering something plausible.
 *     Asserted by serving deliberately non-standard strings for a `kind` and
 *     requiring those on screen.
 *  3. **The honesty rule, §10.** The goal ring must show NO DIGIT — not
 *     `dailyGoal.minutes`, and certainly not a fabricated `0`. A zero on a ring
 *     is indistinguishable, to the learner reading it, from a real zero.
 *  4. **The countdown is not recomputed in the browser.** §4.4. Asserted by
 *     serving a `daysUntilInterview` that disagrees with `interviewDate` and
 *     requiring the server's number.
 *  5. **The journey is a list with state for a screen reader**, not eight
 *     decorative dots.
 *  6. **Nothing flashes.** No stage, no countdown and no card may appear before
 *     both reads settle.
 *
 * The spec's own copy is READ OUT OF THE SPEC rather than restated, the
 * technique `JourneyStubPages.test.tsx` and `destinations.test.ts` both use: a
 * hand-copied expectation drifts the first time the spec is edited, which is
 * the exact moment the assertion is supposed to fire.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { render, mockUser, mockAdminUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import { server } from '../mocks/server';
import {
  ALTERNATE_STAGES,
  JOURNEY_STAGES,
  NEXT_ACTIONS,
  homeResponse,
} from '../utils/journey-fixtures';
import HomePage from '../../pages/HomePage';
import { UserMenu } from '../../components/navigation/UserMenu';
import {
  CONSOLE_DESTINATION,
  RAIL_PINNED_DESTINATIONS,
  SETTINGS_DESTINATION,
} from '../../config/destinations';
import type { JourneyHome, JourneyStage, NextAction } from '../../types';

const API_BASE = '*/api';
const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '../../../../../docs/specs/journey-shell.md');
const APP_TSX = resolve(HERE, '../../App.tsx');
const SRC = resolve(HERE, '../..');

const PHONE = 360;
const SM = 600;

/** Serve one home payload and one stage registry for the next render. */
function serveJourney(
  home: Partial<JourneyHome> = {},
  stages: JourneyStage[] = JOURNEY_STAGES,
): void {
  server.use(
    http.get(`${API_BASE}/journey/home`, () =>
      HttpResponse.json({ data: homeResponse(home) }),
    ),
    http.get(`${API_BASE}/journey/stages`, () =>
      HttpResponse.json({ data: stages }),
    ),
  );
}

/** Wait for the two reads to settle, so no assertion runs against the spinner. */
async function renderHome(options: Parameters<typeof render>[1] = {}) {
  const result = render(<HomePage />, options);
  await waitFor(() =>
    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument(),
  );
  return result;
}

/**
 * The quoted strings inside one `### N.N` section of the spec,
 * whitespace-collapsed. The spec wraps its copy across lines and the prose
 * around it is unquoted, so `"…"` is what separates the two.
 */
function specQuotes(heading: string): string[] {
  const source = readFileSync(SPEC, 'utf8');
  const section = source.split(`### ${heading}`)[1]?.split('###')[0] ?? '';
  const quotes = [...section.matchAll(/"([^"]+)"/g)].map((match) =>
    match[1].replace(/\s+/g, ' ').trim(),
  );
  // Guards the parser: a silently-empty list would make every assertion that
  // uses it pass vacuously, which is the failure this approach exists to avoid.
  expect(quotes.length, `no quoted copy found in spec §${heading}`).toBeGreaterThan(0);
  return quotes;
}

/** Every `path="…"` in the live `App.tsx`, minus the catch-all. */
function declaredRoutePaths(): string[] {
  const source = readFileSync(APP_TSX, 'utf8');
  return [
    ...new Set(
      [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1]),
    ),
  ].filter((path) => path !== '*');
}

/** The `path="…"` values in `App.tsx` whose element is a `<Navigate>`. */
function redirectRoutePaths(): string[] {
  const source = readFileSync(APP_TSX, 'utf8');
  return [
    ...source.matchAll(/path="([^"]+)"\s*\n?\s*element=\{<Navigate/g),
  ].map((match) => match[1]);
}

afterEach(() => {
  // The `theme_mode` key is read by `ThemeContextProvider` on mount and the
  // localStorage mock in `setup.ts` is not cleared between tests, so a dark
  // theme set here would leak into every suite that runs after it.
  window.localStorage.removeItem('theme_mode');
});

// =============================================================================
// 1. Home is the journey, and nothing the old dashboard reached is unreachable
// =============================================================================

describe('HomePage — the starter dashboard is gone', () => {
  // Until #74 this page was the starter template's dashboard: a
  // `UserProfileCard` and a `QuickActions` shortcut grid. #74 took them off the
  // page; #188 deleted both components, since nothing else ever mounted them.
  //
  // The assertions that only restated the deletion went with them. Two remain,
  // and neither depends on those components having existed:
  //
  //  - Home must not GROW an identity panel back. The auth context is right
  //    there, so rendering the user's email and roles here is a live
  //    possibility, not a hypothetical one — this is the only assertion in the
  //    suite that says home is about the journey and not about the account.
  //  - Every destination the dashboard offered must still be reachable. That
  //    was true before the components were deleted and it is what deleting
  //    them was allowed to rest on, so it is the assertion that must not rot.
  //
  // Deliberately NOT asserted any more: that home renders no "Quick actions"
  // heading, no "Member since" line and no "Account Settings" button, and that
  // `HomePage.tsx` imports neither component. Those markers had exactly one
  // source in the codebase and that source is gone, so nothing can make them
  // fail; an import of a module that no longer exists fails `tsc` and the
  // resolver long before it reaches a test.

  it('does not grow an identity panel back', async () => {
    await renderHome({ wrapperOptions: { user: mockAdminUser } });

    // The email and the role chips were the old card's payload, and every one
    // of them is in `useAuth()` on this page. Home is about the journey;
    // identity lives in the AppBar's user menu and on `/settings/profile`.
    expect(screen.queryByText(mockAdminUser.email)).not.toBeInTheDocument();
    expect(screen.queryByText('admin')).not.toBeInTheDocument();
  });

  it('leaves both removed destinations reachable elsewhere', async () => {
    // The dashboard's shortcut grid offered exactly two destinations, and
    // deleting it was only safe because neither is orphaned: Settings is the
    // user menu's one navigation row, and Console is the rail's pinned entry.
    render(<UserMenu />);
    await userEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByRole('menuitem', { name: SETTINGS_DESTINATION.label }),
    ).toBeInTheDocument();
    // The user menu also carries the identity the profile card displayed.
    expect(screen.getByText(mockUser.email)).toBeInTheDocument();
    expect(screen.getByText(mockUser.displayName!)).toBeInTheDocument();

    expect(RAIL_PINNED_DESTINATIONS).toContainEqual(CONSOLE_DESTINATION);

    // And the profile card's editable half is a real, mounted route.
    expect(declaredRoutePaths()).toContain('/settings/profile');
  });
});

// =============================================================================
// 2. The stage path — the assertion the whole one-registry rule rests on
// =============================================================================

describe('HomePage — the journey path', () => {
  it('renders the eight stages the API sends, with the learner’s marked', async () => {
    serveJourney({ stage: 'oriented' });
    await renderHome();

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(JOURNEY_STAGES.length);

    // Every stage is named in the accessible tree at every width — the dots
    // carry no text, so hiding the labels from sight must not hide them from a
    // screen reader.
    JOURNEY_STAGES.forEach((stage, index) => {
      expect(items[index]).toHaveTextContent(
        `Stage ${index + 1} of ${JOURNEY_STAGES.length}: ${stage.label}`,
      );
    });

    // Exactly one current, expressed as a step rather than by colour alone.
    const current = items.filter((item) => item.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Oriented — you are here');
    expect(items[0]).toHaveTextContent('Just starting — passed');
    expect(items[2]).toHaveTextContent('Learning — still ahead');
  });

  it('reads the registry from the server — a hardcoded list cannot pass this', async () => {
    // THE STRUCTURAL ASSERTION. The served registry is deliberately wrong: five
    // stages, none of them a real key, none of them a real label. A component
    // holding its own eight renders its own eight and fails here; a component
    // that renders what it is given renders these.
    serveJourney({ stage: 'gamma' as JourneyHome['stage'] }, ALTERNATE_STAGES);
    await renderHome();

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(ALTERNATE_STAGES.length);
    expect(items[2]).toHaveAttribute('aria-current', 'step');
    expect(items[2]).toHaveTextContent('Stage 3 of 5: Gamma stage — you are here');

    // The learner's stage is named, and described, from the served registry.
    expect(screen.getByText('Stage: Gamma stage')).toBeInTheDocument();
    expect(screen.getByText('The third invented one.')).toBeInTheDocument();

    // And not one word of the real registry leaked through.
    for (const stage of JOURNEY_STAGES) {
      expect(screen.queryByText(stage.description)).not.toBeInTheDocument();
    }
  });

  it('marks nothing when the served stage key is not in the served registry', async () => {
    // A registry/profile disagreement is a server bug, and the honest response
    // is an unmarked track — never a confidently wrong "you are here".
    serveJourney({ stage: 'not_a_stage' as JourneyHome['stage'] });
    await renderHome();

    expect(
      screen.getAllByRole('listitem').filter((i) => i.hasAttribute('aria-current')),
    ).toHaveLength(0);
    expect(screen.queryByText(/^Stage: /)).not.toBeInTheDocument();
  });

  it('declares no stage list anywhere in the web app', () => {
    // §6 forbids the duplicate specifically in `apps/web/src/config`. Checked
    // across the whole application source, minus the type-only union in
    // `types/index.ts` (a type carries no copy and no ordering) and minus the
    // test fixtures, which are what a test pretends the server said.
    const keys = JOURNEY_STAGES.map((stage) => stage.key);
    const files = [
      'config/destinations.ts',
      'pages/HomePage.tsx',
      'components/journey/JourneyPath.tsx',
      'hooks/useJourneyHome.ts',
    ];

    for (const file of files) {
      const source = readFileSync(resolve(SRC, file), 'utf8');
      // Comments are prose about the design and may legitimately name a stage.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      for (const key of keys) {
        expect(code, `${file} hardcodes the stage key "${key}"`).not.toContain(
          `'${key}'`,
        );
      }
      for (const stage of JOURNEY_STAGES) {
        expect(code, `${file} hardcodes the stage label "${stage.label}"`).not.toContain(
          stage.label,
        );
      }
    }
  });
});

// =============================================================================
// 3. The Next-up card — one per kind, and no local copy
// =============================================================================

describe('HomePage — the Next-up card', () => {
  const KINDS: NextAction['kind'][] = [
    'orientation',
    'interview_countdown',
    'explore',
  ];

  it.each(KINDS)('renders the server’s %s action verbatim', async (kind) => {
    const nextAction = NEXT_ACTIONS[kind];
    serveJourney({ nextAction });
    await renderHome();

    expect(screen.getByText(nextAction.title)).toBeInTheDocument();
    expect(screen.getByText(nextAction.reason)).toBeInTheDocument();

    const link = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === nextAction.path);
    expect(link, `no link to ${nextAction.path}`).toBeDefined();
  });

  it.each(KINDS)('points %s at a route that exists and does not redirect', (kind) => {
    // §4.1's invariant: a `nextAction` must never point at a route that
    // redirects to `/`. Checked against the LIVE route table rather than by
    // eye, so a route renamed or turned into a redirect fails here.
    const { path } = NEXT_ACTIONS[kind];

    expect(declaredRoutePaths()).toContain(path);
    expect(redirectRoutePaths()).not.toContain(path);
  });

  it('renders whatever the server says, not a local table keyed on kind', async () => {
    // Deliberately NOT the recommender's wording. A card with its own
    // `switch (kind)` would render the real strings and fail here — which is
    // the only way that failure is visible, since both are plausible.
    serveJourney({
      nextAction: {
        kind: 'explore',
        title: 'A title the recommender has never produced',
        reason: 'A reason invented purely by this test.',
        path: '/practice',
      },
    });
    await renderHome();

    expect(
      screen.getByText('A title the recommender has never produced'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('A reason invented purely by this test.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(NEXT_ACTIONS.explore.title)).not.toBeInTheDocument();
  });

  it('names the button after the destination it leads to', async () => {
    // The label comes from `config/destinations.ts`, so the button and the nav
    // row the learner lands on cannot disagree about what the place is called
    // — and E3 re-pointing the countdown at `/practice` changes it for free.
    serveJourney({ nextAction: NEXT_ACTIONS.explore });
    const { unmount } = await renderHome();
    expect(screen.getByRole('link', { name: 'Go to Learn' })).toHaveAttribute(
      'href',
      '/learn',
    );
    unmount();

    // `/setup/journey` is owned by no destination — it is not a place in the
    // bar — so it falls through to an honest generic label.
    serveJourney({ nextAction: NEXT_ACTIONS.orientation });
    await renderHome();
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      '/setup/journey',
    );
  });
});

// =============================================================================
// 4. The interview countdown
// =============================================================================

describe('HomePage — the interview countdown', () => {
  it('shows the server’s day count when a date is set', async () => {
    serveJourney({ interviewDate: '2026-11-04', daysUntilInterview: 12 });
    await renderHome();

    expect(screen.getByText('12 days to go')).toBeInTheDocument();
    // The date is named from its `YYYY-MM-DD` parts, in UTC, so a learner west
    // of Greenwich is not shown the day before the one they entered.
    expect(screen.getByText(/November 4, 2026/)).toBeInTheDocument();
  });

  it('never recomputes the count in the browser', async () => {
    // §4.4: the count is a whole-calendar-day figure from the API's `Clock`, in
    // the learner's own timezone. Serving a count that disagrees with the date
    // is the only way to tell a component that renders the server's answer from
    // one that quietly divides a timestamp difference by 86 400 000.
    serveJourney({
      interviewDate: '2026-11-04',
      daysUntilInterview: 3,
      // The countdown `nextAction`'s own title carries the server's day count
      // too; `explore` keeps this assertion about the countdown widget alone.
      nextAction: NEXT_ACTIONS.explore,
    });
    await renderHome();

    const region = within(screen.getByRole('region', { name: 'Your interview' }));
    expect(region.getByText('3 days to go')).toBeInTheDocument();
    expect(region.queryByText(/12/)).not.toBeInTheDocument();
  });

  it('agrees with itself about one day', async () => {
    serveJourney({ daysUntilInterview: 1 });
    await renderHome();

    expect(screen.getByText('1 day to go')).toBeInTheDocument();
  });

  it('says so when the interview is today', async () => {
    // Zero is a real, correct answer here — nothing like the fabricated zero
    // the goal ring refuses.
    serveJourney({ daysUntilInterview: 0, interviewPast: false });
    await renderHome();

    expect(screen.getByText('Your interview is today')).toBeInTheDocument();
  });

  it('does not count up from a past date', async () => {
    // We do not know how the interview went. "Your interview was 12 days ago"
    // is a claim dressed as a status — §10's shape of fabricated confidence.
    serveJourney({
      interviewDate: '2026-08-01',
      daysUntilInterview: -32,
      interviewPast: true,
    });
    await renderHome();

    expect(screen.getByText(/interview date has passed/i)).toBeInTheDocument();
    expect(screen.queryByText(/32/)).not.toBeInTheDocument();
    expect(screen.queryByText(/-32/)).not.toBeInTheDocument();
  });

  it('invites a date when there is none, and links where one is set', async () => {
    serveJourney({
      interviewDate: null,
      daysUntilInterview: null,
      interviewPast: false,
      nextAction: NEXT_ACTIONS.explore,
    });
    await renderHome();

    expect(screen.getByText(/no interview date yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/to go$/)).not.toBeInTheDocument();

    // `/settings/journey` is the `Your plan` card #77 shipped — a real route,
    // not a `#`-fragment into a hub of separate routes.
    const invite = screen.getByRole('link', { name: /add your interview date/i });
    expect(invite).toHaveAttribute('href', '/settings/journey');
    expect(declaredRoutePaths()).toContain('/settings/journey');
  });
});

// =============================================================================
// 5. The goal ring — the honesty rule, enforced rather than remembered
// =============================================================================

describe('HomePage — the goal-ring placeholder', () => {
  it('renders §9.2’s copy', async () => {
    await renderHome();

    const ring = screen.getByTestId('daily-goal');
    for (const quote of specQuotes('9.2')) {
      // The spec punctuates its label as a sentence ("Not tracked yet."); the
      // mockups render it without the period. The WORDING is what is asserted.
      const words = quote.replace(/\.$/, '');
      expect(
        within(ring).getByText(new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
        `the ring does not carry §9.2's copy: ${words.slice(0, 40)}…`,
      ).toBeInTheDocument();
    }
  });

  it('contains no digit at all — not a goal, not a zero', async () => {
    // §10. `dailyGoal.minutes` is 15 in the fixture and `tracked` is false. A
    // "15" here reads as a measurement rather than as a setting, and a "0"
    // reads as a real, terrible day. Neither may appear.
    serveJourney({ dailyGoal: { minutes: 15, tracked: false } });
    await renderHome();

    const ring = screen.getByTestId('daily-goal');
    expect(ring.textContent ?? '').not.toMatch(/\d/);
  });

  it('claims no progressbar role it cannot fill in', async () => {
    // There is no value, so there is no `aria-valuenow` that could honestly be
    // supplied — and a `progressbar` with no value announces as an
    // indeterminate one, which is a different lie.
    await renderHome();

    const ring = screen.getByTestId('daily-goal');
    expect(within(ring).queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

// =============================================================================
// 6. The trust footer
// =============================================================================

describe('HomePage — the trust footer', () => {
  it('renders §9.3’s sentence verbatim', async () => {
    await renderHome();

    const [sentence] = specQuotes('9.3');
    expect(
      screen.getByText(sentence, { collapseWhitespace: true }),
      'the trust footer has been reworded',
    ).toBeInTheDocument();
  });

  it('stays visible while the journey is loading', async () => {
    const [sentence] = specQuotes('9.3');
    render(<HomePage />);

    // Asserted BEFORE the reads settle: §9.3 says "always visible on Home",
    // and it is as true during a load as after one.
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
    expect(screen.getByText(sentence, { collapseWhitespace: true })).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument(),
    );
  });

  it('stays visible when the journey cannot be loaded', async () => {
    server.use(
      http.get(`${API_BASE}/journey/home`, () => new HttpResponse(null, { status: 500 })),
    );
    const [sentence] = specQuotes('9.3');
    await renderHome();

    expect(screen.getByText(sentence, { collapseWhitespace: true })).toBeInTheDocument();
  });
});

// =============================================================================
// 7. Loading and failure — neither may look like a finished journey
// =============================================================================

describe('HomePage — loading and failure', () => {
  it('shows no stage, card or countdown before both reads settle', async () => {
    render(<HomePage />);

    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
    // A half-painted journey — dots with none marked, a card with no stage
    // behind it — is indistinguishable from a finished one.
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByText(/next up/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/to go$/)).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(8));
  });

  it('says the journey could not be loaded, and invents nothing in its place', async () => {
    server.use(
      http.get(`${API_BASE}/journey/stages`, () => new HttpResponse(null, { status: 503 })),
    );
    await renderHome();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn’t load your journey/i,
    );
    // No fallback registry, no guessed countdown, no ring.
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByTestId('daily-goal')).not.toBeInTheDocument();
    expect(screen.queryByText(/days to go/)).not.toBeInTheDocument();
  });

  it('offers a retry that actually re-reads', async () => {
    let attempt = 0;
    server.use(
      http.get(`${API_BASE}/journey/stages`, () => {
        attempt += 1;
        return attempt === 1
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ data: JOURNEY_STAGES });
      }),
    );
    await renderHome();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(8));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// =============================================================================
// 8. Structure, width and theme
// =============================================================================

describe('HomePage — structure, width and theme', () => {
  it('has exactly one h1, above every section heading', async () => {
    await renderHome();

    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(/welcome back/i);

    // Each region names itself, and every name is an h2 — no level is skipped
    // and no region is left anonymous.
    const h2s = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(h2s).toEqual(['Where you are', 'Next up', 'Your interview', 'Daily goal']);
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  it('gives every region an accessible name', async () => {
    await renderHome();

    const named = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-labelledby'));
    expect(named.every(Boolean)).toBe(true);
    expect(named.length).toBe(4);
  });

  it('renders the whole page at 360px and unchanged across the sm boundary', async () => {
    setViewportWidth(PHONE);
    const { container } = await renderHome();
    const atPhone = container.textContent;

    // Nothing on this page is width-gated: a phone that hid the countdown or
    // the trust footer would hide the two things the learner most needs.
    await act(async () => setViewportWidth(SM - 1));
    expect(container.textContent).toBe(atPhone);

    await act(async () => setViewportWidth(SM));
    expect(container.textContent).toBe(atPhone);
  });

  it('renders the same content in the dark theme at 360px', async () => {
    setViewportWidth(PHONE);
    const { container: light, unmount } = await renderHome();
    const inLight = light.textContent;
    unmount();

    window.localStorage.setItem('theme_mode', 'dark');
    const { container: dark } = await renderHome({ wrapperOptions: { theme: 'dark' } });

    expect(dark.textContent).toBe(inLight);
    expect(screen.getAllByRole('listitem').length).toBe(JOURNEY_STAGES.length);
  });

  it('names no literal colour in any journey widget', () => {
    // jsdom performs no layout and MUI resolves the palette at render, so a
    // hardcoded `#1f2937` (the mockups' ink) would pass every test above and be
    // unreadable in the dark theme in a real browser. The source is the only
    // place that difference is visible.
    const files = [
      'components/journey/JourneyPath.tsx',
      'components/journey/NextUpCard.tsx',
      'components/journey/InterviewCountdown.tsx',
      'components/journey/DailyGoalRing.tsx',
      'components/journey/TrustFooter.tsx',
      'pages/HomePage.tsx',
    ];

    for (const file of files) {
      const source = readFileSync(resolve(SRC, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      expect(code, `${file} hardcodes a colour`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(code, `${file} hardcodes a colour`).not.toMatch(/\brgba?\(/);
    }
  });

  it('steps at sm and never at md', () => {
    // `CLAUDE.md`'s five coupled gates sit at 600px. This page does not touch
    // any of them, and its own responsive values must agree rather than
    // introduce a second boundary at 900px.
    const files = [
      'pages/HomePage.tsx',
      'components/journey/JourneyPath.tsx',
      'components/journey/NextUpCard.tsx',
      'components/journey/InterviewCountdown.tsx',
      'components/journey/DailyGoalRing.tsx',
      'components/journey/TrustFooter.tsx',
    ];

    for (const file of files) {
      const source = readFileSync(resolve(SRC, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      // `maxWidth="md"` on the Container is a measure, not a breakpoint gate.
      const gates = code.replace(/maxWidth="md"/g, '');
      expect(gates, `${file} gates at md`).not.toMatch(/\bmd:\s/);
    }
  });
});
