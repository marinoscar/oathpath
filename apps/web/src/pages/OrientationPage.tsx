/**
 * `/setup/journey` — the orientation screen.
 *
 * Issue #72, epic #50. Copy from `docs/specs/journey-shell.md` §7, verbatim;
 * mockups in `docs/specs/journey-shell/orientation-{360,600}.svg`.
 *
 * This is the second thing a new learner meets, straight after `/setup/ai-key`
 * (#41) — the two gates chain, and this one only ever renders for someone who
 * already has a working key. It is modelled on `AiKeySetupPage` deliberately:
 * same full-screen container, same tone, same "do not trap the user" rule.
 *
 * =============================================================================
 * WHY THIS IS ASKED AT ALL, IN ONE LINE
 * =============================================================================
 *
 * Without these answers the product does not know which civics test applies,
 * whose governor to ask about, or whether there is an interview to count down
 * to — so every screen behind the gate would be guessing, and journey-shell.md
 * §10 forbids showing a learner a number nobody chose. The intro says as much
 * in the learner's own terms, and promises the one thing that makes a first-run
 * form bearable: none of it is permanent.
 *
 * =============================================================================
 * LAYOUT
 * =============================================================================
 *
 * Full-screen and mounted OUTSIDE `Layout` in `App.tsx` — no rail, no bottom
 * nav, nothing to navigate away into — and outside `RequireOrientation`, which
 * is what makes a redirect loop structurally impossible rather than prevented
 * by a path comparison somebody could edit.
 *
 * Responsive at the `sm` (600px) boundary, the same boundary `CLAUDE.md`'s five
 * coupled gates use — never `md`, which would hand the phone treatment to
 * tablets and landscape phones. Legible at 360px: the only horizontal
 * constraint is the container's `maxWidth`, every control is full-width, and
 * nothing is laid out in columns.
 *
 * =============================================================================
 * DO NOT TRAP THE USER
 * =============================================================================
 *
 * Sign-out is always reachable, because a blocked learner has nowhere else to
 * go — logout is an app-bar action in `Layout`, and `Layout` is exactly what
 * this screen does not have. An administrator additionally gets a link into
 * admin settings, matching `RequireOrientation`'s exemption 3: the first
 * administrator on a fresh install may have no interview of their own to
 * describe, and must not be held here by a form about one.
 */

import { Box, Button, Container, Paper, Stack, Typography } from '@mui/material';
import { Link as RouterLink, useLocation, useNavigate } from 'react-router-dom';

import { JourneyProfileForm } from '../components/journey/JourneyProfileForm';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../hooks/usePermissions';

export default function OrientationPage() {
  const { logout } = useAuth();
  const { hasPermission } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * Where to go once orientation saves.
   *
   * `RequireOrientation` records the route the learner was heading for, so
   * finishing setup RESUMES what they were doing rather than dropping them on
   * the home page — which for someone who arrived from a shared link is the
   * difference between "I got there" and "it lost my place".
   */
  const destination =
    (location.state as { from?: { pathname?: string } } | null)?.from
      ?.pathname ?? '/';

  function handleSaved() {
    // No refresh call and no wait: the form has already pushed the server's own
    // response into `LearnerProfileContext`, so the gate is open by the time
    // this navigation resolves. Navigating on a stale profile would send the
    // learner back through the gate and straight to this screen — and the
    // failure would look exactly like the save did not work.
    navigate(destination, { replace: true });
  }

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 3, sm: 6 } }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Let&apos;s set up your plan
      </Typography>
      <Typography variant="body1" sx={{ mb: 3 }}>
        A few quick questions help us show you the right test, and a realistic
        countdown if you have an interview date. You can change any of this
        later in Settings.
      </Typography>

      {/* The shared form — the same component `/settings/journey` renders
          (#77), unforked. */}
      <Paper sx={{ p: { xs: 2, sm: 3 } }}>
        <JourneyProfileForm
          submitLabel="Save and continue"
          onSaved={handleSaved}
        />
      </Paper>

      {/* DO NOT TRAP THE USER. */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ mt: 3, justifyContent: 'center', alignItems: 'center' }}
      >
        <Button size="small" color="inherit" onClick={() => void logout()}>
          Sign out
        </Button>

        {hasPermission('system_settings:read') && (
          <Button
            size="small"
            color="inherit"
            component={RouterLink}
            to="/admin/settings"
          >
            Administrator settings
          </Button>
        )}
      </Stack>

      <Box sx={{ mt: 2, textAlign: 'center' }}>
        <Typography variant="caption" color="text.secondary">
          Nothing here is permanent. You can change every one of these answers
          later.
        </Typography>
      </Box>
    </Container>
  );
}
