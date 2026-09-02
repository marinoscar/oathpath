/**
 * The admin (Console) settings information architecture — ONE declaration,
 * three consumers.
 *
 * Issue #91, epic #90. The admin surface used to be two tab-strip pages
 * (`SystemSettingsPage` with three tabs, `UserManagementPage` with two) plus a
 * separate list of rail destinations in `config/destinations.ts`. That is the
 * same shape of mistake issue #55 already fixed once for library navigation:
 * when the page, the menu, and the rail each keep their own list of what
 * exists and who may see it, three gates give three answers, and a user ends
 * up with a reachable page, a menu entry pointing at it, and no rail row.
 *
 * So the IA is declared here exactly once and read by:
 *
 *   1. `SettingsHubPage`            — the card grid, and the phone drill-down
 *   2. `NavigationRail` Console mode — the rail's contents on any `/admin/*`
 *   3. `AppBar`                      — resolving an admin route to its title
 *
 * "Console mode invents no new admin IA" is enforced structurally rather than
 * by convention: there is one array, so a card added here appears in all three
 * surfaces, and none of them can drift from the others.
 *
 * `Icon` is declared as a COMPONENT, never as a rendered element — exactly as
 * `config/destinations.ts` does, and for the same reason. The hub draws it at
 * 40px and the rail at ~20px, so the size cannot be baked in at declaration
 * time. Storing `<AdminIcon />` here would freeze it at the default size and
 * make every consumer clone the element to resize it.
 *
 * Why `.tsx` when the file holds no JSX: the icon values are React component
 * types, and keeping the extension consistent with the rest of the config
 * surface means adding a rendered fallback later is not a file rename.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import TuneIcon from '@mui/icons-material/Tune';
import PaletteIcon from '@mui/icons-material/Palette';
import FlagIcon from '@mui/icons-material/Flag';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import DataObjectIcon from '@mui/icons-material/DataObject';
import PeopleIcon from '@mui/icons-material/People';

/**
 * One settings page, fully described for every surface that draws it.
 *
 * `permission` is the API permission string the corresponding controller
 * ALREADY enforces — this registry never invents a permission, it mirrors one.
 * A card with no `permission` is visible to every authenticated user, which is
 * the normal case for the per-user registry in `userSettingsSections.tsx`.
 */
export interface SettingsCardDef {
  title: string;
  description: string;
  /**
   * The icon COMPONENT. Consumers render it themselves so each can pick its
   * own size — see the file header.
   */
  Icon: SvgIconComponent;
  /** Route the card navigates to. Absent means "declared but not yet routed". */
  path?: string;
  /** Rendered, but inert — for a page that exists in the IA but is not usable yet. */
  disabled?: boolean;
  /** API permission required to see the card at all; absent means "any authenticated user". */
  permission?: string;
  /**
   * Escape hatch: show the card even when `permission` is not held. Reserved
   * for pages that gate their own CONTENT internally and are still worth
   * reaching — the same distinction `destinations.ts` draws between a
   * REACHABILITY gate and a content gate.
   */
  alwaysShow?: boolean;
}

/** A titled group of cards — an `overline` header on the hub, a `ListSubheader` in the rail. */
export interface SettingsSectionDef {
  label: string;
  cards: SettingsCardDef[];
}

/**
 * The admin sections, in hub order.
 *
 * GATING IS BY PERMISSION, NOT BY ROLE — a role check here is what produced
 * the split-brain described in `destinations.ts`'s header. The strings are the
 * ones the API enforces:
 *
 *   - `system_settings:read`  → `system-settings.controller.ts` (GET)
 *   - `system_settings:write` → `system-settings.controller.ts` (PUT/PATCH)
 *   - `users:read`            → `users.controller.ts`
 *
 * `Advanced (JSON)` gates on `system_settings:WRITE` deliberately, unlike its
 * three siblings. It is a raw editor over the entire settings blob, so
 * read-only access to it has no meaning: a user who cannot save has nothing to
 * do on that page that the typed pages do not do better.
 *
 * `Users & Allowlist` gates on `users:read` alone even though it hosts data
 * from two controllers (Users → `users:read`, Allowlist → `allowlist:read`).
 * That mirrors the existing destination gate: the CARD gate is about
 * reachability, and the page is worth reaching for its Users half alone; the
 * Allowlist half gates itself on `allowlist:read` inside the page.
 */
