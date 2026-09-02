/**
 * `/setup/ai-key` — where a keyless user is sent.
 *
 * ⚠️ THIS IS THE MINIMAL CHROME, LANDED WITH THE GATE (#39). Issue #41 replaces
 * it with the designed onboarding experience — welcome framing, a
 * plain-language explanation of why a key is needed, numbered steps to get one,
 * and a celebrated hand-off.
 *
 * It exists in this shape only so the gate has a real destination from the
 * commit that introduces it: a redirect to a route that does not exist would
 * fall through to `App.tsx`'s catch-all `Navigate to="/"`, which is a redirect
 * LOOP for exactly the user this gate is for. Landing the gate without a
 * destination would ship that loop.
 *
 * What it already does correctly, and what #41 keeps:
 *
 *   * It is OUTSIDE `RequireAiKey` in `App.tsx`, so a redirect loop is
 *     structurally impossible rather than prevented by a path comparison.
 *   * It refreshes the shared status and navigates onward when a key verifies,
 *     which is what releases the gate without a page reload.
 *   * It offers LOGOUT. A blocked user must always be able to leave, and this
 *     screen is the only place they can reach.
 */

import { Box, Button, Container, Paper, Typography } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';

import { AiKeyForm } from '../components/ai/AiKeyForm';
import { useAiStatus } from '../contexts/AiStatusContext';
import { useAuth } from '../contexts/AuthContext';

export default function AiKeySetupPage() {
  const { refresh } = useAiStatus();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * Where to go once a key verifies.
   *
   * `RequireAiKey` records the route the user was heading for, so finishing
   * setup resumes what they were doing rather than dropping them on the home
   * page — which for someone who arrived via a shared link is the difference
   * between "I got there" and "it lost my place".
   */
  const destination =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ??
    '/';

  async function handleVerified() {
    // Refresh FIRST, then navigate. Navigating on a stale status sends the
    // user through the gate again, which bounces them straight back here — the
    // failure looks like the save did not work.
    await refresh();
    navigate(destination, { replace: true });
  }

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 4, sm: 8 } }}>
      <Typography variant="h4" component="h1" gutterBottom>
        One more step
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        OathPath uses your own OpenAI key, so your usage is yours — you control
        it, you can see it, and you can remove it at any time.
      </Typography>

      <Paper sx={{ p: { xs: 2, sm: 3 } }}>
        <AiKeyForm headingLevel="h2" onVerified={handleVerified} />
      </Paper>

      {/* A blocked user must always be able to leave, and this is the only
          screen they can reach. */}
      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'center' }}>
        <Button size="small" color="inherit" onClick={() => void logout()}>
          Sign out
        </Button>
      </Box>
    </Container>
  );
}
