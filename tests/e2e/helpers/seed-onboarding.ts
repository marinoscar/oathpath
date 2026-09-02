import { Page } from '@playwright/test';

// =============================================================================
// seedOnboarding — issue #80, epic #50
// =============================================================================
//
// `RequireAiKey` (#39) hard-blocks any user with no saved AI key at
// `/setup/ai-key`, and `RequireOrientation` (#72) chains after it, blocking an
// unoriented learner at `/setup/journey`. A test user created by
// `POST /api/auth/test/login` starts behind BOTH gates — so
// `page.waitForURL('/')` right after login was never going to resolve once
// either gate shipped, and every spec that logs in inherited the timeout.
//
// This drives the API directly (three calls, in order) rather than clicking
// through two onboarding screens: it is faster, and it fails with a readable
// reason instead of a generic Playwright timeout when something upstream
// breaks — see the "fail loudly" note on each call below.
//
// -----------------------------------------------------------------------------
// WHY `page.request`, NOT A BARE `fetch`
// -----------------------------------------------------------------------------
//
// `page.request` is the same `APIRequestContext` as `page.context().request`:
// requests made through it read and write the BROWSING CONTEXT's cookie jar.
// `POST /api/auth/test/login` sets the `refresh_token` HttpOnly cookie on its
// 302 response — routing the call through `page.request` means that cookie
// lands in the browser exactly as it would from a real OAuth redirect, so a
// later page reload can silently refresh the session the same way it would in
// production. A plain Node `fetch` would get the cookie too, but into a jar
// the browser never sees.
//
// -----------------------------------------------------------------------------
// WHY `filingDate`, NOT `testVersionCode`, ON THE PROFILE WRITE
// -----------------------------------------------------------------------------
//
// `PUT /api/journey/profile` 400s if both are sent, and resolves the version
// from the filing date server-side (`test-version-resolution.ts`) — the exact
// rule this fixture has no business knowing. Sending `filingDate` means this
// file never hardcodes a `civics_test_versions.code` that could drift from
// what is actually seeded.
// =============================================================================

export type TestUserRole = 'admin' | 'contributor' | 'viewer';

/**
 * How far through onboarding the seeded user should be. `RequireAiKey` and
 * `RequireOrientation` are product gates that must stay testable in their own
 * right (issue #85 needs to reach `/setup/journey` for real), so this is
 * opt-out on two independent axes rather than an all-or-nothing switch:
 *
 * - `'full'` (default) — both gates cleared; the user lands wherever the app
 *   would normally send a fully onboarded user.
 * - `'ai-key-only'` — `RequireAiKey` cleared, `RequireOrientation` still
 *   blocking. Reaches `/setup/journey`.
 * - `'none'` — neither seeded, a brand new account. Reaches `/setup/ai-key`.
 */
export type OnboardingLevel = 'full' | 'ai-key-only' | 'none';

export interface SeedOnboardingOptions {
  email: string;
  role?: TestUserRole;
  displayName?: string;
  /** @default 'full' */
  onboarding?: OnboardingLevel;
}

export interface SeededTestUser {
  /** The bearer token minted by `POST /api/auth/test/login`. */
  accessToken: string;
  /** Access-token lifetime in seconds, as reported by the login redirect. */
  expiresIn: number;
  /** The exact `/auth/callback?...` URL the login redirect carried. */
  callbackUrl: string;
}

/** A key that is obviously fake and obviously not a real OpenAI secret. */
const TEST_AI_KEY = 'sk-e2e-test-key-not-a-real-openai-key';

/**
 * Orientation fields enough to satisfy `JourneyService.isOrientationComplete`
 * — a filing date (server resolves the test version from it), a state, a
 * timezone, a daily goal and an explanation language. The filing date is
 * deliberately before the 2025 cutoff so this stays correct regardless of
 * when it runs; the actual test version it resolves to is an implementation
 * detail no caller of this fixture should depend on.
 */
const ORIENTATION_PROFILE = {
  filingDate: '2020-01-15',
  stateCode: 'CA',
  timezone: 'America/Los_Angeles',
  dailyGoalMinutes: 15,
  explanationLanguage: 'en',
} as const;

/**
 * Seed a test user through the onboarding gates, directly against the API,
 * and establish the browser session for it — so `page.goto('/')` (or whatever
 * gate the caller asked to stop short of) resolves instead of timing out.
 *
 * Does not itself assert or wait for any particular final URL: with
 * `onboarding: 'full'` the app lands on `/`, but `'ai-key-only'` and `'none'`
 * land on a setup screen, and asserting one destination here would make the
 * two partial states unusable for the specs they exist for. Callers that want
 * "a logged-in user on `/`" should use `loginAsTestUser` instead, which wraps
 * this with that wait.
 */
