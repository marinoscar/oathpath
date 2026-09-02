import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { loginAsTestUser, seedOnboarding } from '../helpers/auth.helper';

// =============================================================================
// journey-shell.spec.ts — issue #85, epic #50
// =============================================================================
//
// Exercises the seams `docs/specs/journey-shell.md` describes rather than
// re-testing what the API integration specs already cover:
//
//   - `RequireOrientation` (§5) actually blocks every route except the one it
//     is supposed to, and releases the moment orientation is saved.
//   - Home (§9) renders the server's own stage, next action and interview
//     countdown — not a fabricated or guessed one (§10).
//   - The four-destination bar (§2) really does render on both surfaces the
//     `sm` breakpoint switches between.
//   - `/settings/journey` (#77) round-trips the same profile orientation
//     wrote.
//   - The admin exemption (§5, exemption 3) actually holds for an
//     administrator who has never filled in orientation.
//
// Every selector below is read out of the shipped component it targets, not
// invented — see the PR/report for the file and line each one came from.
//
// A fresh, random email per test avoids two tests racing to
// `POST /api/auth/test/login` for the same address when Playwright runs them
// in parallel (`playwright.config.ts`'s `fullyParallel: true`).
function testEmail(label: string): string {
  return `journey-shell-${label}-${randomUUID()}@test.local`;
}

test.describe('Orientation gate (docs/specs/journey-shell.md §5)', () => {
  // Fixed so `JourneyProfileForm`'s `detectTimezone()` — which reads
  // `Intl.DateTimeFormat().resolvedOptions().timeZone` at submit time,
  // apps/web/src/components/journey/JourneyProfileForm.tsx:182-191 — submits
  // a known IANA zone, and so `formatInterviewDate`'s
  // `toLocaleDateString(undefined, ...)` (InterviewCountdown.tsx:80) renders
  // in a known locale.
  test.use({ timezoneId: 'America/Los_Angeles', locale: 'en-US' });

  test('blocks every route until orientation is complete, then Home reflects the saved answers', async ({
    page,
  }) => {
    // 'ai-key-only': RequireAiKey (#39) is cleared but RequireOrientation
    // (#72) is not, so orientation is genuinely reached rather than skipped
    // — tests/e2e/helpers/seed-onboarding.ts's whole reason for this level.
    await seedOnboarding(page, {
      email: testEmail('gate'),
      onboarding: 'ai-key-only',
    });

    // 1. Routed to /setup/journey.
    await expect(page).toHaveURL('/setup/journey');

    // 2. Cannot navigate away: each of these is inside RequireOrientation in
    // App.tsx (Home, /learn under the bar destinations, /settings the hub),
    // and every one bounces straight back.
    for (const blocked of ['/', '/learn', '/settings']) {
      await page.goto(blocked);
      await expect(page).toHaveURL('/setup/journey');
    }

    // Land back on the setup screen via a plain navigation (no router
    // `state`), so OrientationPage's `destination` — read from
    // `location.state?.from?.pathname` (OrientationPage.tsx:71-73) — falls
    // through to its `?? '/'` default instead of resuming whichever blocked
    // route was tried last above.
    await page.goto('/setup/journey');

    // Pin the server's clock (apps/api/src/common/clock/test-clock.middleware.ts)
    // so the interview countdown asserted below is a fixed day count rather
    // than one computed from today's real date. Set on the PAGE, so it rides
    // along on every `fetch` the React app itself makes
    // (apps/web/src/services/api.ts:48) — `services/api.ts` never touches
    // `page.request`, which is the separate context used by
    // `seedOnboarding` above and is unaffected by this header.
    const pinnedNow = '2026-01-01T12:00:00Z';
    await page.setExtraHTTPHeaders({ 'X-Test-Clock': pinnedNow });

    // 3. Complete orientation — filing date, interview date, state; daily
    // goal and explanation language keep JourneyProfileForm's own defaults
    // (5 minutes, English). Labels quoted verbatim from
    // JourneyProfileForm.tsx's fields 1, 3 and 4 (docs/specs/journey-shell.md §7).
    const filingDate = '2020-01-15'; // Before the 2025-10-20 cutoff -> v2008.
    const interviewDate = '2026-01-15';
    await page
      .getByLabel('When did you file your Form N-400?')
      .fill(filingDate);
    await page
      .getByLabel('Do you have an interview date yet? (Optional)')
      .fill(interviewDate);
    await page
      .getByLabel('Which state or territory do you live in?')
      .selectOption('CA');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // Orientation hands off to Home (OrientationPage.tsx:81, `?? '/'`).
    await expect(page).toHaveURL('/');

    // `pinnedNow` is 2026-01-01 in America/Los_Angeles (noon UTC, so nowhere
    // near a local midnight boundary); the interview is 2026-01-15. Both
    // JourneyService.daysUntil and JourneyService.dayIndexOf
    // (apps/api/src/journey/journey.service.ts) reduce each side to a
    // calendar-day integer and subtract, so the expected count is the plain
    // calendar difference: 14 days, independent of when this suite runs.
    const expectedDays = 14;

    // 4a. Stage reads Oriented — JourneyPath.tsx's Chip,
    // `label={`Stage: ${current.label}`}` (JourneyPath.tsx:181), where
    // `current.label` is the API's own registry copy
    // ("Oriented", journey-shell.md §1).
    await expect(page.getByText('Stage: Oriented')).toBeVisible();

    // 4b. A next action is present, with the exact title
    // `next-action.ts`'s `countdownTitle` produces for 14 days
    // (apps/api/src/journey/next-action.ts:180-188), and its link resolves.
    await expect(
      page.getByText(`${expectedDays} days until your interview`),
    ).toBeVisible();

    // NextUpCard's button label is derived from the destination registry,
    // not from `kind` — "Go to Learn" for `path: '/learn'`
    // (NextUpCard.tsx:110-114, actionLabel + config/destinations.ts's
    // `learn` destination, label: 'Learn').
    const nextActionLink = page.getByRole('link', { name: 'Go to Learn' });
    await expect(nextActionLink).toHaveAttribute('href', '/learn');
    await nextActionLink.click();

    // Following it must not land back on Home via the catch-all — assert
    // both the URL and Learn's own `h1`
    // (DestinationEmptyState.tsx: "the page's single h1", title prop
    // "Learn" from LearnPage.tsx:19).
    await expect(page).toHaveURL('/learn');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Learn' }),
    ).toBeVisible();

    // 4c. Back on Home, InterviewCountdown shows the same clock-pinned
    // count in its own copy ("14 days to go", InterviewCountdown.tsx:157,
    // `dayCount(14)` + " to go") and the interview date, formatted through
    // UTC parts rather than the viewer's zone (InterviewCountdown.tsx:70-86,
    // `formatInterviewDate('2026-01-15')` -> "January 15, 2026").
    await page.goto('/');
    await expect(page.getByText(`${expectedDays} days to go`)).toBeVisible();
    await expect(page.getByText('January 15, 2026')).toBeVisible();
  });
});

