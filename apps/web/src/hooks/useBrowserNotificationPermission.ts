/**
 * The browser's CURRENT notification permission, observed — never requested.
 *
 * Issue #126, epic #109. The preferences page has a `browser` column, and a
 * stored preference for it means nothing on its own: the browser, not the app,
 * decides whether a native notification may be raised at all. This hook is how
 * that column tells the truth.
 *
 * THIS HOOK NEVER CALLS `Notification.requestPermission()`. That is the single
 * most important line in the file.
 *
 *   * Browsers penalise sites that prompt on load — Chrome and Firefox both
 *     suppress or auto-deny prompts that are not tied to a user gesture, and
 *     Firefox requires the gesture outright.
 *   * A DENIAL IS EFFECTIVELY PERMANENT. The app cannot re-prompt and cannot
 *     undo it; only the user can, buried in browser site settings. So a prompt
 *     fired by merely opening a settings page spends a one-shot resource on a
 *     user who never asked for notifications, and the cost of losing that coin
 *     flip is that the feature is dead for that person forever.
 *
 * The prompt therefore belongs to a deliberate click, and #127 has now wired
 * one: the "Allow notifications" button in the `default`-state banner of
 * `components/settings/NotificationSettings.tsx`, whose handler lives in
 * `pages/UserNotificationsPage.tsx` and calls
 * `services/browserNotifications.ts`'s `requestBrowserNotificationPermission`.
 *
 * THAT DOES NOT CHANGE THIS FILE'S RULE. The request lives in a click handler
 * three modules away precisely so that nothing on the mount path can reach it;
 * this hook still only ever OBSERVES, and it must stay that way. If a
 * `requestPermission` call ever appears in this file, the separation that makes
 * "does anything prompt on load?" answerable by reading one file is gone.
 *
 * WHY A HOOK RATHER THAN READING `Notification.permission` INLINE
 * ---------------------------------------------------------------
 * Because the value CHANGES UNDER THE PAGE. A user who reads "blocked — allow
 * notifications in your browser settings", opens those settings in another tab,
 * flips the switch and comes back would otherwise still be looking at "blocked"
 * until a full reload — and would reasonably conclude the app is broken. So the
 * value is state, and it is re-read on the two signals that can indicate a
 * change:
 *
 *   1. The Permissions API's `change` event, where available — the exact,
 *     immediate signal.
 *   2. `visibilitychange`, as the fallback for browsers whose Permissions API
 *     does not expose `notifications` (older Safari). Coming back to the tab is
 *     precisely the moment a user who just changed the setting returns.
 */

import { useCallback, useEffect, useState } from 'react';

/**
 * Permission as this app needs to reason about it.
 *
 * `'unsupported'` is a FOURTH state the Web API does not have, and it is not
 * the same as `'denied'`: the browser has refused nothing, it simply has no
 * `Notification` constructor (an old browser, or — the common case in this
 * repo — jsdom under the test runner, and any non-secure-context origin). The
 * UI must say "your browser does not support this", not "you blocked this",
 * because the remedies are completely different and only one of them exists.
 */
export type BrowserNotificationPermission =
  | 'unsupported'
  | 'default'
  | 'granted'
  | 'denied';

/**
 * Read the permission defensively.
 *
 * Feature-detected on every read rather than once at module load: this module
 * is imported by a lazily-loaded page, and a module-level snapshot would also
 * be unpatchable from a test that stubs `window.Notification` after import.
 *
 * The `try` is not decorative. Some embedded and privacy-hardened browsers
 * define `Notification` and THROW on the property access, and this is a
 * settings page — a permission read must never be the thing that blanks it.
 */
function readPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  try {
    const value = window.Notification.permission;
    return value === 'granted' || value === 'denied' ? value : 'default';
  } catch {
    return 'unsupported';
  }
}

export interface UseBrowserNotificationPermissionResult {
  /** What the browser says right now. See `BrowserNotificationPermission`. */
  permission: BrowserNotificationPermission;
  /**
   * Force a re-read.
   *
   * CALLED BY #127's PROMPT HANDLER (`UserNotificationsPage`), in a `finally`,
   * after `Notification.requestPermission()` settles — so the banner moves to
   * its `granted` or `denied` treatment without a reload.
   *
   * Unconditional there rather than driven by the request's return value: the
   * user can dismiss the prompt without choosing (permission stays `default`)
   * and some browsers resolve with nothing useful at all. Re-reading
   * `Notification.permission` is the only answer that is right in every case.
   */
  refresh: () => void;
}

export function useBrowserNotificationPermission(): UseBrowserNotificationPermissionResult {
  // Lazy initialiser, so the read happens once on mount rather than on every
  // render of a component that may re-render on each toggle.
  const [permission, setPermission] = useState<BrowserNotificationPermission>(readPermission);

  const refresh = useCallback(() => {
    setPermission(readPermission());
  }, []);

  useEffect(() => {
    // Re-read once on mount as well as in the initialiser: this page is lazily
    // loaded and the module may have been evaluated long before it mounted.
    refresh();

    const onVisibility = () => {
      // Only when the tab becomes visible. Re-reading as it HIDES is work
      // nobody can see, and the interesting transition is the return.
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // The Permissions API is the precise signal, and is optional in two ways:
    // the API may be absent, and `notifications` may be an unsupported name
    // (Safari), in which case `query` REJECTS rather than returning a status.
    // Both are handled by falling back to `visibilitychange` above.
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => refresh();

    // The `try` wraps the CALL, not just the promise: older WebKit throws a
    // synchronous `TypeError` for an unsupported permission name rather than
    // returning a rejected promise, and an exception escaping an effect would
    // take the whole settings page down over a progressive enhancement.
    try {
      void navigator.permissions
        ?.query({ name: 'notifications' as PermissionName })
        .then((result) => {
          // The component may have unmounted while this promise was in flight;
          // binding the listener then would leak it past the cleanup below.
          if (cancelled) return;
          status = result;
          result.addEventListener('change', onChange);
          refresh();
        })
        .catch(() => {
          // Not supported here. `visibilitychange` remains the fallback; this
          // is an expected outcome, not an error worth surfacing to the user.
        });
    } catch {
      // Same fallback as the rejection path above.
    }

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      status?.removeEventListener('change', onChange);
    };
  }, [refresh]);

  return { permission, refresh };
}