export async function seedOnboarding(
  page: Page,
  options: SeedOnboardingOptions,
): Promise<SeededTestUser> {
  const { email, role, displayName, onboarding = 'full' } = options;

  // ---------------------------------------------------------------------------
  // 1. POST /api/auth/test/login — bypasses OAuth, 302s to
  //    `/auth/callback?token=...&expiresIn=...` and sets the refresh cookie.
  // ---------------------------------------------------------------------------
  const loginResponse = await page.request.post('/api/auth/test/login', {
    data: { email, role, displayName },
    maxRedirects: 0,
    failOnStatusCode: false,
  });

  if (loginResponse.status() !== 302) {
    const body = await loginResponse.text().catch(() => '<unreadable body>');
    throw new Error(
      'seedOnboarding: POST /api/auth/test/login did not 302-redirect as ' +
        `expected — got HTTP ${loginResponse.status()} instead. This endpoint ` +
        "is only registered when the API's NODE_ENV is not 'production' " +
        "(see TestAuthModule and TestEnvironmentGuard) — confirm the API " +
        'under test is reachable and running in a non-production mode. ' +
        `Response body: ${body}`,
    );
  }

  const location = loginResponse.headers()['location'];
  if (!location) {
    throw new Error(
      'seedOnboarding: POST /api/auth/test/login returned a 302 with no ' +
        'Location header — cannot recover the access token.',
    );
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(location, page.url());
  } catch (cause) {
    throw new Error(
      `seedOnboarding: could not parse the Location header "${location}" ` +
        'returned by POST /api/auth/test/login as a URL.',
      { cause },
    );
  }

  const accessToken = callbackUrl.searchParams.get('token');
  const expiresInRaw = callbackUrl.searchParams.get('expiresIn');
  if (!accessToken || !expiresInRaw) {
    throw new Error(
      'seedOnboarding: the /auth/callback redirect from ' +
        `POST /api/auth/test/login is missing "token" and/or "expiresIn" — ` +
        `got: ${callbackUrl.toString()}`,
    );
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  // ---------------------------------------------------------------------------
  // 2. PUT /api/ai/key — satisfies RequireAiKey. Store-only: it never calls
  //    the provider (that is the separate POST /api/ai/key/test), so any
  //    non-blank string works and this makes no outbound network call.
  // ---------------------------------------------------------------------------
  if (onboarding === 'full' || onboarding === 'ai-key-only') {
    const keyResponse = await page.request.put('/api/ai/key', {
      headers: authHeaders,
      data: { apiKey: TEST_AI_KEY },
      failOnStatusCode: false,
    });

    if (!keyResponse.ok()) {
      const body = await keyResponse.text().catch(() => '<unreadable body>');
      throw new Error(
        `seedOnboarding: PUT /api/ai/key failed for ${email} — HTTP ` +
          `${keyResponse.status()}. Response body: ${body}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 3. PUT /api/journey/profile — satisfies RequireOrientation. Orientation
  //    completion is server-inferred from the fields being present; there is
  //    no flag to set directly.
  // ---------------------------------------------------------------------------
  if (onboarding === 'full') {
    const profileResponse = await page.request.put('/api/journey/profile', {
      headers: authHeaders,
      data: ORIENTATION_PROFILE,
      failOnStatusCode: false,
    });

    if (!profileResponse.ok()) {
      const body = await profileResponse
        .text()
        .catch(() => '<unreadable body>');
      throw new Error(
        `seedOnboarding: PUT /api/journey/profile failed for ${email} — HTTP ` +
          `${profileResponse.status()}. Response body: ${body}`,
      );
    }

    const profileBody = (await profileResponse.json().catch(() => null)) as {
      data?: { profile?: { orientationCompletedAt?: string | null } };
    } | null;
    const orientationCompletedAt =
      profileBody?.data?.profile?.orientationCompletedAt;
    if (!orientationCompletedAt) {
      throw new Error(
        'seedOnboarding: PUT /api/journey/profile succeeded but the ' +
          `returned profile for ${email} has no orientationCompletedAt — ` +
          'RequireOrientation would still block this user. Check that ' +
          'ORIENTATION_PROFILE in seed-onboarding.ts still supplies every ' +
          'field JourneyService.isOrientationComplete checks.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Establish the browser session, the same way a real OAuth login does:
  //    navigate to the exact callback URL the API handed back. AuthCallbackPage
  //    stores the access token, calls GET /auth/me to populate AuthContext,
  //    then navigates on (to '/' by default, since no auth_return_url was set
  //    in sessionStorage) — no clicking through onboarding screens required.
  // ---------------------------------------------------------------------------
  await page.goto(callbackUrl.toString());

  return {
    accessToken,
    expiresIn: Number(expiresInRaw),
    callbackUrl: callbackUrl.toString(),
  };
}
