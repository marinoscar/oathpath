/**
 * Hard-block a user who has not saved their own AI key.
 *
 * Issue #39, epic #25. Every inference call runs on the user's own key
 * (decision 4), so a user without one cannot do anything the product exists to
 * do. Letting them wander is WORSE than blocking them: they meet a failure at
 * every AI surface with no explanation of the one thing they need to fix.
 *
 * Composed like `ProtectedRoute` — a layout route rendering an `<Outlet />` —
 * so it wraps the app shell in `App.tsx` with no per-page opt-in to forget.
 *
 * =============================================================================
 * THE EXEMPT ROUTES, IN FULL. THE LIST IS DELIBERATELY SHORT.
 * =============================================================================
 *
 * 1. `/setup/ai-key` itself. It is mounted OUTSIDE this gate in `App.tsx`
 *    rather than exempted here, which is the stronger arrangement: a redirect
 *    loop is then structurally impossible rather than prevented by a string
 *    comparison somebody could edit.
 *
 * 2. LOGOUT. Not a route in this application — it is an action on the app bar,
 *    and the setup screen (#41) carries its own control. A blocked user must
 *    always be able to leave.
 *
 * 3. `/admin/settings/*` FOR A CALLER HOLDING `system_settings:read`.
 *
 *    Exemption 3 is not a courtesy. The admin AI settings page (#33) is the
 *    ONLY place the server key and the model bindings are set. Putting it
 *    behind a gate that nothing has configured yet is a DEADLOCK on a fresh
 *    install: the first administrator cannot configure the system they are
 *    being blocked for, and there is no way out of the loop from inside the
 *    product.
 *
 *    It is keyed on the PERMISSION, not on a role name — the same string the
 *    admin cards and routes declare. A keyless NON-admin gains nothing: the
 *    existing `RequirePermission` gate still applies underneath, so they reach
 *    the route and are bounced by it exactly as before.
 *
 * =============================================================================
 * `systemReady === false` IS EXPLICITLY NOT HANDLED HERE
 * =============================================================================
 *
 * It is not a block. A user with a valid key gets in and meets a point-of-use
 * message (#43). Conflating the two is the entire reason `/api/ai/status`
 * returns two flags — see `contexts/AiStatusContext.tsx`.
 */

import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAiStatus } from '../../contexts/AiStatusContext';
import { usePermissions } from '../../hooks/usePermissions';
import { LoadingSpinner } from './LoadingSpinner';

/** Where a keyless user is sent. */
export const AI_KEY_SETUP_PATH = '/setup/ai-key';

/**
 * The admin subtree exemption. See the header.
 *
 * A PREFIX, so every current and future admin settings page is covered by the
 * same reasoning rather than by a list that goes stale the next time one is
 * added — and the deadlock this prevents is about the subtree, not about one
 * page.
 */
const ADMIN_SETTINGS_PREFIX = '/admin';

/** The permission that earns the admin exemption. */
const ADMIN_EXEMPTION_PERMISSION = 'system_settings:read';

export function RequireAiKey() {
  const { status, isLoading, hasError } = useAiStatus();
  const { hasPermission } = usePermissions();
  const location = useLocation();

  if (isLoading) {
    return <LoadingSpinner fullScreen />;
  }

  // FAIL OPEN. A failed status check must not lock every user out of the whole
  // application because one endpoint is unavailable — what it gates is a
  // feature, not a security boundary, and the API enforces access on every
  // route regardless of what this component decides.
  if (hasError || !status) {
    return <Outlet />;
  }

  if (status.userKeyConfigured) {
    return <Outlet />;
  }

  // Exemption 3 — the deadlock case. See the header.
  if (
    location.pathname.startsWith(ADMIN_SETTINGS_PREFIX) &&
    hasPermission(ADMIN_EXEMPTION_PERMISSION)
  ) {
    return <Outlet />;
  }

  // `state.from` so the setup screen can return the user where they were
  // going, and `replace` so the browser Back button does not walk them into
  // the redirect again.
  return (
    <Navigate to={AI_KEY_SETUP_PATH} state={{ from: location }} replace />
  );
}
