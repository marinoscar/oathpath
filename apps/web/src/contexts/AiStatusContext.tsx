/**
 * Whether AI is available to the signed-in user — fetched once, read everywhere.
 *
 * Issue #39, epic #25. Mounted inside `ProtectedRoute` in `App.tsx`, ABOVE both
 * the app shell and `/setup/ai-key`, so the key setup screen and the gate share
 * one answer: saving a key on that screen releases the gate without a page
 * reload, because both are looking at this state.
 *
 * =============================================================================
 * TWO INDEPENDENT FACTS. THERE IS NO COMBINED FLAG, AND THERE MUST NOT BE.
 * =============================================================================
 *
 *   userKeyConfigured === false  ->  HARD BLOCK into /setup/ai-key (#39)
 *   systemReady === false        ->  NOT a block; point-of-use message (#43)
 *
 * Merging them produces the exact failure the API's two-flag shape exists to
 * avoid: a user blocked by missing ADMINISTRATOR configuration being told to
 * add a key they already have. That sends someone to fix the one thing that is
 * not wrong, and there is nothing on screen to tell them otherwise.
 *
 * If you are here to add a `ready` helper because "every caller checks both" —
 * every caller checks both because the answers mean different things.
 *
 * =============================================================================
 * FETCHED ONCE, NOT PER RENDER
 * =============================================================================
 *
 * The gate consults this on every navigation. Putting the request in the gate
 * would fire it on every route change — a request storm behind a first-run
 * screen a new user cannot get past, which is a self-inflicted outage on the
 * worst possible page. So the fetch lives here, on mount, and is repeated only
 * when something is known to have changed (`refresh`).
 *
 * =============================================================================
 * THE GATE FAILS OPEN, DELIBERATELY
 * =============================================================================
 *
 * When the status request FAILS — the API is down, the network dropped — the
 * user is let through rather than blocked. See `hasError` below: blocking on a
 * failed status check would lock every user out of the entire application
 * because one endpoint is unavailable, and the thing that endpoint gates is a
 * feature rather than a security boundary. A user without a key who gets in
 * meets a point-of-use failure; a user WITH a key who is locked out has no
 * recourse at all.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

import { getAiStatus } from '../services/api';
import type { AiStatus } from '../types';
import { useIsMounted } from '../hooks/useIsMounted';

interface AiStatusContextValue {
  /** The two facts, or `null` before the first response. */
  status: AiStatus | null;

  /** True until the first response settles, success or failure. */
  isLoading: boolean;

  /**
   * The status could not be read.
   *
   * Consumers treat this as "do not block" rather than as "not configured" —
   * see the file header.
   */
  hasError: boolean;

  /** Re-read the status. Called after a key is saved or removed. */
  refresh: () => Promise<void>;
}

const AiStatusContext = createContext<AiStatusContextValue | undefined>(
  undefined,
);

/**
 * Read the AI availability status.
 *
 * @throws if used outside the provider, which is a wiring bug rather than a
 *         runtime condition — a silent `null` here would make the gate fail
 *         open everywhere and look like it was working.
 */
export function useAiStatus(): AiStatusContextValue {
  const context = useContext(AiStatusContext);
  if (!context) {
    throw new Error('useAiStatus must be used within an AiStatusProvider');
  }
  return context;
}

interface AiStatusProviderProps {
  /**
   * Children, when mounted directly. Omitted when used as a react-router
   * layout route, in which case an `<Outlet />` is rendered instead.
   */
  children?: ReactNode;
}

export function AiStatusProvider({ children }: AiStatusProviderProps) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setHasError(false);
      const data = await getAiStatus();
      if (isMounted()) setStatus(data);
    } catch {
      // The message is deliberately not kept. Nothing renders it: the only
      // decision this powers is "block or not", and the answer on failure is
      // "not". Surfacing an AI-status error over the whole application would
      // be alarming out of all proportion to what it means.
      if (isMounted()) setHasError(true);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ status, isLoading, hasError, refresh }),
    [status, isLoading, hasError, refresh],
  );

  return (
    <AiStatusContext.Provider value={value}>
      {children ?? <Outlet />}
    </AiStatusContext.Provider>
  );
}
