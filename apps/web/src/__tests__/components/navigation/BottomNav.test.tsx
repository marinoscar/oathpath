import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { BottomNav } from '../../../components/navigation/BottomNav';
import { DESTINATIONS } from '../../../config/destinations';

/**
 * The phone half of the coverage migrated from the deleted `Sidebar.test.tsx`:
 * the bar's items, active highlight and navigate-on-click.
 *
 * #69 (epic #50) replaces WHAT the bar draws — the four learner destinations,
 * none of them permission-gated — without changing how any of it is asserted.
 * The permission-gating cases moved with `console` to the rail's suite, since
 * the rail is now the only surface that draws a gated destination.
 */

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

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

const ADMIN_PERMISSIONS = ['users:read', 'system_settings:read'];
const PHONE = 375;

/** Renders at a phone width, which is the only width this bar exists at. */
function renderPhone(route = '/') {
  const result = render(<BottomNav />, {
    wrapperOptions: { route, user: mockAdminUser },
  });
  act(() => setViewportWidth(PHONE));
  return result;
}

describe('BottomNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(ADMIN_PERMISSIONS, true);
    setViewportWidth(PHONE);
  });

  describe('Self-gating', () => {
    it('renders nothing at or above sm, even though Layout also unmounts it there', () => {
      // Belt and braces: `Layout` mounts it only below `sm`, and it refuses to
      // render above `sm` anyway. Either gate alone would be enough; both
      // together mean a future caller cannot mount it into the rail's band.
      render(<BottomNav />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });

    it('renders below sm', () => {
      renderPhone();

      expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    });

    it('appears and disappears across the sm boundary', async () => {
      renderPhone();
      expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();

      await act(async () => setViewportWidth(600));
      expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();

      await act(async () => setViewportWidth(599));
      expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    });
  });

  describe('Destinations', () => {
    it('renders all four bar destinations for a fully permitted user', () => {
      // FOUR since #69 (epic #50): Home, Learn, Practice, Progress. The bar is
      // now exactly at the four-action ceiling asserted below, which is what
      // keeps `showLabels` honest at 360px.
      renderPhone();

      for (const name of ['Home', 'Learn', 'Practice', 'Progress']) {
        expect(screen.getByRole('button', { name })).toBeInTheDocument();
      }
    });

    it('draws neither User Settings nor Console — both moved off the bar (#69)', () => {
      // Settings is reachable from the `UserMenu` (asserted in its own suite),
      // and Console from the rail's pinned foot. `docs/specs/journey-shell.md`
      // §2.2 names the phone-width Console cost explicitly: reachability by URL
      // is unchanged, discoverability from this bar is gone on purpose.
      renderPhone();

      expect(screen.queryByRole('button', { name: 'User Settings' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();
    });

    it('shows the compact label as visible text and the full label as the accessible name', () => {
      // A 4-up bar at 375px gives each tab ~90px. Every `compactLabel` is <= 8
      // characters (`destinations.test.ts` asserts the cap), and the full label
      // still reaches assistive technology.
      renderPhone();

      expect(screen.getByText('Practice')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Practice' })).toBeInTheDocument();
    });

    it('never renders more than four actions — showLabels depends on it', () => {
      renderPhone();

      expect(screen.getAllByRole('button')).toHaveLength(4);
      expect(screen.getAllByRole('button').length).toBeLessThanOrEqual(4);
    });

    it('shows all four to a user holding no permissions at all', () => {
      // NOT a weakened version of the old permission-gating assertion: #69
      // moved the only two gated destinations off the bar, and spec §2.1 is
      // explicit that none of the four carries a permission. An unoriented,
      // keyless, freshly-created account still needs its own four tabs —
      // whether the ROUTE is reachable is a separate gate on the route.
      setPermissions([]);
      renderPhone();

      expect(screen.getAllByRole('button')).toHaveLength(4);
    });

    it('gives every rendered tab a destination path to navigate to', () => {
      // The bar renders from `DESTINATIONS` and nothing else — the guard
      // against a tab whose label was typed here rather than read from the
      // model.
      renderPhone();

      for (const destination of DESTINATIONS) {
        expect(
          screen.getByRole('button', { name: destination.label }),
          `${destination.label} missing from the bar`,
        ).toBeInTheDocument();
      }
      expect(screen.getAllByRole('button')).toHaveLength(DESTINATIONS.length);
    });
  });

  describe('Active state', () => {
    it('selects the destination that owns the route', () => {
      renderPhone('/learn');

      expect(screen.getByRole('button', { name: 'Learn' })).toHaveClass('Mui-selected');
      expect(screen.getByRole('button', { name: 'Home' })).not.toHaveClass('Mui-selected');
    });

    it('selects each of the four on its own route, and only it', () => {
      for (const [route, label] of [
        ['/', 'Home'],
        ['/learn', 'Learn'],
        ['/practice', 'Practice'],
        ['/progress', 'Progress'],
      ] as const) {
        const { unmount } = render(<BottomNav />, {
          wrapperOptions: { route, user: mockAdminUser },
        });
        act(() => setViewportWidth(PHONE));

        for (const action of screen.getAllByRole('button')) {
          const selected = action.textContent?.includes(label);
          expect(
            action.classList.contains('Mui-selected'),
            `${route}: ${action.textContent} selection`,
          ).toBe(Boolean(selected));
        }
        unmount();
      }
    });

    it('selects nothing on a settings or admin route, which the bar no longer draws', () => {
      // `resolveActiveDestination` still answers `settings` / `console` for
      // these paths — route OWNERSHIP is deliberately unchanged by #69 — but
      // neither is a tab here, so the bar shows no phantom highlight.
      for (const route of ['/settings/profile', '/admin/settings/users']) {
        const { unmount } = render(<BottomNav />, {
          wrapperOptions: { route, user: mockAdminUser },
        });
        act(() => setViewportWidth(PHONE));

        for (const action of screen.getAllByRole('button')) {
          expect(action, `${route} highlighted a tab`).not.toHaveClass('Mui-selected');
        }
        unmount();
      }
    });

    it('selects NOTHING on a route no destination owns', () => {
      // `false`, not `null`, is what BottomNavigation wants for "nothing
      // selected" — and an unowned route is exactly where that must show.
      renderPhone('/settingsfoo');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });

    it('selects nothing when the active destination is one the user cannot see', () => {
      setPermissions([]);
      renderPhone('/admin/settings');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });
  });

  describe('Navigation', () => {
    it('navigates to the destination path on tap', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'Practice' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Practice' })).toHaveClass('Mui-selected');
      });
    });

    it('reaches every one of the four bar destinations', async () => {
      // The phone's ONLY navigation chrome, so "reachable from here" is the
      // whole of reachability below `sm` for these four.
      const user = userEvent.setup();
      renderPhone('/');

      for (const name of ['Learn', 'Practice', 'Progress', 'Home']) {
        await user.click(screen.getByRole('button', { name }));
        await waitFor(() => {
          expect(screen.getByRole('button', { name })).toHaveClass('Mui-selected');
        });
      }
    });
  });
});
