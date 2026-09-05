/**
 * `beforeinstallprompt`, captured and offered ONCE (issue #359, epic #345).
 *
 * Chromium fires `beforeinstallprompt` when the app meets the installability
 * criteria, and the browser's own mini-infobar is suppressed the moment the
 * event is `preventDefault`ed — so capturing it is also taking responsibility
 * for offering it. This hook holds the event; `components/pwa/InstallPrompt.tsx`
 * renders the offer.
 *
 * THE RULES THIS ENCODES, from the issue's acceptance criteria:
 *
 *   - Offered, never nagged. One dismissal is permanent (as far as this app is
 *     concerned) — `dismiss()` writes a flag and the offer never returns. A
 *     learner who wants to install after dismissing still can, through the
 *     browser's own menu, which is where an install belongs once they have
 *     said no here.
 *   - Accepting or declining the BROWSER's prompt also ends the offer:
 *     `promptInstall()` marks it dismissed either way, because re-offering
 *     something someone just declined is the nagging the criterion rules out.
 *   - Never an interstitial. Nothing here can block the app; the consumer is a
 *     Snackbar.
 *
 * localStorage rather than `user_settings`: this is a per-DEVICE fact ("this
 * phone has been offered the install"), not a per-account preference. Syncing
 * it to the server would suppress the offer on a learner's second device,
 * where the app genuinely is not installed. Every access is wrapped, because
 * Safari's private mode throws on `localStorage` rather than returning null.
 */

import { useCallback, useEffect, useState } from 'react';

export const INSTALL_PROMPT_DISMISSED_KEY = 'oathpath.pwa.install-prompt-dismissed';

/**
 * `beforeinstallprompt` is not in TypeScript's DOM lib — it is a Chromium
 * extension to the platform — so its shape is declared here rather than
 * asserted away with `any` at the call sites.
 */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY) === 'true';
  } catch {
    // Storage unavailable (private mode, blocked cookies). Treat as
    // "not dismissed": the offer is a Snackbar with a close button, so the
    // worst case is one dismissible banner per session, never a blocked app.
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, 'true');
  } catch {
    // Nothing to do. The in-memory state below still hides the offer for this
    // session; it simply will not survive a reload.
  }
}

export interface InstallPromptState {
  /** True only when the browser offered an install AND it has not been dismissed. */
  canInstall: boolean;
  /** Shows the browser's own install dialog, then ends the offer either way. */
  promptInstall: () => Promise<void>;
  /** Ends the offer permanently. */
  dismiss: () => void;
}

export function useInstallPrompt(): InstallPromptState {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed());

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      // Suppresses Chromium's mini-infobar so the offer appears once, in this
      // application's own voice, at a moment we control.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      // Installed by any route — our button, or the browser menu. Either way
      // there is nothing left to offer.
      setDeferred(null);
      setDismissed(true);
      writeDismissed();
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed();
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    setDeferred(null);
    setDismissed(true);
    writeDismissed();
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      // A deferred prompt can only be used once and expires; a failure here is
      // not something the learner can act on.
    }
  }, [deferred]);

  return { canInstall: deferred !== null && !dismissed, promptInstall, dismiss };
}
