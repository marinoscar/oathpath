import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  NotificationChannel,
  channelsFor,
  findEvent,
  isMandatory,
  supportsChannel,
} from './notification-events';

// =============================================================================
// Notification event registry — tests (issue #121, epic #109)
// =============================================================================
//
// This is a small, pure data module, so the value here is not in restating
// today's three seeded events — it is in the INVARIANTS that must keep
// holding as more events are added later. Every structural check below is
// written as a loop over `NOTIFICATION_EVENTS`, never hardcoded to today's
// count or contents, so it keeps guarding the registry as it grows.
// =============================================================================

describe('NOTIFICATION_EVENTS structural invariants', () => {
  it('has at least one event registered', () => {
    // Sanity check for the loops below: an empty array would make every
    // `.every(...)` assertion in this file vacuously true.
    expect(NOTIFICATION_EVENTS.length).toBeGreaterThan(0);
  });

  it('every key is unique', () => {
    const keys = NOTIFICATION_EVENTS.map((event) => event.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every event declares at least one channel', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.channels.length).toBeGreaterThan(0);
    }
  });

  it('every declared channel is a member of NOTIFICATION_CHANNELS', () => {
    for (const event of NOTIFICATION_EVENTS) {
      for (const channel of event.channels) {
        expect(NOTIFICATION_CHANNELS).toContain(channel);
      }
    }
  });

  it('every event has a non-empty label', () => {
    // Rendered as the row heading on the preferences page (#126) — a blank
    // label ships a row with no heading.
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('every event has a non-empty description', () => {
    // The only place "why did I get this?" is answered — a blank
    // description ships a blank row.
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('mandatory implies defaultEnabled: true', () => {
    // The most valuable invariant in this file. `mandatory` with
    // `defaultEnabled: false` is self-contradictory: it asserts a user
    // cannot turn off something that is already off. Every mandatory event,
    // present and future, must default to enabled.
    for (const event of NOTIFICATION_EVENTS) {
      if (event.mandatory === true) {
        expect(event.defaultEnabled).toBe(true);
      }
    }
  });

  it('every key follows the documented "<area>.<event>" convention', () => {
    // This is a CONVENTION the three seeded keys happen to follow (see the
    // "KEYS ARE NAMESPACED" comment on NOTIFICATION_EVENTS in
    // notification-events.ts), not a functional requirement enforced
    // anywhere else in the registry's code — findEvent/channelsFor/etc. treat
    // `key` as an opaque string. This test exists so that if the convention
    // is ever deliberately abandoned, the change is a conscious edit to this
    // test rather than a silent drift.
    const NAMESPACED_KEY = /^[a-z]+(_[a-z]+)*\.[a-z]+(_[a-z]+)*$/;
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.key).toMatch(NAMESPACED_KEY);
    }
  });
});

describe('findEvent', () => {
  it('returns the definition for a known key', () => {
    const event = findEvent('security.role_changed');
    expect(event).toBeDefined();
    expect(event?.key).toBe('security.role_changed');
  });

  it('returns undefined for an unknown key', () => {
    expect(findEvent('does.not_exist')).toBeUndefined();
  });
});

describe('channelsFor', () => {
  it("returns the event's declared channels for a known key", () => {
    expect(channelsFor('security.role_changed')).toEqual(['email', 'browser']);
  });

  it('returns an empty array for an unknown key, rather than throwing', () => {
    expect(() => channelsFor('does.not_exist')).not.toThrow();
    expect(channelsFor('does.not_exist')).toEqual([]);
  });

  it('returns a defensive copy: mutating the result does not affect a later call', () => {
    // Called out specifically by the implementer: a caller sorting the
    // result in place (or pushing to it) must not silently reconfigure
    // delivery for every later dispatch in the process.
    const first = channelsFor('security.role_changed');
    first.sort().reverse();
    first.push('email');
    first.length = 0;

    const second = channelsFor('security.role_changed');
    expect(second).toEqual(['email', 'browser']);
  });

  it('returns a fresh array instance on every call', () => {
    const first = channelsFor('security.role_changed');
    const second = channelsFor('security.role_changed');
    expect(first).not.toBe(second);
  });
});

describe('supportsChannel', () => {
  it('is true for a channel the event declares', () => {
    expect(supportsChannel('security.role_changed', 'email')).toBe(true);
    expect(supportsChannel('security.role_changed', 'browser')).toBe(true);
  });

  it('is false for a channel the event does not declare', () => {
    expect(supportsChannel('allowlist.invitation', 'browser')).toBe(false);
  });

  it('is false for an unknown key', () => {
    expect(supportsChannel('does.not_exist', 'email' as NotificationChannel)).toBe(
      false,
    );
  });
});

describe('isMandatory', () => {
  it('is true for a mandatory event', () => {
    expect(isMandatory('security.role_changed')).toBe(true);
  });

  it('is false for a non-mandatory event', () => {
    expect(isMandatory('user.welcome')).toBe(false);
    expect(isMandatory('allowlist.invitation')).toBe(false);
  });

  it('is false for an unknown key', () => {
    expect(isMandatory('does.not_exist')).toBe(false);
  });
});

describe('seeded events', () => {
  it('security.role_changed is mandatory and supports both channels', () => {
    const event = findEvent('security.role_changed');
    expect(event?.mandatory).toBe(true);
    expect(event?.channels).toEqual(
      expect.arrayContaining(['email', 'browser']),
    );
    expect(event?.channels).toHaveLength(2);
  });

  it('the three practice reminders are registered (epic #56 / E7)', () => {
    // The registry is the source of truth the hourly task, the preferences
    // matrix and the delivery records all read. An event the task can raise
    // that is NOT here is dispatched nowhere at all: `notify` logs a debug
    // line for an unknown key and returns.
    for (const key of [
      'practice.daily_reminder',
      'practice.review_due',
      'streak.at_risk',
    ]) {
      const event = findEvent(key);
      expect(event).toBeDefined();
      expect(event?.channels).toEqual(expect.arrayContaining(['email', 'browser']));
    }
  });

  it('none of the three practice reminders is mandatory', () => {
    // THE PRODUCT RULE, not a detail of the data. `mandatory` is reserved for
    // a fact a user must not be able to silence — a privilege or security
    // change. A study reminder a learner cannot switch off is exactly the
    // "pressure... to increase engagement metrics" VISION.md rules out by
    // name, so a future edit adding `mandatory: true` to any of these three
    // has to delete this test and explain itself.
    for (const key of [
      'practice.daily_reminder',
      'practice.review_due',
      'streak.at_risk',
    ]) {
      expect(isMandatory(key)).toBe(false);
      expect(findEvent(key)?.mandatory).toBeUndefined();
    }
  });

  it('streak.at_risk is the one reminder that defaults OFF', () => {
    // habit-streaks.md §5.3: it is the only one of the three that references
    // something the learner could lose, and an unrequested loss-framed
    // message is the pressure VISION.md forbids. The other two default on.
    expect(findEvent('streak.at_risk')?.defaultEnabled).toBe(false);
    expect(findEvent('practice.daily_reminder')?.defaultEnabled).toBe(true);
    expect(findEvent('practice.review_due')?.defaultEnabled).toBe(true);
  });

  it('account.data_reset (issue #270) is mandatory, defaults on, and is email-only', () => {
    // The registry's own stated invariant ("mandatory implies defaultEnabled:
    // true", asserted generically above) holds for this entry too — this test
    // pins the SPECIFIC values rather than only the invariant, the same way
    // the seeded `security.role_changed` check above does. `channels` is
    // exactly `['email']`, not merely a superset containing it: a browser
    // notification would render in the same tab that just watched the reset
    // succeed, which is the one reader who does not need to be told again —
    // see this event's own comment in notification-events.ts.
    const event = findEvent('account.data_reset');
    expect(event).toBeDefined();
    expect(event?.mandatory).toBe(true);
    expect(event?.defaultEnabled).toBe(true);
    expect(event?.channels).toEqual(['email']);
  });

  it('allowlist.invitation is email-only', () => {
    // Its recipient has no account and no open tab by definition — that is
    // what being newly allowlisted means — so a browser channel would be
    // meaningless: there is no session to render a notification into. A
    // future edit adding 'browser' here needs to explain how an
    // unauthenticated, session-less recipient would ever see it.
    const event = findEvent('allowlist.invitation');
    expect(event?.channels).toEqual(['email']);
  });
});
