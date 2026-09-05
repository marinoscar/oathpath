/**
 * Service worker registration and the update handshake (issue #359, epic #345).
 *
 * -----------------------------------------------------------------------------
 * WHERE THE WORKER IS DISABLED, AND WHY EACH ONE MATTERS
 * -----------------------------------------------------------------------------
 *
 *   test  — ALWAYS off. The suite's fixtures come from MSW, which works by
 *           patching `fetch`; a service worker sits in front of that and would
 *           answer from Cache Storage instead, turning a deterministic suite
 *           into one that depends on what a previous test cached. jsdom has no
 *           `navigator.serviceWorker` either, so the guard also keeps this
 *           module importable from a component test.
 *   dev   — off unless `VITE_ENABLE_SW=true`. A worker caching a dev server's
 *           output is the classic "my edit didn't apply" afternoon, and the
 *           precached shell would be a bundle Vite has already replaced.
 *   prod  — on.
 *
 * -----------------------------------------------------------------------------
 * THE UPDATE HANDSHAKE
 * -----------------------------------------------------------------------------
 *
 * The worker does not call `skipWaiting()` on install (see the header of
 * `service-worker.js`), so a new deployment installs and then WAITS. That is
 * deliberate: swapping the JavaScript out mid-session would drop a learner's
 * half-answered question, and — worse — a page can end up running an old
 * bundle against a new API for as long as the tab stays open.
 *
 * So the sequence is:
 *
 *   1. a new worker reaches `installed` while one is already controlling the
 *      page (`registration.waiting`, or `updatefound` -> `statechange`);
 *   2. `notifyUpdateReady` publishes an `applyUpdate` callback;
 *   3. `UpdateAvailableSnackbar` renders "A new version is available";
 *   4. the learner presses Reload, which posts `SKIP_WAITING` to the waiting
 *      worker;
 *   5. the worker activates, `controllerchange` fires, and this module reloads
 *      the page ONCE.
 *
 * Nobody clears site data at any point, which is the acceptance criterion.
 *
 * The publish/subscribe pair exists so the React layer never touches
 * `navigator.serviceWorker` directly: `useServiceWorkerUpdate` subscribes, and
 * a test can drive step 2 with one call instead of simulating a browser API
 * jsdom does not implement.
 */

export type ApplyUpdate = () => void;
type UpdateListener = (applyUpdate: ApplyUpdate) => void;

const listeners = new Set<UpdateListener>();
/** Latched, so a component that mounts after the update is still told. */
let pendingApplyUpdate: ApplyUpdate | null = null;

/** Subscribes to "a new version is waiting". Returns an unsubscribe function. */
export function onUpdateReady(listener: UpdateListener): () => void {
  listeners.add(listener);
  if (pendingApplyUpdate) listener(pendingApplyUpdate);
  return () => {
    listeners.delete(listener);
  };
}

/** Publishes step 2 above. Exported for the registration flow and for tests. */
export function notifyUpdateReady(applyUpdate: ApplyUpdate): void {
  pendingApplyUpdate = applyUpdate;
  listeners.forEach((listener) => listener(applyUpdate));
}

/** Test seam: drops the latched update so suites do not leak into each other. */
export function resetUpdateStateForTests(): void {
  pendingApplyUpdate = null;
  listeners.clear();
}

interface RegistrationEnv {
  MODE?: string;
  PROD?: boolean;
  VITE_ENABLE_SW?: string;
}

export function shouldRegisterServiceWorker(
  env: RegistrationEnv = import.meta.env as unknown as RegistrationEnv,
): boolean {
  if (env.MODE === 'test') return false;
  if (env.PROD) return true;
  return env.VITE_ENABLE_SW === 'true';
}

export async function registerServiceWorker(): Promise<void> {
  if (!shouldRegisterServiceWorker()) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const announce = (worker: ServiceWorker) => {
    notifyUpdateReady(() => worker.postMessage({ type: 'SKIP_WAITING' }));
  };

  // Reload once the promoted worker takes control. Guarded, because
  // `controllerchange` can fire more than once and an ungated reload here is
  // an infinite refresh loop — the single most common way this pattern is got
  // wrong.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');

    // Already waiting when this tab loaded — e.g. the deployment landed while
    // the tab was closed. Without this branch the update is invisible until
    // something else triggers `updatefound`.
    if (registration.waiting && navigator.serviceWorker.controller) {
      announce(registration.waiting);
    }

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // `controller` is null on a FIRST install, and that case is not an
        // update: there is no old bundle to replace and nothing to tell the
        // learner about.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          announce(installing);
        }
      });
    });
  } catch {
    // A failed registration must never take the application down with it. The
    // app works without a service worker; that is the whole degradation story.
  }
}
