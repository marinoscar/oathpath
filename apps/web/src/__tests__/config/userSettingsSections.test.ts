import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

/**
 * Issue #126, epic #109. The Notifications card follows the same
 * MANDATORY settings-registry pattern every other `/settings/*` card does
 * (see CLAUDE.md's "MANDATORY: Settings UI Pattern" and
 * `config/userSettingsSections.tsx`'s own header): declared once, here, with
 * NO `permission` field.
 *
 * Every other card under `USER_SETTINGS_SECTIONS` is unpermissioned for the
 * same reason - these are the caller's OWN settings, and the API grants
 * `user_settings:read` / `user_settings:write` to all three roles. A
 * `permission` field on this card would invent an authorization rule the API
 * does not enforce, and would lock a Viewer out of saying how they want to be
 * contacted.
 */
describe('USER_SETTINGS_SECTIONS - Notifications card (issue #126)', () => {
  function findNotificationsCard() {
    for (const section of USER_SETTINGS_SECTIONS) {
      const card = section.cards.find((c) => c.path === '/settings/notifications');
      if (card) return card;
    }
    return undefined;
  }

  it('is present in the registry', () => {
    const card = findNotificationsCard();
    expect(card).toBeDefined();
    expect(card?.title).toBe('Notifications');
  });

  it('declares no permission - reachable by every authenticated user, not gated on a specific one', () => {
    const card = findNotificationsCard();
    expect(card).toBeDefined();
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('points at /settings/notifications', () => {
    const card = findNotificationsCard();
    expect(card?.path).toBe('/settings/notifications');
  });

  it('is grouped under Account, not Security - it is about how the account is contacted, not a credential', () => {
    const accountSection = USER_SETTINGS_SECTIONS.find((s) => s.label === 'Account');
    expect(accountSection?.cards.some((c) => c.path === '/settings/notifications')).toBe(
      true,
    );
  });

  // The wider claim: this is not a one-off omission on this card, it is true
  // of the whole per-user registry (see the file's own header comment). A
  // regression that added a permission ANYWHERE in USER_SETTINGS_SECTIONS
  // would be exactly the kind of invented gate that CLAUDE.md's Settings UI
  // Pattern rule 3 warns against.
  it('no card in USER_SETTINGS_SECTIONS declares a permission', () => {
    const allCards = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards);
    for (const card of allCards) {
      expect(card.permission).toBeUndefined();
    }
  });
});

/**
 * Issue #77, epic #50. `/settings/journey` is the ongoing home for the six
 * answers `/setup/journey` collects once, and CLAUDE.md's Settings UI Pattern
 * says what shape that has to take: a registry card plus a route, never a new
 * tab on an existing settings page.
 *
 * The route half is asserted against the LIVE `App.tsx` rather than a copy of
 * its route list — the same technique `destinations.test.ts` uses on the admin
 * registry, and for the same reason. A card whose `path` has no route is a hub
 * tile that leads to the catch-all and lands the learner on Home, which looks
 * like nothing happened.
 */
describe('USER_SETTINGS_SECTIONS - Your plan card (issue #77)', () => {
  const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');

  /** Every `<Route>` in `App.tsx`, as `path` → the permission it is wrapped in. */
  function declaredRouteGates(): Map<string, string | null> {
    const source = readFileSync(APP_TSX, 'utf8');
    const gates = new Map<string, string | null>();
    for (const chunk of source.split('<Route').slice(1)) {
      const path = /^\s*path="([^"]+)"/.exec(chunk)?.[1];
      if (!path) continue;
      gates.set(path, /permission="([^"]+)"/.exec(chunk)?.[1] ?? null);
    }
    return gates;
  }

  function findJourneyCard() {
    for (const section of USER_SETTINGS_SECTIONS) {
      const card = section.cards.find((c) => c.path === '/settings/journey');
      if (card) return card;
    }
    return undefined;
  }

  it('is present in the registry, with a real title and description', () => {
    const card = findJourneyCard();
    expect(card).toBeDefined();
    expect(card?.title).toBe('Your plan');
    expect(card?.description).toMatch(/filing date/i);
    expect(card?.description).toMatch(/interview date/i);
  });

  it('declares no permission - PUT /api/journey/profile is @Auth() with none to mirror', () => {
    // The API resolves the learner from the token and enforces no permission
    // string, so there is none to declare here and none may be invented. A
    // gate would lock a learner out of their own plan.
    const card = findJourneyCard();
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('is grouped under Account, not Security - a plan is not a credential', () => {
    const accountSection = USER_SETTINGS_SECTIONS.find((s) => s.label === 'Account');
    expect(accountSection?.cards.some((c) => c.path === '/settings/journey')).toBe(true);

    const securitySection = USER_SETTINGS_SECTIONS.find((s) => s.label === 'Security');
    expect(securitySection?.cards.some((c) => c.path === '/settings/journey')).toBe(false);
  });

  it('adds a card rather than a tab: no existing card path is reused or replaced', () => {
    // CLAUDE.md Settings UI Pattern rule 2 in its checkable form - the four
    // cards that existed before #77 are all still their own destinations.
    const paths = USER_SETTINGS_SECTIONS.flatMap((s) => s.cards.map((c) => c.path));
    expect(paths).toEqual(
      expect.arrayContaining([
        '/settings/journey',
        '/settings/profile',
        '/settings/appearance',
        '/settings/notifications',
        '/settings/ai',
        '/settings/tokens',
      ]),
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('routes EVERY user-settings card path in App.tsx, each with no permission gate', () => {
    // Both halves of the agreement the hub tile depends on, read live: the
    // route exists, and it is ungated exactly as the card is. Looping over the
    // whole registry rather than over this one card is what makes the next
    // card added here inherit the assertion for free.
    const gates = declaredRouteGates();
    const cards = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards);
    expect(cards.length).toBeGreaterThan(0);

    for (const card of cards) {
      if (!card.path) continue;
      expect(gates.has(card.path), `${card.title} → ${card.path} has no route`).toBe(true);
      expect(gates.get(card.path), `${card.title} route gate`).toBe(card.permission ?? null);
    }

    // Guards the parser: a regex that silently stopped matching would make
    // every assertion above pass vacuously over an empty map.
    expect(gates.get('/settings/journey')).toBeNull();
    expect(gates.has('/settings/journey')).toBe(true);
  });
});

/**
 * Issue #270. `Danger zone` is its OWN group, deliberately not a third member
 * of `Security` — see `config/userSettingsSections.tsx`'s own comment on the
 * group for why a data reset is not a credential and does not belong there.
 *
 * The route-existence and no-permission halves of this card are already
 * covered generically by "routes EVERY user-settings card path in App.tsx,
 * each with no permission gate" above (it loops over the whole registry), so
 * this block only asserts what is specific to THIS card and group: the group
 * has exactly one card, the card is the right one, and the group sits after
 * `Security` — the ordering CLAUDE.md's Settings UI Pattern implies by
 * calling it a distinct, later destination rather than folding it in.
 */
describe('USER_SETTINGS_SECTIONS - Danger zone group (issue #270)', () => {
  function findDangerZone() {
    return USER_SETTINGS_SECTIONS.find((s) => s.label === 'Danger zone');
  }

  it('exists, with exactly one card: Reset your data at /settings/reset', () => {
    const group = findDangerZone();
    expect(group).toBeDefined();
    expect(group?.cards).toHaveLength(1);
    expect(group?.cards[0].title).toBe('Reset your data');
    expect(group?.cards[0].path).toBe('/settings/reset');
  });

  it('declares no permission on its card - every authenticated user owns their own data', () => {
    const card = findDangerZone()?.cards[0];
    expect(card).toBeDefined();
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('sits after Security in USER_SETTINGS_SECTIONS - a data reset is not a credential', () => {
    const securityIndex = USER_SETTINGS_SECTIONS.findIndex((s) => s.label === 'Security');
    const dangerZoneIndex = USER_SETTINGS_SECTIONS.findIndex((s) => s.label === 'Danger zone');

    expect(securityIndex).toBeGreaterThanOrEqual(0);
    expect(dangerZoneIndex).toBeGreaterThan(securityIndex);
  });

  it('is not folded into the Security group - reachability, not a tab on an existing card', () => {
    const securitySection = USER_SETTINGS_SECTIONS.find((s) => s.label === 'Security');
    expect(securitySection?.cards.some((c) => c.path === '/settings/reset')).toBe(false);
  });
});
