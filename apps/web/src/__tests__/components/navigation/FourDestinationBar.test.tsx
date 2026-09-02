/**
 * The four-destination bar, across the size class boundary that swaps it
 * (issue #69, epic #50).
 *
 * The rail's own suite and the bottom bar's own suite each test one surface in
 * isolation, with `Layout` mocked away. What NEITHER can see is the thing this
 * change is actually judged on: **a learner has all four destinations, and a
 * user has their own settings, at every width** — because the surface that
 * provides them is different on either side of 600px, and the two are
 * hand-kept complements (`CLAUDE.md`'s five coupled breakpoint gates).
 *
 * So this file mounts the REAL `Layout` with the real rail, real bottom bar and
 * real user menu, and walks the widths: 360 (the narrowest phone the mockups
 * are drawn for), 599 and 600 (the seam), and a desktop width.
 *
 * The `sm` gates are deliberately NOT changed by #69 — this suite asserts they
 * still hold with the new destination set, which is the "do not break them"
 * half of that rule.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { Layout } from '../../../components/common/Layout';
import { DESTINATIONS } from '../../../config/destinations';

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../../hooks/useNavigationPrefs', () => ({
  useNavigationPrefs: vi.fn(),
}));

// The AppBar mounts the notification bell, which opens an SSE stream this
// suite has no interest in. The bell is mocked, not the AppBar: the user menu
// lives in that bar and is one of the surfaces under test here.
vi.mock('../../../components/navigation/NotificationBell', () => ({
  NotificationBell: () => null,
}));

import { usePermissions } from '../../../hooks/usePermissions';
import { useNavigationPrefs } from '../../../hooks/useNavigationPrefs';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseNavigationPrefs = vi.mocked(useNavigationPrefs);

function setPermissions(granted: string[], isAdmin = false) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: (perm: string) => granted.includes(perm),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin,
  });
}

const PHONE = 360;
const SM = 600;
const DESKTOP = 1400;

const BAR_LABELS = ['Home', 'Learn', 'Practice', 'Progress'];

/**
 * The destination bar at this width — the `BottomNavigation` below `sm`, the
 * rail's `<nav>` at and above it.
 *
 * The two surfaces expose their rows differently ON PURPOSE (tabs versus
 * links), so this returns the container and the caller asks for the role it
 * expects at that width. `BottomNavigation`'s root has no landmark role of its
 * own — it is fixed chrome inside `Layout`, not a `<nav>` — so it is found by
 * its MUI class, the same way the existing suites read `Mui-selected`.
 */
function bar(width: number): HTMLElement {
  if (width >= SM) return screen.getByRole('navigation', { name: /main navigation/i });

  const root = document.querySelector('.MuiBottomNavigation-root');
  expect(root, `no bottom bar at ${width}px`).not.toBeNull();
  return root as HTMLElement;
}

/** The row role each surface uses: MUI tabs are buttons, rail rows are links. */
function rowRole(width: number): 'button' | 'link' {
  return width < SM ? 'button' : 'link';
}

/**
 * The avatar button that opens the user menu. Found by `aria-haspopup` rather
 * than by name: its accessible name is the user's initials or their display
 * name, neither of which this suite is asserting.
 */
function userMenuButton(): HTMLElement {
  const button = document.querySelector('button[aria-haspopup="true"]');
  expect(button, 'no user-menu button in the shell').not.toBeNull();
  return button as HTMLElement;
}

function renderShell(width: number, route = '/', user = mockUser) {
  setViewportWidth(width);
  return render(<Layout />, { wrapperOptions: { route, user } });
}

