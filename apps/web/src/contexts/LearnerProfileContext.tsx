/**
 * The signed-in learner's own journey profile — fetched once, read everywhere.
 *
 * Issue #72, epic #50. Mounted inside `RequireAiKey` in `App.tsx`, ABOVE both
 * `RequireOrientation` and the `/setup/journey` screen it redirects to, so the
 * two share one answer: saving orientation on that screen releases the gate
 * without a page reload, because both are looking at this state.
 *
 * This is `contexts/AiStatusContext.tsx`'s idiom, copied deliberately rather
 * than reinvented — same mount position relative to its gate and its exempt
 * setup route, same fetch-on-mount, same fail-open. What follows is why each of
 * those properties is load-bearing here too.
 *
 * =============================================================================
 * FETCHED ONCE, NOT PER NAVIGATION
 * =============================================================================
 *
 * `RequireOrientation` consults this on every navigation. Putting the request
 * in the gate would fire it on every route change — a request storm behind a
 * first-run screen a new learner cannot get past, which is a self-inflicted
 * outage on the worst possible page. So the fetch lives HERE, on mount, and is
 * repeated only when something is known to have changed.
 *
 * The provider is a react-router LAYOUT route, which is what makes "on mount"
 * mean "once per session" rather than "once per page": react-router keeps a
 * layout element mounted while its children swap, so navigating Home → Learn →
 * Settings does not remount this. `__tests__/contexts/LearnerProfileContext.test.tsx`
 * asserts the request COUNT across several navigations, because that is the
 * only way this property can be checked — a component that refetched on every
 * route change would look identical on screen.
 *
 * =============================================================================
 * A SAVE PUSHES ITS OWN ANSWER BACK, RATHER THAN TRIGGERING A REFETCH
 * =============================================================================
 *
 * `PUT /api/journey/profile` replies with exactly the payload `GET` returns.
 * So `applyProfile` exists alongside `refresh`: the orientation form hands over
 * the response it already has, and the gate is released on the same tick with
 * no second round trip. `refresh` stays for a caller that has reason to believe
 * the server knows something the client does not.
 *
 * =============================================================================
 * IT FAILS OPEN, DELIBERATELY
 * =============================================================================
 *
 * When the profile request FAILS — the API is down, the network dropped — the
 * learner is let through rather than blocked. Blocking on a failed read would
 * lock every user out of the entire application because one endpoint is
 * unavailable, and what this gates is a product question ("have you told us
 * about your situation") rather than a security boundary: the API enforces the
 * real authorization on every route regardless of what this decides.
 *
 * This is the identical trade `RequireAiKey` makes, and it points the same way.
 * An unoriented learner who gets in meets a product with no test version chosen
 * — recoverable, and visible. An ORIENTED learner who is locked out has no
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

import { getJourneyProfile } from '../services/api';
import type {
  CivicsTestVersionOption,
  JourneyProfile,
  JourneyProfileResponse,
  UsStateOption,
} from '../types';
import { useIsMounted } from '../hooks/useIsMounted';

interface LearnerProfileContextValue {
  /** The caller's own profile, or `null` before the first response. */
  profile: JourneyProfile | null;

  /**
   * Every seeded civics test version.
   *
   * Served with the profile so the orientation form can name the test a filing
   * date selects — from `filedFrom`, which is server data — without the
   * browser holding a copy of the version list or of the cutoff rule.
   */
  testVersions: CivicsTestVersionOption[];

  /** The 50 states, the federal district and the five populated territories. */
  states: UsStateOption[];

  /** True until the first response settles, success or failure. */
  isLoading: boolean;

  /**
   * The profile could not be read.
   *
   * Consumers treat this as "do not block" rather than as "not oriented" — see
   * the file header.
   */
  hasError: boolean;

  /** Re-read the profile from the server. */
  refresh: () => Promise<void>;

  /**
   * Adopt a response the caller already has — the body of a successful `PUT`.
   *
   * Saves the round trip a `refresh` would spend re-reading what the server
   * just said, and releases the gate on the same tick.
   */
  applyProfile: (response: JourneyProfileResponse) => void;
}

const LearnerProfileContext = createContext<
  LearnerProfileContextValue | undefined
>(undefined);

/**
 * Read the signed-in learner's journey profile.
 *
 * @throws if used outside the provider, which is a wiring bug rather than a
 *         runtime condition — a silent `null` here would make the gate fail
 *         open everywhere and look like it was working.
 */
export function useLearnerProfile(): LearnerProfileContextValue {
  const context = useContext(LearnerProfileContext);
  if (!context) {
    throw new Error(
      'useLearnerProfile must be used within a LearnerProfileProvider',
    );
  }
  return context;
}

interface LearnerProfileProviderProps {
  /**
   * Children, when mounted directly. Omitted when used as a react-router
   * layout route, in which case an `<Outlet />` is rendered instead.
   */
  children?: ReactNode;
}

export function LearnerProfileProvider({
  children,
}: LearnerProfileProviderProps) {
  const [profile, setProfile] = useState<JourneyProfile | null>(null);
  const [testVersions, setTestVersions] = useState<CivicsTestVersionOption[]>(
    [],
  );
  const [states, setStates] = useState<UsStateOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const isMounted = useIsMounted();

  const applyProfile = useCallback(
    (response: JourneyProfileResponse) => {
      if (!isMounted()) return;
      setProfile(response.profile);
      setTestVersions(response.testVersions);
      setStates(response.states);
      // A successful write is also a successful read: clearing the error here
      // is what lets a learner who saved during an outage stop being treated
      // as unreadable.
      setHasError(false);
    },
    [isMounted],
  );

  const refresh = useCallback(async () => {
    try {
      setHasError(false);
      const data = await getJourneyProfile();
      applyProfile(data);
    } catch {
      // The message is deliberately not kept. Nothing renders it: the only
      // decision this powers is "block or not", and the answer on failure is
      // "not". Surfacing a profile-read error across the whole application
      // would be alarming out of all proportion to what it means.
      if (isMounted()) setHasError(true);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [applyProfile, isMounted]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      profile,
      testVersions,
      states,
      isLoading,
      hasError,
      refresh,
      applyProfile,
    }),
    [
      profile,
      testVersions,
      states,
      isLoading,
      hasError,
      refresh,
      applyProfile,
    ],
  );

  return (
    <LearnerProfileContext.Provider value={value}>
      {children ?? <Outlet />}
    </LearnerProfileContext.Provider>
  );
}
