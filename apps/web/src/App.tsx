import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { NotificationProvider } from "./contexts/NotificationContext";
import { ThemeContextProvider, useThemeContext } from "./contexts/ThemeContext";
import { ProtectedRoute } from "./components/common/ProtectedRoute";
import { RequirePermission } from "./components/common/RequirePermission";
import { RequireAiKey } from "./components/common/RequireAiKey";
import { RequireOrientation } from "./components/common/RequireOrientation";
import { AiStatusProvider } from "./contexts/AiStatusContext";
import { LearnerProfileProvider } from "./contexts/LearnerProfileContext";
import { Layout } from "./components/common/Layout";
import { ErrorBoundary } from "./components/common/ErrorBoundary";

// Pages (lazy loaded)
import { Suspense, lazy } from "react";
import { LoadingSpinner } from "./components/common/LoadingSpinner";

const LoginPage = lazy(() => import("./pages/LoginPage"));
const AuthCallbackPage = lazy(() => import("./pages/AuthCallbackPage"));
const ActivateDevicePage = lazy(() => import("./pages/ActivateDevicePage"));
const HomePage = lazy(() => import("./pages/HomePage"));
// The three bar destinations E1 ships as designed empty states (#69, epic #50).
// Lazy like every other page here: each is two sentences, but a static import
// would pull them into the entry chunk that a first-run user waits on.
const LearnPage = lazy(() => import("./pages/LearnPage"));
const PracticePage = lazy(() => import("./pages/PracticePage"));
const ProgressPage = lazy(() => import("./pages/ProgressPage"));
const AiKeySetupPage = lazy(() => import("./pages/AiKeySetupPage"));
// Issue #72, epic #50 — the orientation screen behind `RequireOrientation`.
const OrientationPage = lazy(() => import("./pages/OrientationPage"));
// User settings — the hub (#96) plus one route per card in
// `config/userSettingsSections.tsx` (#91, epic #90). These replace the single
// stacked `UserSettingsPage`, which is deleted rather than left unrouted.
const UserSettingsHubPage = lazy(() => import("./pages/UserSettingsHubPage"));
const UserProfilePage = lazy(() => import("./pages/UserProfilePage"));
// `User`-prefixed to keep it distinct from `Admin/AppearanceSettingsPage`
// below: one is the user's own theme, the other the deployment's default.
const UserAppearancePage = lazy(() => import("./pages/UserAppearancePage"));
// Issue #126, epic #109 — the per-user event x channel notification matrix.
const UserNotificationsPage = lazy(
  () => import("./pages/UserNotificationsPage"),
);
const UserTokensPage = lazy(() => import("./pages/UserTokensPage"));
// Issue #42, epic #25 — the user's own OpenAI key and what it has been used for.
const UserAiKeyPage = lazy(() => import("./pages/UserAiKeyPage"));

// Console — the hub (#93) plus one route per card in
// `config/adminSections.tsx` (#92, epic #90).
const SettingsHubPage = lazy(() => import("./pages/Admin/SettingsHubPage"));
const GeneralSettingsPage = lazy(
  () => import("./pages/Admin/GeneralSettingsPage"),
);
const AppearanceSettingsPage = lazy(
  () => import("./pages/Admin/AppearanceSettingsPage"),
);
const FeatureFlagsPage = lazy(() => import("./pages/Admin/FeatureFlagsPage"));
// Issue #124, epic #109 — the admin email configuration and its test send.
const EmailSettingsPage = lazy(() => import("./pages/Admin/EmailSettingsPage"));
const AiSettingsPage = lazy(() => import("./pages/Admin/AiSettingsPage"));
const AdvancedSettingsPage = lazy(
  () => import("./pages/Admin/AdvancedSettingsPage"),
);
const AdminUsersPage = lazy(() => import("./pages/Admin/UsersPage"));

// Test login page (development only)
const TestLoginPage = import.meta.env.PROD
  ? null
  : lazy(() => import("./pages/TestLoginPage"));

