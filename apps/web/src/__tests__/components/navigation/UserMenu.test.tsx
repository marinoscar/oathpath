import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser, mockAdminUser } from '../../utils/test-utils';
import { UserMenu } from '../../../components/navigation/UserMenu';
import { SETTINGS_DESTINATION } from '../../../config/destinations';

// Mock usePermissions hook
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

describe('UserMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default permission mock - viewer user
    mockUsePermissions.mockReturnValue({
      permissions: new Set(['user_settings:read', 'user_settings:write']),
      roles: new Set(['viewer']),
      hasPermission: (perm: string) =>
        perm === 'user_settings:read' || perm === 'user_settings:write',
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });
  });

  describe('Rendering', () => {
    it('should display user avatar button', () => {
      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toBeInTheDocument();
    });

    it('should display user initials when no profile image', () => {
      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            profileImageUrl: null,
            displayName: 'Test User' as string | null,
          },
        },
      });

      // Avatar should contain initials
      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toBeInTheDocument();
    });

    it('should display first letter of email when no display name', () => {
      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: null as string | null,
          },
        },
      });

      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toBeInTheDocument();
    });

    it('should not render when user is null', () => {
      render(<UserMenu />, {
        wrapperOptions: { authenticated: false },
      });

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('Menu Interaction', () => {
    it('should open menu on click', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      await user.click(avatarButton);

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });

    it('should display user email in menu', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText(mockUser.email)).toBeInTheDocument();
      });
    });

    it('should display user display name in menu', async () => {
      const user = userEvent.setup();

      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: 'Custom Display Name',
          },
        },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText('Custom Display Name')).toBeInTheDocument();
      });
    });

    it('should show placeholder when no display name', async () => {
      const user = userEvent.setup();

      render(<UserMenu />, {
        wrapperOptions: {
          user: {
            ...mockUser,
            displayName: null as string | null,
          },
        },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText(/no name set/i)).toBeInTheDocument();
      });
    });

    it('should close menu when clicking outside', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      // Click outside (on document body)
      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('Menu Items', () => {
    it('should have settings menu item', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
      });
    });

    it('should have logout menu item', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /logout/i })).toBeInTheDocument();
      });
    });

    it('shows NO Console entry, even to a full admin (#69)', async () => {
      // A DELIBERATE BEHAVIOUR CHANGE, not a regression:
      // `docs/specs/journey-shell.md` §2.2 moves Console into the rail's pinned
      // foot and nowhere else, and names the cost plainly — an administrator
      // below `sm` (where the rail is unmounted) has no one-tap path to it from
      // the nav chrome. REACHABILITY is untouched: `/admin/settings` is still a
      // route, still gated by `RequirePermission`, and still works from a
      // bookmark or a typed URL. Only discoverability from this menu is gone.
      const user = userEvent.setup();

      mockUsePermissions.mockReturnValue({
        permissions: new Set(['system_settings:read', 'users:read']),
        roles: new Set(['admin']),
        hasPermission: (perm: string) =>
          perm === 'system_settings:read' || perm === 'users:read',
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin: true,
      });

      render(<UserMenu />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
      expect(screen.queryByRole('menuitem', { name: /console/i })).not.toBeInTheDocument();
    });

    it('should NOT show the Console entry for non-admin users', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      expect(screen.queryByRole('menuitem', { name: /console/i })).not.toBeInTheDocument();
    });
  });

  describe('Navigation', () => {
    it('should navigate to settings page', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /settings/i })).toBeInTheDocument();
      });

      const settingsItem = screen.getByRole('menuitem', { name: /settings/i });
      await user.click(settingsItem);

      // Menu should close after navigation
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });

    it('sends User Settings to the path the destination model declares', async () => {
      // Replaces the Console-navigation case this menu no longer offers (#69).
      // The row's target is read from `SETTINGS_DESTINATION`, whose `path`
      // comes from `DESTINATION_ROUTES.settings` — so a menu that navigated
      // somewhere else would be the split-brain `config/destinations.ts` exists
      // to prevent, in its original form.
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: 'User Settings' })).toBeInTheDocument();
      });

      expect(SETTINGS_DESTINATION.path).toBe('/settings');
      await user.click(screen.getByRole('menuitem', { name: 'User Settings' }));

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('Logout', () => {
    it('should call logout on logout click', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /logout/i })).toBeInTheDocument();
      });

      const logoutItem = screen.getByRole('menuitem', { name: /logout/i });
      await user.click(logoutItem);

      // Logout should be triggered
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('Icons', () => {
    it('should display settings icon', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const settingsItem = screen.getByRole('menuitem', { name: /settings/i });
        expect(settingsItem).toBeInTheDocument();
      });
    });

    it('should display logout icon', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        const logoutItem = screen.getByRole('menuitem', { name: /logout/i });
        expect(logoutItem).toBeInTheDocument();
      });
    });

    it('draws the User Settings row with the icon the destination model declares', async () => {
      // The icon comes from `SETTINGS_DESTINATION.Icon`, drawn at `small` here
      // — which is why the model declares a COMPONENT rather than a rendered
      // element (`destinations.test.ts` asserts that).
      const user = userEvent.setup();

      render(<UserMenu />);

      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: 'User Settings' })).toBeInTheDocument();
      });
      expect(
        screen.getByRole('menuitem', { name: 'User Settings' }).querySelector('svg'),
      ).not.toBeNull();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      expect(avatarButton).toHaveAttribute('aria-haspopup', 'true');
      // aria-expanded is undefined when menu is closed (not set)
      expect(avatarButton).not.toHaveAttribute('aria-expanded');

      await user.click(avatarButton);

      await waitFor(() => {
        expect(avatarButton).toHaveAttribute('aria-expanded', 'true');
      });
    });

    it('should have menu ID', async () => {
      const user = userEvent.setup();

      render(<UserMenu />);

      const avatarButton = screen.getByRole('button');
      await user.click(avatarButton);

      await waitFor(() => {
        // MUI Menu puts the id on the presentation wrapper, not the menu role element
        const menuWrapper = document.getElementById('user-menu');
        expect(menuWrapper).toBeInTheDocument();
        // Verify the menu role element exists inside
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });
  });

  describe('Sourced from the destination table', () => {
    /**
     * Issue #55. This menu already gated System Settings on
     * `system_settings:read` while the sidebar gated the same page on the
     * `admin` ROLE — so a Contributor granted that permission saw the menu
     * entry, reached a working page, and had no sidebar row. Both surfaces now
     * read `config/destinations.ts`, so there is one answer per destination.
     */
    function setPermissions(granted: string[], isAdmin = false) {
      mockUsePermissions.mockReturnValue({
        permissions: new Set(granted),
        roles: new Set(isAdmin ? ['admin'] : ['contributor']),
        hasPermission: (perm: string) => granted.includes(perm),
        hasAnyPermission: vi.fn(),
        hasAllPermissions: vi.fn(),
        hasRole: vi.fn(),
        hasAnyRole: vi.fn(),
        isAdmin,
      });
    }

    it('keeps User Settings for a user holding NO permissions at all', async () => {
      // THE ASSERTION THIS SUITE EXISTS FOR AFTER #69. Settings left
      // `DESTINATIONS` when the bar became the four learner destinations, and
      // this menu is now the ONLY chrome that offers it at any width — a menu
      // still filtering that array would have silently rendered nothing but
      // Logout, taking every path to a user's own profile, theme and tokens
      // with it. It carries no permission because every authenticated user owns
      // their own settings.
      const user = userEvent.setup();
      setPermissions([], false);

      render(<UserMenu />);
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: 'User Settings' })).toBeInTheDocument();
      });
    });

    it('shows no Console entry on either admin permission (#69)', async () => {
      // Both halves of `console`'s `anyPermission` — the gate #92 added — now
      // resolve to the same answer HERE, because Console is not in this menu at
      // all. It is drawn by the rail's pinned foot and nowhere else; see the
      // Menu Items suite above for the accepted cost, and
      // `NavigationRail.test.tsx` for where the permission gate is still
      // asserted in both directions.
      const user = userEvent.setup();

      for (const granted of [['system_settings:read'], ['users:read']]) {
        setPermissions(granted, true);
        const { unmount } = render(<UserMenu />, {
          wrapperOptions: { user: mockAdminUser },
        });
        await user.click(screen.getByRole('button'));

        await waitFor(() => {
          expect(screen.getByRole('menu')).toBeInTheDocument();
        });
        expect(
          screen.queryByRole('menuitem', { name: 'Console' }),
          `${granted.join()} saw a Console entry`,
        ).not.toBeInTheDocument();
        unmount();
      }
    });

    it('grants nothing on the admin role alone', async () => {
      const user = userEvent.setup();
      setPermissions([], true);

      render(<UserMenu />, { wrapperOptions: { user: mockAdminUser } });
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
      expect(screen.queryByRole('menuitem', { name: 'Console' })).not.toBeInTheDocument();
    });

    it('omits Home and the other three bar destinations — the chrome already draws them', async () => {
      // A menu row duplicating on-screen chrome is the bloat this epic removes;
      // #69 extends that from Home alone to all four bar destinations, which
      // the rail (or the bottom bar below `sm`) draws at every width.
      const user = userEvent.setup();
      setPermissions(['users:read', 'system_settings:read'], true);

      render(<UserMenu />, { wrapperOptions: { user: mockAdminUser } });
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
      for (const label of ['Home', 'Learn', 'Practice', 'Progress']) {
        expect(screen.queryByRole('menuitem', { name: label })).not.toBeInTheDocument();
      }
    });

    it('labels and targets every entry from the destination table', async () => {
      const user = userEvent.setup();
      setPermissions(['users:read', 'system_settings:read'], true);

      render(<UserMenu />, { wrapperOptions: { user: mockAdminUser } });
      await user.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      // The menu's ONE navigation row, read from the destination model rather
      // than typed here — the same guarantee this test made when it iterated
      // `DESTINATIONS`, over the export that now owns the row (#69).
      expect(
        screen.getByRole('menuitem', { name: SETTINGS_DESTINATION.label }),
      ).toBeInTheDocument();
      // That row plus Logout, and nothing invented locally.
      expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    });
  });
});