export const ADMIN_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'General',
    cards: [
      {
        title: 'System',
        description: 'Configure core system settings, application behavior, and global defaults.',
        Icon: TuneIcon,
        path: '/admin/settings/general',
        permission: 'system_settings:read',
      },
      {
        title: 'Appearance',
        description: 'Set the default theme and the UI defaults new users start with.',
        Icon: PaletteIcon,
        path: '/admin/settings/appearance',
        permission: 'system_settings:read',
      },
      {
        title: 'Feature Flags',
        description: 'Turn optional application features on or off for everyone.',
        Icon: FlagIcon,
        path: '/admin/settings/feature-flags',
        permission: 'system_settings:read',
      },
      {
        // Issue #124, epic #109. `system_settings:read` is the string
        // `email-settings.controller.ts` enforces on its GET, exactly as the
        // three cards above mirror `system-settings.controller.ts` — the
        // registry never invents a permission. Saving and test-sending need
        // `system_settings:write`, which the PAGE gates internally: the card
        // gate is about REACHABILITY, and a read-only admin diagnosing "why is
        // mail broken" is worth letting in to look.
        title: 'Email',
        description:
          'Choose how the application sends email, and send a test message to prove it works.',
        Icon: EmailOutlinedIcon,
        path: '/admin/settings/email',
        permission: 'system_settings:read',
      },
      {
        title: 'Advanced (JSON)',
        description: 'Edit the raw system settings document directly, with validation.',
        Icon: DataObjectIcon,
        path: '/admin/settings/advanced',
        permission: 'system_settings:write',
      },
    ],
  },
  {
    label: 'Access',
    cards: [
      {
        title: 'Users & Allowlist',
        description: 'Manage user accounts and roles, and control who may sign in at all.',
        Icon: PeopleIcon,
        path: '/admin/settings/users',
        permission: 'users:read',
      },
    ],
  },
];

/**
 * The Console hub itself — the one admin route that owns no card, and so the
 * title `settingsPageTitle` falls back to.
 */
export const ADMIN_HUB_PATH = '/admin/settings';
export const ADMIN_HUB_TITLE = 'Settings';

/**
 * Filter `sections` to what `hasPermission` allows, optionally also applying
 * the client-side "Search settings" filter, and drop any section left empty.
 *
 * Every consumer runs THIS function rather than its own loop, which is what
 * makes success criterion 6 of epic #90 testable with a single assertion: a
 * card whose permission the user lacks can appear in the hub, the rail, and
 * the title resolver only if it appears in all three, and it appears in none.
 *
 * An empty section is dropped rather than rendered as a bare header, because a
 * group header above nothing reads as a loading failure, not as "you may see
 * none of these".
 *
 * `sections` is a PARAMETER rather than a closure over `ADMIN_SECTIONS`
 * deliberately: issue #96 reuses this function verbatim for the user-settings
 * registry, and a second near-identical copy of the gate is exactly the drift
 * this file exists to prevent.
 *
 * `query` matches the card TITLE only, case-insensitively, and never the
 * description. Matching descriptions too would mean a two-letter query
 * surfacing eight cards because their prose happens to share a word — a worse
 * result set than a strict title match, and one the user cannot predict.
 */
export function visibleSettingsSections(
  sections: SettingsSectionDef[],
  hasPermission: (permission: string) => boolean,
  query = '',
): SettingsSectionDef[] {
  const needle = query.trim().toLowerCase();
  return sections
    .map((section) => ({
      label: section.label,
      cards: section.cards.filter((card) => {
        if (needle && !card.title.toLowerCase().includes(needle)) return false;
        if (card.alwaysShow) return true;
        if (!card.permission) return true;
        return hasPermission(card.permission);
      }),
    }))
    .filter((section) => section.cards.length > 0);
}

/**
 * Resolve a pathname to the human title of the page it renders, for the
 * compact drill-down AppBar (#95).
 *
 * LONGEST PREFIX WINS, the same rule `resolveActiveDestination` uses in
 * `destinations.ts`, and it earns its keep the moment a card's route nests:
 * `/admin/settings/users/:id` must resolve to "Users & Allowlist" rather than
 * falling back to the hub title, and a future `/admin/settings/storage/insights`
 * must beat a `/admin/settings/storage` sibling instead of losing to whichever
 * happened to be declared first.
 *
 * Matching respects segment boundaries — `path === pathname` or
 * `pathname` continuing with a `/` — so `/admin/settings/users` does not claim
 * `/admin/settings/users-archive`. A bare `startsWith` is the bug
 * `destinations.ts`'s `owns()` was written to kill.
 *
 * Returns `null` when the path is not under `hubPath` at all. That is the
 * signal the AppBar uses to keep its normal toolbar: a `null` means "this is
 * not a settings surface", which is a different answer from "this is the
 * surface's own hub" (`hubTitle`), and collapsing the two would put a back
 * arrow on every page in the app.
 *
 * `sections`, `hubPath` and `hubTitle` are parameters for the same reason
 * `visibleSettingsSections` takes `sections`: #96 calls this with the user
 * registry and `/settings`.
 */
export function settingsPageTitle(
  sections: SettingsSectionDef[],
  hubPath: string,
  hubTitle: string,
  pathname: string,
): string | null {
  if (pathname !== hubPath && !pathname.startsWith(`${hubPath}/`)) return null;

  let best: { title: string; length: number } | null = null;
  for (const section of sections) {
    for (const card of section.cards) {
      if (!card.path) continue;
      const matches = pathname === card.path || pathname.startsWith(`${card.path}/`);
      if (matches && (!best || card.path.length > best.length)) {
        best = { title: card.title, length: card.path.length };
      }
    }
  }

  return best?.title ?? hubTitle;
}