function AppRoutes() {
  const { theme } = useThemeContext();

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner fullScreen />}>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/callback" element={<AuthCallbackPage />} />

            {/* Test login (development only) */}
            {!import.meta.env.PROD && TestLoginPage && (
              <Route path="/testing/login" element={<TestLoginPage />} />
            )}

            {/* Protected routes */}
            <Route element={<ProtectedRoute />}>
              {/* The AI availability status (#39, epic #25), fetched ONCE and
                  shared by everything below it.

                  ABOVE BOTH the key setup screen and the gate, deliberately:
                  saving a key on that screen releases the gate without a page
                  reload, because the two are looking at the same state. A
                  provider mounted inside the gate could not do that, and a
                  fetch inside the gate would fire on every navigation — a
                  request storm behind a first-run screen a new user cannot get
                  past. */}
              <Route element={<AiStatusProvider />}>
                {/* OUTSIDE `RequireAiKey`, which is what makes a redirect loop
                    structurally impossible rather than prevented by a path
                    comparison somebody could edit. #41 replaces this screen's
                    chrome with the designed onboarding experience; the route's
                    position does not change. */}
                <Route path="/setup/ai-key" element={<AiKeySetupPage />} />

                {/* THE GATE. Every inference call runs on the user's own key,
                    so a keyless user cannot do anything the product exists to
                    do — and letting them wander is worse than blocking them:
                    they would meet a failure at every AI surface with no
                    explanation of the one thing they need to fix.

                    `systemReady === false` is explicitly NOT handled here. It
                    is not a block; the user gets in and meets a point-of-use
                    message (#43). See `RequireAiKey` for the exempt routes and
                    for the fresh-install deadlock exemption 3 prevents. */}
                <Route element={<RequireAiKey />}>
                  {/* Device activation page - without layout for full-screen experience */}
                  {/* OUTSIDE `LearnerProfileProvider` below, deliberately: the
                      CLI device flow (#110) neither reads a learner profile nor
                      has any business being blocked by one. Approving a device
                      is an account action, not a study action, and it is
                      reachable mid-onboarding for the same reason logout is. */}
                  <Route path="/activate" element={<ActivateDevicePage />} />

                  {/* The learner's journey profile (#72, epic #50), fetched
                      ONCE and shared by everything below it.

                      ABOVE BOTH the orientation screen and the gate, for the
                      identical reason `AiStatusProvider` sits above its pair:
                      saving orientation releases the gate without a page
                      reload, because the two are looking at the same state. A
                      fetch inside the gate would instead fire on every
                      navigation. */}
                  <Route element={<LearnerProfileProvider />}>
                    {/* OUTSIDE `RequireOrientation`, exactly as `/setup/ai-key`
                        sits outside `RequireAiKey` — a redirect loop is then
                        structurally impossible rather than prevented by a path
                        comparison somebody could edit. */}
                    <Route path="/setup/journey" element={<OrientationPage />} />

                    {/* THE SECOND GATE, chained AFTER `RequireAiKey` and never
                        merged with it (journey-shell.md §5, §11). The two answer
                        independent questions — "does this caller have a working
                        key" and "has this caller told us about their situation" —
                        and the order is deliberate: a keyless, unoriented learner
                        is sent to `/setup/ai-key` first, because asking a product
                        question of someone who cannot use the product yet is work
                        spent before the gate that actually blocks them has
                        cleared.

                        Same three exemptions, same fail-open, same
                        `system_settings:read` admin escape — and no new
                        permission string. See `RequireOrientation`. */}
                    <Route element={<RequireOrientation />}>
                      {/* The notification centre (#127, epic #109) wraps the SHELL,
                      not the whole app, and that scoping is the point:

                        * It is INSIDE `ProtectedRoute`, so it only ever mounts for
                          an authenticated user. Every endpoint it calls is
                          `@Auth()`-guarded and every one resolves the recipient from
                          the JWT, so mounting it on `/login` would buy a burst of
                          401s and a stream that cannot connect.
                        * It is around `Layout` specifically, because `Layout`'s
                          `AppBar` is where the bell lives. `/activate` above sits
                          outside the shell on purpose (full-screen device flow) and
                          correspondingly gets no bell and opens no stream.

                      ONE MOUNT POINT, so there is exactly one SSE connection per
                      tab. A provider mounted per-page would open and close a stream
                      on every navigation, which the server sees as a connection
                      storm from a single user and the client experiences as a bell
                      that resets its state every time the route changes. */}
                      <Route
                        element={
                          <NotificationProvider>
                            <Layout />
                          </NotificationProvider>
                        }
                      >
                        <Route path="/" element={<HomePage />} />

                        {/* The other three bar destinations (#69, epic #50,
                        `docs/specs/journey-shell.md` §2.3). REAL, MOUNTED ROUTES
                        from the day the bar names them — not redirects to `/`, not
                        404s, and not placeholders. The rail and the bottom bar draw
                        all four at every width for every authenticated user, so a
                        destination whose route did not exist would be navigation
                        that lies; §4's `nextAction` contract points learners at
                        these exact paths as well, and a stub that bounced to `/`
                        would make every one of those values false the moment E1
                        shipped.

                        UNGATED, like the `/settings/*` block below and unlike
                        `/admin/*`: `ProtectedRoute` above establishes that someone
                        is signed in, which is the only question these pages have.
                        `config/destinations.ts` declares no `permission` on any of
                        the four for the same reason — see the array's comment on
                        reachability versus content. */}
                        <Route path="/learn" element={<LearnPage />} />
                        <Route path="/practice" element={<PracticePage />} />
                        <Route path="/progress" element={<ProgressPage />} />
                        {/* The per-user settings surface (#96, epic #90) — the same
                        hub component `/admin/settings` renders, over
                        `USER_SETTINGS_SECTIONS`, plus one route per card.

                        NONE OF THESE IS WRAPPED IN `RequirePermission`, and that is
                        the deliberate difference from the `/admin/settings/*` block
                        below rather than an oversight. `ProtectedRoute` above
                        establishes that someone is signed in, and that is the only
                        question these routes have: they edit the caller's OWN
                        settings, which the API grants to all three roles, and
                        `config/userSettingsSections.tsx` correspondingly declares no
                        `permission` on any card. A gate here would deny a Viewer
                        their own display name.

                        As above, declaration order does not matter — React Router
                        v6 ranks by specificity, so `/settings/profile` beats
                        `/settings` wherever each is written. */}
                        <Route path="/settings" element={<UserSettingsHubPage />} />
                        <Route
                          path="/settings/profile"
                          element={<UserProfilePage />}
                        />
                        <Route
                          path="/settings/appearance"
                          element={<UserAppearancePage />}
                        />
                        {/* Ungated like its siblings (#126): these are the caller's own
                        preferences, and the registry endpoint the page renders is
                        itself `@Auth()` with no permission for the same reason. */}
                        <Route
                          path="/settings/notifications"
                          element={<UserNotificationsPage />}
                        />
                        <Route
                          path="/settings/tokens"
                          element={<UserTokensPage />}
                        />
                        {/* Ungated like its siblings (#42, epic #25). The endpoints
                            behind it are `@Auth()` with no permissions — every user
                            owns their own credentials — and the registry card
                            correspondingly declares no `permission`. A gate here
                            would leave the gated role unable to use the app at all,
                            since a keyless user is hard-blocked. */}
                        <Route path="/settings/ai" element={<UserAiKeyPage />} />
                        {/* Route-level AUTHORIZATION, not just authentication.
                        `ProtectedRoute` above only establishes that someone is
                        logged in — before this, a Viewer typing `/admin/settings`
                        reached the page and only then watched every API call 403.
                        `RequirePermission` was already in the codebase but had zero
                        usages; wrapping these routes is what turns it into the
                        enforcement point.

                        The permission on each route is the SAME string its card
                        declares in `config/adminSections.tsx`, which is the same
                        string the API's controller enforces — so the hub card, the
                        rail row, the menu entry and the route can no longer
                        disagree about who may go where.

                        ORDER IS NOT SIGNIFICANT HERE. React Router v6 ranks routes
                        by specificity rather than by declaration order, so
                        `/admin/settings/users` beats `/admin/settings` regardless
                        of where each sits in this list. They are grouped by surface
                        for reading, not for matching. */}

                        {/* Both redirects are REAL ROUTES, not catch-all fallout.
                        Without them a bookmarked `/admin/users` matches only `*`
                        and lands silently on `/` — the user asked for a page that
                        still exists and got the home screen with no explanation.
                        `replace` keeps the dead URL out of the history stack, so
                        Back returns to wherever the user came from rather than
                        bouncing through the redirect again.

                        They sit INSIDE `ProtectedRoute` so an unauthenticated
                        bookmark goes to login and arrives here afterwards, rather
                        than being redirected first and losing the destination. */}
                        <Route
                          path="/admin"
                          element={<Navigate to="/admin/settings" replace />}
                        />
                        <Route
                          path="/admin/users"
                          element={<Navigate to="/admin/settings/users" replace />}
                        />

                        {/* The Console hub (#93, epic #90) — the searchable, grouped
                        card grid that reads `ADMIN_SECTIONS`. It replaces the
                        three-tab placeholder that answered this route through #92,
                        whose tabs duplicated the four routes below. That
                        duplication is now gone: the hub NAVIGATES to those routes
                        instead of re-hosting them. */}
                        {/* ANY-OF, and the one route here that is not a single
                        permission. This gate MUST STAY IN SYNC WITH `console`'s
                        `anyPermission` in `config/destinations.ts` — the two lists
                        answer the same question ("may this user reach the admin
                        surface?") on two different surfaces, and #92 left them
                        disagreeing: the Console row appeared in the rail, bottom
                        bar, user menu and quick actions for a `users:read`-only
                        user, whose click then bounced straight back to `/`. That
                        split brain is exactly what `config/destinations.ts`'s
                        header says the destination model exists to prevent, so the
                        route follows the destination rather than the reverse.

                        `requireAll` defaults to `false`, so `permissions` is an OR
                        here — matching `anyPermission`'s semantics, not
                        `hasAllPermissions`'.

                        A `users:read`-only user consequently reaches this route
                        and — since #93 — sees a hub containing exactly the one card
                        that permission unlocks, instead of the placeholder page's
                        blanket access-denied state. The hub's own gate
                        (`visibleSettingsSections`) does that per CARD, which is why
                        this route only answers the coarser question "may this user
                        reach the admin surface at all?". The five child routes
                        below keep their single-permission gates: each is one
                        specific page with one specific permission. */}
                        <Route
                          path="/admin/settings"
                          element={
                            <RequirePermission
                              permissions={["system_settings:read", "users:read"]}
                              fallback={<Navigate to="/" replace />}
                            >
                              <SettingsHubPage />
                            </RequirePermission>
                          }
                        />
                        <Route
                          path="/admin/settings/general"
                          element={
                            <RequirePermission
                              permission="system_settings:read"
                              fallback={<Navigate to="/" replace />}
                            >
                              <GeneralSettingsPage />
                            </RequirePermission>
                          }
                        />
                        <Route
                          path="/admin/settings/appearance"
                          element={
                            <RequirePermission
                              permission="system_settings:read"
                              fallback={<Navigate to="/" replace />}
                            >
                              <AppearanceSettingsPage />
                            </RequirePermission>
                          }
                        />
                        <Route
                          path="/admin/settings/feature-flags"
                          element={
                            <RequirePermission
                              permission="system_settings:read"
                              fallback={<Navigate to="/" replace />}
                            >
                              <FeatureFlagsPage />
                            </RequirePermission>
                          }
                        />
                        {/* Issue #124, epic #109. Same permission string the `Email`
                        card declares in `config/adminSections.tsx`, which is the
                        same string the API's email-settings controller enforces on
                        its GET — the invariant `destinations.test.ts` asserts for
                        every card. `system_settings:read` and not `:write`: saving
                        and test-sending need write, and the page disables both
                        without it, but the configuration is worth READING for
                        anyone diagnosing why mail is not arriving. */}
                        <Route
                          path="/admin/settings/email"
                          element={
                            <RequirePermission
                              permission="system_settings:read"
                              fallback={<Navigate to="/" replace />}
                            >
                              <EmailSettingsPage />
                            </RequirePermission>
                          }
                        />
                        {/* `system_settings:read`, the SAME string
                        `config/adminSections.tsx`'s AI card declares and the same
                        one `ai-settings.controller.ts` enforces on its GET.
                        Saving and testing need `:write`, which the page gates
                        internally — the route gate is about REACHABILITY, and a
                        read-only admin diagnosing "why is AI broken" is worth
                        letting in to look. */}
                        <Route
                          path="/admin/settings/ai"
                          element={
                            <RequirePermission
                              permission="system_settings:read"
                              fallback={<Navigate to="/" replace />}
                            >
                              <AiSettingsPage />
                            </RequirePermission>
                          }
                        />
                        {/* `system_settings:WRITE`, not `read`, and the one route here
                        whose permission differs from its siblings'. A raw editor
                        over the entire settings document has no read-only meaning —
                        see `config/adminSections.tsx`. */}
                        <Route
                          path="/admin/settings/advanced"
                          element={
                            <RequirePermission
                              permission="system_settings:write"
                              fallback={<Navigate to="/" replace />}
                            >
                              <AdvancedSettingsPage />
                            </RequirePermission>
                          }
                        />
                        {/* `users:read` alone, even though the page also hosts the
                        allowlist. The route gate is about REACHABILITY and the page
                        is worth reaching for its Users tab; the Allowlist tab gates
                        its own content on `allowlist:read` inside the page. */}
                        <Route
                          path="/admin/settings/users"
                          element={
                            <RequirePermission
                              permission="users:read"
                              fallback={<Navigate to="/" replace />}
                            >
                              <AdminUsersPage />
                            </RequirePermission>
                          }
                        />
                      </Route>
                    </Route>
                  </Route>
                </Route>
              </Route>
            </Route>

            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </ThemeProvider>
  );
}

export default function App() {
  return (
    <ThemeContextProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeContextProvider>
  );
}
