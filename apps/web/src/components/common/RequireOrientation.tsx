/**
 * Hard-block a learner who has not finished orientation.
 *
 * Issue #72, epic #50, `docs/specs/journey-shell.md` §5. Until orientation is
 * done the product does not know which civics test applies, which state's
 * questions to ask, or whether there is an interview to count down to — so
 * every screen behind this gate would be guessing, and §10's honesty rule
 * forbids exactly that.
 *
 * Composed like `ProtectedRoute` and `RequireAiKey` — a layout route rendering
 * an `<Outlet />` — so it wraps the app shell in `App.tsx` with no per-page
 * opt-in to forget.
 *
 * =============================================================================
 * IT CHAINS AFTER `RequireAiKey`, AND THE ORDER IS DELIBERATE
 * =============================================================================
 *
 * A caller reaches this gate only after clearing `RequireAiKey`, so a keyless,
 * unoriented learner is sent to `/setup/ai-key` FIRST. Orientation is a product
 * question — what test do you take, when is your interview — and asking it of
 * someone who cannot yet use the AI-driven parts of the product at all would be
 * work spent before the gate that actually blocks them has cleared.
 *
 * The two gates never fight, because each redirects to a route mounted outside
 * ITSELF but inside the other's cleared region: `/setup/ai-key` sits outside
 * `RequireAiKey`, and `/setup/journey` sits inside it and outside this one.
 *
 * =============================================================================
 * THE EXEMPT ROUTES, IN FULL — THE SAME THREE `RequireAiKey` HAS
 * =============================================================================
 *
 * 1. `/setup/journey` itself. It is mounted OUTSIDE this gate in `App.tsx`
 *    rather than exempted here, which is the stronger arrangement: a redirect
 *    loop is then structurally impossible rather than prevented by a string
 *    comparison somebody could edit.
 *
 * 2. LOGOUT. Not a route in this application — it is an action on the app bar,
 *    and the orientation screen carries its own control. A blocked learner must
 *    always be able to leave.
 *
 * 3. `/admin/*` FOR A CALLER HOLDING `system_settings:read`.
 *
 *    The same fresh-install reasoning `RequireAiKey`'s exemption 3 gives, one
 *    gate along: the first administrator has to reach `/admin/settings/ai` to
 *    bind a model, and `/admin/settings/email` to configure mail, before they
 *    have any reason to fill in an orientation form about their own
 *    naturalization interview. Blocking that is a deadlock with no way out from
 *    inside the product — and here it is a particularly silly one, since the
 *    administrator may not be a learner at all.
 *
 *    Keyed on the PERMISSION, not on a role name, and on the SAME string
 *    `RequireAiKey` already checks. NO NEW PERMISSION STRING IS INTRODUCED —
 *    the set in `apps/api/src/common/constants/roles.constants.ts` is closed.
 *    A non-admin gains nothing: `RequirePermission` still applies underneath,
 *    so they reach the route and are bounced by it exactly as before.
 *
 * =============================================================================
 * `stage` IS EXPLICITLY NOT CONSULTED HERE
 * =============================================================================
 *
 * The check is `orientationCompletedAt`, and only that. `stage` moves forward
 * through transitions later epics own (E5's `learning`, E6's `ready`), and a
 * gate reading it would start blocking on progress rather than on setup the
 * first time one of those lands. `orientationCompletedAt` is the single fact
 * this gate is about, which is why journey-shell.md §3.2 calls it "the literal
 * field `RequireOrientation` checks".
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useLearnerProfile } from '../../contexts/LearnerProfileContext';
import { usePermissions } from '../../hooks/usePermissions';
import { LoadingSpinner } from './LoadingSpinner';

/** Where an unoriented learner is sent. */
export const ORIENTATION_SETUP_PATH = '/setup/journey';

/**
 * The admin subtree exemption. See the header.
 *
 * A PREFIX, so every current and future admin page is covered by the same
 * reasoning rather than by a list that goes stale the next time one is added —
 * and the deadlock this prevents is about the subtree, not about one page.
 */
const ADMIN_PREFIX = '/admin';

/** The permission that earns the admin exemption. Already exists; not a new one. */
const ADMIN_EXEMPTION_PERMISSION = 'system_settings:read';

export function RequireOrientation() {
  const { profile, isLoading, hasError } = useLearnerProfile();
  const { hasPermission } = usePermissions();
  const location = useLocation();

  if (isLoading) {
    return <LoadingSpinner fullScreen />;
  }

  // FAIL OPEN. A failed profile read must not lock every learner out of the
  // whole application because one endpoint is unavailable — what it gates is a
  // product question, not a security boundary, and the API enforces access on
  // every route regardless of what this component decides.
  if (hasError || !profile) {
    return <Outlet />;
  }

  if (profile.orientationCompletedAt) {
    return <Outlet />;
  }

  // Exemption 3 — the deadlock case. See the header.
  if (
    location.pathname.startsWith(ADMIN_PREFIX) &&
    hasPermission(ADMIN_EXEMPTION_PERMISSION)
  ) {
    return <Outlet />;
  }

  // `state.from` so the orientation screen can return the learner where they
  // were going, and `replace` so the browser Back button does not walk them
  // into the redirect again.
  return (
    <Navigate to={ORIENTATION_SETUP_PATH} state={{ from: location }} replace />
  );
}
