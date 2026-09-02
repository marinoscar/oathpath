/**
 * What an AI surface renders when the administrator has not finished.
 *
 * Issue #43, epic #25. A user can have a perfectly good personal key while the
 * administrator has not chosen a provider, bound `tutor` and `grader` to
 * models, or turned the master switch on. That user is let into the app BY
 * DESIGN (#39) — `systemReady === false` is not a block.
 *
 * =============================================================================
 * THE ONE SENTENCE THIS COMPONENT EXISTS FOR
 * =============================================================================
 *
 *   "This is not a problem with your key."
 *
 * That sentence is the entire reason `/api/ai/status` returns two flags rather
 * than one. Silence, a spinner, or a generic error would all send the user to
 * check the one thing that is NOT wrong — and since the only remedy they can
 * imagine is replacing their key, they would replace a working credential and
 * watch the same failure happen again.
 *
 * =============================================================================
 * TONE
 * =============================================================================
 *
 * `VISION.md`'s AI Personality section: calm, specific, never blaming the
 * user. Nothing here is an alarm — from the reader's point of view the product
 * is simply not finished being set up yet, which is a wait, not a fault. It is
 * an `info` severity for that reason, not `warning` and certainly not `error`.
 *
 * =============================================================================
 * SHARED, NOT RE-IMPLEMENTED PER SURFACE
 * =============================================================================
 *
 * Every AI feature this epic unblocks renders this same component. Written
 * once, the copy stays consistent and correct; written per surface, the
 * "not your key" sentence is the first thing to get dropped as boilerplate —
 * and dropping it is exactly the failure.
 */

import { Alert, AlertTitle, Box, Button, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import { useAiStatus } from '../../contexts/AiStatusContext';
import { usePermissions } from '../../hooks/usePermissions';

export interface AiNotReadyProps {
  /**
   * What the user was trying to do, in their words: "explain this answer",
   * "run a mock interview".
   *
   * Optional, and used to make the first line specific rather than generic.
   * `VISION.md` asks for specificity; "AI explanations aren't available yet"
   * is a better sentence than "AI isn't available yet", and the surface is the
   * only thing that knows which is true.
   */
  feature?: string;
}

/**
 * Render the blocked state for an AI surface, or nothing when AI is ready.
 *
 * RETURNS NULL WHEN READY, so a consumer can mount it unconditionally above
 * its own content rather than duplicating the `systemReady` check. That is the
 * shape that makes "every AI surface shows this" cheap enough to actually
 * happen.
 */
export function AiNotReady({ feature }: AiNotReadyProps) {
  const { status, isLoading } = useAiStatus();
  const { hasPermission } = usePermissions();

  // Nothing to say while the answer is unknown, and nothing to say when the
  // system is ready. A spinner here would put a loading state above every AI
  // surface for a fact that is already cached.
  if (isLoading || !status || status.systemReady) return null;

  const isAdmin = hasPermission('system_settings:read');
  const what = feature ? `${feature} is` : 'This is';

  return (
    <Alert severity="info" sx={{ my: 2 }}>
      <AlertTitle>{what} not available yet</AlertTitle>

      <Typography variant="body2" sx={{ mb: 1 }}>
        Your administrator has not finished setting up the AI models. Nothing
        is wrong on your side.
      </Typography>

      {/* THE SENTENCE. See the file header — it is why the status endpoint
          returns two flags. */}
      <Typography variant="body2" sx={{ fontWeight: 'medium' }}>
        This is not a problem with your key.
      </Typography>

      {isAdmin && (
        <Box sx={{ mt: 2 }}>
          {/* NAMED, not "some models". An admin who lands here should be one
              click and one glance from fixing it, and "which one?" is the
              question they would otherwise have to go and answer. */}
          {status.unboundRoles.length > 0 ? (
            <Typography variant="body2" sx={{ mb: 1 }}>
              As an administrator: no model is bound to{' '}
              <strong>{formatRoles(status.unboundRoles)}</strong>.
            </Typography>
          ) : !status.enabled ? (
            <Typography variant="body2" sx={{ mb: 1 }}>
              As an administrator: AI is configured, but the master switch is
              turned off.
            </Typography>
          ) : !status.providerConfigured ? (
            <Typography variant="body2" sx={{ mb: 1 }}>
              As an administrator: no AI provider has been chosen yet.
            </Typography>
          ) : null}

          <Button
            size="small"
            variant="outlined"
            component={RouterLink}
            to="/admin/settings/ai"
          >
            Open AI settings
          </Button>
        </Box>
      )}
    </Alert>
  );
}

/**
 * Join role keys into a readable list.
 *
 * "tutor and grader", not "tutor, grader" — the difference is small and it is
 * the difference between a sentence and a log line.
 */
function formatRoles(roles: string[]): string {
  if (roles.length === 1) return roles[0];
  if (roles.length === 2) return `${roles[0]} and ${roles[1]}`;
  return `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}`;
}