test.describe('Four-destination navigation (docs/specs/journey-shell.md §2)', () => {
  test('renders all four bar destinations on the rail above sm and on the bottom bar below it', async ({
    page,
  }) => {
    await loginAsTestUser(page, {
      email: testEmail('nav'),
      onboarding: 'full',
    });
    await expect(page).toHaveURL('/');

    // Desktop: NavigationRail mounts (Layout.tsx's `showRail`, `up('sm')`)
    // and, at this project's >=lg viewport, renders expanded — each
    // destination a real link, `aria-label={destination.label}`
    // (NavigationRail.tsx:157, RailRow), landmark name "Main navigation"
    // (NavigationRail.tsx:351, non-console mode).
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(rail).toBeVisible();
    for (const label of ['Home', 'Learn', 'Practice', 'Progress']) {
      await expect(rail.getByRole('link', { name: label })).toBeVisible();
    }

    // Phone width: the EXACT complement (BottomNav.tsx's own `down('sm')`
    // gate, BottomNav.tsx:41) — the rail unmounts and the bottom bar
    // replaces it. `aria-label={destination.label}` on each action
    // (BottomNav.tsx:91) is the same full name the rail uses.
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(rail).toBeHidden();
    for (const label of ['Home', 'Learn', 'Practice', 'Progress']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });
});

test.describe('Settings > Your plan (issue #77, epic #50)', () => {
  test('/settings/journey loads the saved answers and a change persists across reload', async ({
    page,
  }) => {
    await loginAsTestUser(page, {
      email: testEmail('settings'),
      onboarding: 'full',
    });
    await expect(page).toHaveURL('/');

    await page.goto('/settings/journey');

    // The fixture's ORIENTATION_PROFILE (tests/e2e/helpers/seed-onboarding.ts)
    // seeds `stateCode: 'CA'` and `dailyGoalMinutes: 15` — both fields the
    // form seeds its `useState` from on first render
    // (JourneyProfileForm.tsx:268-271).
    const dailyGoal = page.getByLabel(
      'How many minutes a day do you want to aim for?',
    );
    await expect(dailyGoal).toHaveValue('15');
    await expect(
      page.getByLabel('Which state or territory do you live in?'),
    ).toHaveValue('CA');

    // A change: save it, see the shared form's own inline confirmation
    // ("Saved. Your plan is up to date.", JourneyProfileForm.tsx:615,
    // rendered because UserJourneyPage passes no `onSaved`), then reload and
    // confirm the new value survived the round trip rather than only living
    // in this tab's state.
    await dailyGoal.fill('30');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByText('Saved. Your plan is up to date.'),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByLabel('How many minutes a day do you want to aim for?'),
    ).toHaveValue('30');
  });
});

test.describe('RequireOrientation admin exemption (docs/specs/journey-shell.md §5, exemption 3)', () => {
  test('an admin with no profile can still reach /admin/settings/*', async ({
    page,
  }) => {
    // Same 'ai-key-only' level as the gate test above: this admin has never
    // seen the orientation screen at all.
    await seedOnboarding(page, {
      email: testEmail('admin'),
      role: 'admin',
      onboarding: 'ai-key-only',
    });

    // Like any other fresh account, Home redirects this admin to
    // /setup/journey — the exemption is for /admin/*, not for the rest of
    // the app.
    await expect(page).toHaveURL('/setup/journey');

    // RequireOrientation.tsx's exemption 3: `location.pathname.startsWith('/admin')
    // && hasPermission('system_settings:read')` lets an Admin role through
    // with no orientation on file — the fresh-install deadlock
    // journey-shell.md §5 describes.
    await page.goto('/admin/settings');
    await expect(page).toHaveURL('/admin/settings');
    // SettingsHubPage's `ADMIN_HUB_TITLE` (config/adminSections.tsx:188),
    // rendered by SettingsHub.tsx:117 as an `h4`.
    await expect(
      page.getByRole('heading', { level: 4, name: 'Settings' }),
    ).toBeVisible();

    // The exemption is a PREFIX (`/admin`), so a page further down the
    // subtree is reachable too, not just the hub itself.
    await page.goto('/admin/settings/general');
    await expect(page).toHaveURL('/admin/settings/general');
  });
});
