/**
 * "A new version is available" as React state (issue #359, epic #345).
 *
 * A thin subscription over `sw/registerServiceWorker.ts`'s publisher, so no
 * component reaches for `navigator.serviceWorker` — which jsdom does not
 * implement, and which would make every consumer of this state untestable.
 */

import { useCallback, useEffect, useState } from 'react';
import { onUpdateReady, type ApplyUpdate } from '../sw/registerServiceWorker';

export interface ServiceWorkerUpdateState {
  updateReady: boolean;
  /** Promotes the waiting worker. The page reloads once it takes control. */
  applyUpdate: () => void;
}

export function useServiceWorkerUpdate(): ServiceWorkerUpdateState {
  const [apply, setApply] = useState<ApplyUpdate | null>(null);

  useEffect(() => {
    // `setApply(() => fn)` — a bare `setApply(fn)` would have React call the
    // callback as a state updater instead of storing it, which here would
    // reload the page the instant an update was detected.
    return onUpdateReady((applyUpdate) => setApply(() => applyUpdate));
  }, []);

  const applyUpdate = useCallback(() => {
    apply?.();
  }, [apply]);

  return { updateReady: apply !== null, applyUpdate };
}