describe('The four-destination bar across the sm boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions([]);
    mockUseNavigationPrefs.mockReturnValue({
      railCollapsed: false,
      toggleRailCollapsed: vi.fn(),
      isLoading: false,
    });
  });

  describe.each([
    ['360px — the narrowest phone the mockups are drawn for', PHONE],
    ['599px — the last pixel of the compact class', SM - 1],
    ['600px — the first pixel of the medium class', SM],
    ['1400px — the expanded rail', DESKTOP],
  ])('at %s', (_label, width) => {
    it('offers all four destinations, whichever surface is mounted', () => {
      renderShell(width);

      const surface = bar(width);
      for (const label of BAR_LABELS) {
        // By ACCESSIBLE NAME, which is the full label on both surfaces — the
        // bottom bar shows the compact label as visible text and the collapsed
        // rail shows an aria-hidden caption, so the name is the only thing
        // common to all three treatments.
        expect(
          within(surface).getByRole(rowRole(width), { name: label }),
          `${label} missing at ${width}px`,
        ).toBeInTheDocument();
      }
    });

    it('draws exactly the four and nothing else in the destination bar', () => {
      renderShell(width);

      const rows = within(bar(width)).queryAllByRole(rowRole(width));
      // Below `sm`: four tabs. At `sm` and up: the same four, and the rail's
      // collapse toggle is a `button` rather than a link so it is not counted.
      // A viewer holds neither admin permission, so no pinned Console row.
      expect(rows).toHaveLength(DESTINATIONS.length);
      for (const label of ['User Settings', 'Console']) {
        expect(
          within(bar(width)).queryByRole(rowRole(width), { name: label }),
          `${label} should not be in the bar at ${width}px`,
        ).not.toBeInTheDocument();
      }
    });

    it('keeps User Settings reachable from the user menu at this width', async () => {
      // THE REGRESSION THIS FILE EXISTS FOR. Settings left `DESTINATIONS` in
      // #69, so on every surface that reads that array it is simply gone; the
      // user menu is what has to carry it, and it is the same menu at every
      // width. A user must never lose access to their own settings.
      const user = userEvent.setup();
      renderShell(width);

      await user.click(userMenuButton());

      expect(
        await screen.findByRole('menuitem', { name: 'User Settings' }),
      ).toBeInTheDocument();
    });
  });

  it('swaps the surface, not the destinations, as the window crosses 600px', async () => {
    renderShell(PHONE);

    for (const width of [PHONE, 599, 600, 900, DESKTOP]) {
      await act(async () => setViewportWidth(width));

      // Exactly one destination surface at every width — the coupled-gate
      // invariant `Layout.test.tsx` asserts with mocks, re-asserted here with
      // the real components and the new destination set.
      const surfaces = [
        document.querySelector('.MuiBottomNavigation-root'),
        screen.queryByRole('navigation', { name: /main navigation/i }),
      ].filter(Boolean);
      expect(surfaces, `${width}px navigation surfaces`).toHaveLength(1);

      for (const label of BAR_LABELS) {
        expect(
          within(bar(width)).getByRole(rowRole(width), { name: label }),
          `${label} lost at ${width}px`,
        ).toBeInTheDocument();
      }
    }
  });

  it('gives an admin the pinned Console row on the rail and nowhere else', async () => {
    // Spec §2.2's accepted cost, asserted rather than left as prose: the rail
    // has Console, the phone has no path to it from the nav chrome, and
    // reachability by URL is untouched either way.
    setPermissions(['system_settings:read', 'users:read'], true);
    const user = userEvent.setup();

    renderShell(DESKTOP, '/', mockAdminUser);
    expect(screen.getByRole('link', { name: 'Console' })).toBeInTheDocument();

    await act(async () => setViewportWidth(PHONE));
    expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();

    await user.click(userMenuButton());
    expect(await screen.findByRole('menuitem', { name: 'User Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Console' })).not.toBeInTheDocument();
  });

  it('needs no permission for any of the four, at any width', () => {
    // An unoriented, keyless, freshly-created account still gets its own four
    // destinations (spec §2.1). Route gates are a separate question, gated on
    // the route.
    setPermissions([]);

    for (const width of [PHONE, DESKTOP]) {
      const { unmount } = renderShell(width);

      for (const label of BAR_LABELS) {
        expect(
          within(bar(width)).getByRole(rowRole(width), { name: label }),
          `${label} missing at ${width}px`,
        ).toBeInTheDocument();
      }
      unmount();
    }
  });
});
