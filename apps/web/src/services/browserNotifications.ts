/**
 * The native `Notification` Web API — the two calls this app makes against it.
 *
 * Issue #127, epic #109.
 *
 * =============================================================================
 * THIS IS DECORATION. THE NOTIFICATION CENTRE IS THE FEATURE.
 * =============================================================================
 *
 * Everything in this file can fail, be blocked, or be unavailable, and the
 * product must be unaffected. Permission is denied by a large fraction of users
 * and cannot be re-requested; the API does not exist in a non-secure context or
 * under the test runner's jsdom; some hardened browsers define `Notification`
 * and throw on touching it. So every function here DEGRADES SILENTLY and none
 * of them throws.
 *
 * The durable surface is `GET /api/notifications` behind the bell, which works
 * with permission denied, with the SSE stream down, and in a browser that has
 * never heard of `Notification`. Epic #109 is explicit that a feature existing
 * only as an OS toast does not exist at all for the users who denied it.
 *
 * SEPARATED FROM `hooks/useBrowserNotificationPermission.ts` ON PURPOSE. That
 * hook OBSERVES permission and must never request it — it runs on mount, and a
 * request on mount is the exact mistake described below. This module ACTS, and
 * every function in it is reachable only from a user gesture or from an event
 * that has already arrived. Keeping the two apart is what makes "does anything
 * prompt on load?" answerable by looking at one file's callers.
 */

import type { AppNotification } from '../types';

/** Is the constructor there at all, and safe to touch? */
function isSupported(): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  try {
    // The ACCESS is the test, not the presence of the key. Some embedded and
    // privacy-hardened browsers expose `Notification` and throw on reading
    // `permission` — the same defence `useBrowserNotificationPermission` takes,
    // for the same reason.
    void window.Notification.permission;
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the browser for permission. **Call this only from a user gesture.**
 *
 * =============================================================================
 * WHY THE CALL SITE MATTERS MORE THAN THIS FUNCTION DOES
 * =============================================================================
 *
 * There is exactly ONE caller, and it is a click handler on the "Allow
 * notifications" button inside the explanatory banner on
 * `/settings/notifications` (`components/settings/NotificationSettings.tsx`,
 * wired by `pages/UserNotificationsPage.tsx`). That is not a stylistic
 * preference:
 *
 *   * A DENIAL IS EFFECTIVELY PERMANENT. The app cannot re-prompt and cannot
 *     undo it; only the user can, buried in browser site settings. The prompt
 *     is a ONE-SHOT RESOURCE, and spending it on somebody who never asked for
 *     notifications kills the feature for that person for good.
 *   * Browsers actively penalise prompts with no user gesture. Chrome
 *     suppresses them into a quiet UI, Firefox requires the gesture outright and
 *     auto-dismisses without one, and Safari throws. So a prompt on mount is not
 *     merely rude — it frequently does not even reach the user, while still
 *     burning the coin.
 *
 * DO NOT CALL THIS FROM AN EFFECT, A ROUTE TRANSITION, A TIMER, OR ON MOUNT.
 * If a second call site ever seems necessary, it must be a second deliberate
 * click, not a second automatic trigger.
 *
 * @returns the resulting permission, or `null` when the browser has no usable
 *          `Notification` API. The caller should refresh its permission state
 *          from `useBrowserNotificationPermission().refresh()` regardless of
 *          what comes back — that hook is the single source of truth for what
 *          the UI renders, and this return value is only what one call happened
 *          to see.
 */
export async function requestBrowserNotificationPermission(): Promise<
  NotificationPermission | null
> {
  if (!isSupported()) return null;

  try {
    // `Notification.requestPermission()` has two signatures across browsers —
    // a promise (modern, everywhere current) and a legacy callback (old Safari).
    // `await` handles the promise form and, on the callback form, simply
    // resolves the `undefined` it returns; the UI is refreshed from
    // `Notification.permission` afterwards either way, so the legacy path
    // degrades to "the banner updates on the next visibility change" rather
    // than to a broken button.
    const result = await window.Notification.requestPermission();
    return result ?? window.Notification.permission;
  } catch {
    // A throw here is a browser that refuses the request outright. Not an error
    // worth surfacing: the permission state is unchanged, and the banner that
    // prompted the click already explains what is going on.
    return null;
  }
}

/**
 * Raise a native toast for a notification that just arrived over SSE.
 *
 * SILENT NO-OP unless permission is ALREADY `granted`. It never requests —
 * requesting from an incoming event would fire a prompt with no user gesture,
 * which is the failure mode the whole permission section above exists to
 * prevent.
 *
 * @param onClick invoked when the user activates the toast. The window is
 *        focused first, because a toast is clicked from outside the browser and
 *        navigating a background tab the user cannot see is not a useful
 *        outcome.
 * @returns whether a toast was actually raised. For tests and diagnostics; no
 *          caller makes a decision from it, because there is no fallback to
 *          fall back to — the notification is already in the centre.
 */
export function showNativeNotification(
  notification: AppNotification,
  onClick?: (notification: AppNotification) => void,
): boolean {
  if (!isSupported()) return false;

  try {
    if (window.Notification.permission !== 'granted') return false;

    const toast = new window.Notification(notification.title, {
      body: notification.body,

      // `tag` COLLAPSES DUPLICATES. The API publishes to every connection the
      // user has open, so someone with four tabs receives four copies of the
      // same event and would otherwise get four identical OS toasts. Tagging by
      // the notification's id makes the browser replace rather than stack them,
      // which is the only mechanism available — the tabs cannot coordinate, and
      // adding cross-tab leader election for a toast would be far more machinery
      // than the problem deserves.
      tag: notification.id,

      // NOT `renotify`. With the tag above, re-notifying would restore exactly
      // the duplicate alerting the tag exists to suppress.
    });

    if (onClick) {
      toast.onclick = () => {
        try {
          // The user clicked something outside the browser; without this the
          // navigation happens in a window they still cannot see.
          window.focus();
          onClick(notification);
        } finally {
          // Dismiss it ourselves. Platform behaviour on click varies — some
          // leave the toast sitting in a notification centre — and a toast that
          // outlives the click that handled it invites a second one.
          toast.close();
        }
      };
    }

    return true;
  } catch {
    // Constructing a `Notification` throws on Android Chrome, where the API is
    // service-worker-only. That is a supported outcome, not a bug: the
    // notification is already in the centre and the bell already shows it.
    return false;
  }
}
