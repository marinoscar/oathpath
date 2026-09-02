import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';

/**
 * The Console-mode rail — `NavigationRail.tsx`'s `consoleMode` branch, active
 * on any `/admin/*` route once the rail is expanded (`isDesktop && !railCollapsed`,
 * so `lg`/1200px and up here).
 *
 * `Back to library` IS always the first row in console mode — read directly
 * from the component: it renders UNCONDITIONALLY at the top of the
 * `consoleMode` branch, before the `consoleSections.map(...)` group loop, with
 * no permission gate of its own (getting into Console mode at all already
 * required one). The group headers ("General", "Access") come from
 * `ADMIN_SECTIONS`' two section labels.
 *
 * Scoped to the `nav` element rather than a full-page screenshot: this spec
 * exists to pin the rail's own content, and scoping keeps it independent of
 * whatever the hub body happens to render (already covered by
 * `admin-hub.spec.ts`).
 */

test('Console rail: Back to library + General/Access groups @ lg', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(harnessUrl({ route: '/admin/settings' }));
  // Inter must be in before any pixel is captured - see waitForInter (#111).
  await waitForInter(page);

  const rail = page.locator('nav[aria-label="Console navigation"]');
  await expect(rail).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Back to library' })).toBeVisible();
  await expect(rail.getByText('General', { exact: true })).toBeVisible();
  await expect(rail.getByText('Access', { exact: true })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Advanced (JSON)' })).toBeVisible();
  await expect(rail.getByRole('link', { name: 'Users & Allowlist' })).toBeVisible();

  await expect(rail).toHaveScreenshot('console-rail-lg-expanded.png');
});
