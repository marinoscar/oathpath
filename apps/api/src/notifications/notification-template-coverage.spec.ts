import { EMAIL_TEMPLATES, isEmailTemplateName } from '../email';
import { EVENT_BROWSER_TEMPLATES } from './channels/browser-notification.channel';
import { EVENT_EMAIL_TEMPLATES } from './channels/email-notification.channel';
import { NOTIFICATION_EVENTS } from './notification-events';

// =============================================================================
// Registry ↔ template coverage (epic #56 / E7, generalising #128's wiring)
// =============================================================================
//
// "Adding a notification costs ONE registry entry" is the promise epic #109
// makes and CLAUDE.md restates as a three-step recipe. Step 1 is the registry
// entry; step 2 is a template PER DECLARED CHANNEL. Nothing in the type system
// connects the two — `NOTIFICATION_EVENTS` is an array of plain data and the
// two channel maps are `Partial<Record<string, ...>>` keyed by an unchecked
// string — so step 1 without step 2 compiles perfectly and fails at send time,
// once, per recipient, in production.
//
// This file is that missing link, and it loops over the registry rather than
// naming today's events, so it keeps holding as the registry grows.
//
// WHAT EACH HALF ACTUALLY COSTS WHEN IT IS MISSING, because the two failure
// modes are different and the asymmetry between the channels is deliberate:
//
//   * NO EMAIL TEMPLATE -> `EmailNotificationChannel.deliver` records a FAILED
//     delivery reading "No email template is registered for event '...'".
//     Nothing is sent, and for an hourly trigger like E7's reminders that is
//     one failed row per eligible learner per day, forever.
//
//   * NO BROWSER TEMPLATE -> `BrowserNotificationChannel.render` falls back to
//     the registry's own `label`/`description` and logs a warn. The user still
//     gets a row, and it is still true — but it is generic where the event
//     promised something specific ("4 questions ready to review" becomes
//     "Questions ready to review"). That fallback is a safety net for an
//     event nobody wired, NOT a licence to skip the entry, so this file
//     requires the entry anyway and lets the fallback keep covering the case
//     it was written for: a bug, caught in a log, not a design.
// =============================================================================

const EMAIL_EVENTS = NOTIFICATION_EVENTS.filter((event) =>
  event.channels.includes('email'),
).map((event) => event.key);

const BROWSER_EVENTS = NOTIFICATION_EVENTS.filter((event) =>
  event.channels.includes('browser'),
).map((event) => event.key);

describe('every event declaring `email` has a registered email template', () => {
  it('there is at least one such event (so the loops below are not vacuous)', () => {
    expect(EMAIL_EVENTS.length).toBeGreaterThan(0);
  });

  it.each(EMAIL_EVENTS)('%s maps to a template name', (key) => {
    expect(EVENT_EMAIL_TEMPLATES[key]).toBeDefined();
  });

  it.each(EMAIL_EVENTS)(
    '%s maps to a template that is actually registered in EMAIL_TEMPLATES',
    (key) => {
      // BOTH HALVES, and this is the second one. A name in
      // `EVENT_EMAIL_TEMPLATES` that no longer exists in `EMAIL_TEMPLATES` is
      // the same failed delivery as no name at all — `EmailTemplateName`
      // makes a typo a compile error, but a template DELETED after being
      // mapped is not.
      const name = EVENT_EMAIL_TEMPLATES[key];
      expect(name).toBeDefined();
      expect(isEmailTemplateName(name as string)).toBe(true);
      expect(typeof EMAIL_TEMPLATES[name as keyof typeof EMAIL_TEMPLATES]).toBe(
        'function',
      );
    },
  );
});

describe('every event declaring `browser` has a registered browser template', () => {
  it('there is at least one such event', () => {
    expect(BROWSER_EVENTS.length).toBeGreaterThan(0);
  });

  it.each(BROWSER_EVENTS)('%s maps to a renderer', (key) => {
    expect(typeof EVENT_BROWSER_TEMPLATES[key]).toBe('function');
  });
});

describe('neither map carries an entry for an event that does not exist', () => {
  // The reverse direction: a mapping left behind by a retired event is dead
  // weight that reads as a live feature, and it is exactly what a future
  // reader would consult to answer "is this event still sent?".
  const KNOWN_KEYS = new Set(NOTIFICATION_EVENTS.map((event) => event.key));

  it('EVENT_EMAIL_TEMPLATES has no orphaned keys', () => {
    for (const key of Object.keys(EVENT_EMAIL_TEMPLATES)) {
      expect(KNOWN_KEYS.has(key)).toBe(true);
    }
  });

  it('EVENT_BROWSER_TEMPLATES has no orphaned keys', () => {
    for (const key of Object.keys(EVENT_BROWSER_TEMPLATES)) {
      expect(KNOWN_KEYS.has(key)).toBe(true);
    }
  });

  it('no event maps to a browser renderer for a channel it does not declare', () => {
    // The registry's per-event `channels` list is the source of truth; a
    // renderer for an event that never offers the channel is unreachable code
    // that looks like a feature.
    for (const key of Object.keys(EVENT_BROWSER_TEMPLATES)) {
      expect(BROWSER_EVENTS).toContain(key);
    }
  });
});
