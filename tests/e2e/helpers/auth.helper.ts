import { Page } from '@playwright/test';
import { OnboardingLevel, seedOnboarding } from './seed-onboarding';

// Re-exported so a spec that wants a partial onboarding state (#85) can
// `import { seedOnboarding } from '../helpers/auth.helper'` alongside
// `loginAsTestUser` rather than needing a second import path.
export { seedOnboarding, TEST_AI_KEY } from './seed-onboarding';
export type {
  OnboardingLevel,
  SeedOnboardingOptions,
  SeededTestUser,
} from './seed-onboarding';

export interface TestUserOptions {
  email: string;
  role?: 'admin' | 'contributor' | 'viewer';
  displayName?: string;
  /**
   * How far through onboarding to seed the user before the session is
   * established. Defaults to `'full'` — past both `RequireAiKey` (#39) and
   * `RequireOrientation` (#72) — which is what every existing caller of this
   * function wants and is why `loginAsTestUser` waits for `/` below.
   *
   * A spec that deliberately wants to *see* a gate (#85's orientation specs,
   * for instance) should pass `'ai-key-only'` or `'none'` here and then make
   * its own assertion about where the app lands — this function does not
   * assume `/` once onboarding is anything less than `'full'`.
   */
  onboarding?: OnboardingLevel;
}

/**
 * Log in as a test user via the API (bypassing OAuth) and establish the
 * browser session for it.
 *
 * Issue #80, epic #50: this used to drive the `/testing/login` UI and finish
 * with an unconditional `page.waitForURL('/')`. That stopped being true the
 * moment `RequireAiKey` shipped — a freshly created test user has no key and
 * lands on `/setup/ai-key` instead — and `RequireOrientation` added a second
 * gate behind it, so a plain login now needs both satisfied before `/` is a
 * real destination. `seedOnboarding` does that directly against the API
 * (three calls, no UI) rather than clicking through two onboarding screens,
 * and fails with a readable error naming what went wrong instead of this
 * function timing out on a URL that was never coming.
 *
 * `TestUserOptions.onboarding` defaults to `'full'`, so this function keeps
 * working exactly as before for every caller that does not pass it.
 */
export async function loginAsTestUser(
  page: Page,
  options: TestUserOptions
): Promise<void> {
  const onboarding = options.onboarding ?? 'full';

  await seedOnboarding(page, {
    email: options.email,
    role: options.role,
    displayName: options.displayName,
    onboarding,
  });

  if (onboarding === 'full') {
    // Wait for redirect to complete (auth callback then home). Only asserted
    // for the fully-onboarded default: a caller that opted into a partial
    // onboarding state is, by definition, expecting to land somewhere other
    // than '/' — `seedOnboarding` has already navigated to the callback URL,
    // and it is that caller's job to assert its own eventual destination
    // (e.g. `/setup/ai-key` or `/setup/journey`), which Playwright's
    // auto-retrying `expect(page).toHaveURL(...)` handles without a manual
    // wait here.
    await page.waitForURL('/', { timeout: 10000 });
  }
}

/**
 * Login as an admin test user.
 */
export async function loginAsAdmin(
  page: Page,
  email = 'admin@test.local'
): Promise<void> {
  await loginAsTestUser(page, { email, role: 'admin' });
}

/**
 * Login as a contributor test user.
 */
export async function loginAsContributor(
  page: Page,
  email = 'contributor@test.local'
): Promise<void> {
  await loginAsTestUser(page, { email, role: 'contributor' });
}

/**
 * Login as a viewer test user.
 */
export async function loginAsViewer(
  page: Page,
  email = 'viewer@test.local'
): Promise<void> {
  await loginAsTestUser(page, { email, role: 'viewer' });
}

/**
 * Check if the user is logged in by checking for the user menu.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.waitForSelector('[data-testid="user-menu"]', { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Logout the current user.
 */
export async function logout(page: Page): Promise<void> {
  await page.click('[data-testid="user-menu"]');
  await page.click('[data-testid="logout-button"]');
  await page.waitForURL('/login');
}
