/**
 * Settings → Danger zone (`/settings/reset`).
 *
 * Issue #270. Two irreversible actions over the caller's own data, each
 * behind its own typed confirmation: erase everything OathPath has recorded
 * about the learner, optionally including their stored AI key.
 *
 * A REGISTRY CARD PLUS A ROUTE, never a tab (CLAUDE.md's Settings UI Pattern,
 * rule 2) — see `config/userSettingsSections.tsx`'s own comment on the
 * `Danger zone` group for why this is its own destination.
 *
 * ONE SHARED DIALOG, TWO SCOPES. `openScope` is `null | 'data' |
 * 'data_and_key'` rather than two booleans, because the two dialogs are
 * mutually exclusive by construction — there is exactly one confirmation
 * flow in flight at a time — and a `null | Scope` union makes that a type
 * fact instead of an invariant two independent flags would have to be kept
 * in sync by hand.
 *
 * =============================================================================
 * REFRESH THE CONTEXTS BEFORE NAVIGATING, NEVER THE REVERSE
 * =============================================================================
 *
 * This is the exact ordering hazard `UserAiKeyPage.handleRemoved` documents
 * for removing a key, generalized to three contexts because a data reset can
 * invalidate three different gates at once:
 *
 *   - `AuthContext.refreshUser()`      — the reset can change what the app
 *     knows about the account's own state (e.g. profile-derived display
 *     data), and a stale `user` is exactly the kind of "app that no longer
 *     works for them" `UserAiKeyPage` warns about.
 *   - `LearnerProfileContext.refresh()` — `learner_profiles` is deleted by
 *     BOTH scopes (`ACCOUNT_RESET_TABLES` lists it last, lazily recreated at
 *     its defaults on next read). `RequireOrientation` gates on this
 *     context's answer, and an un-refreshed one still says "orientation
 *     complete" after the row that made that true is gone.
 *   - `AiStatusContext.refresh()` — only on `data_and_key`, where the stored
 *     key was just removed. `RequireAiKey` gates on this one, and skipping
 *     the refresh here is the same stale-gate bug one level higher in the
 *     guard chain.
 *
 * All three are `await`ed BEFORE `navigate()` runs. Navigating first would
 * land the learner on `/setup/journey` or `/setup/ai-key` while the guards
 * above it are still holding the PRE-reset answer — on `RequireOrientation`
 * in particular that reads as the redirect not having worked at all, because
 * the gate would consider the (now-deleted) profile still complete and send
 * them right back into a shell with nothing in it.
 *
 * =============================================================================
 * THE DIALOG DOES NOT NAVIGATE — THIS PAGE DOES
 * =============================================================================
 *
 * `ResetAccountDialog.onReset` fires after a successful reset and nothing
 * else. This page is the one that knows which contexts a given scope
 * invalidates and where each scope's post-reset screen is, so it is the one
 * that performs the refresh-then-navigate sequence above — see the dialog's
 * own header for why that split is deliberate rather than an oversight.
 */

import { useState } from 'react';
import { Box, Button, Container, Paper, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';

import { ResetAccountDialog } from '../components/settings/ResetAccountDialog';
import { useAuth } from '../contexts/AuthContext';
import { useAiStatus } from '../contexts/AiStatusContext';
import { useLearnerProfile } from '../contexts/LearnerProfileContext';
import type { AccountResetScope } from '../types';

export default function UserDataResetPage() {
  const [openScope, setOpenScope] = useState<AccountResetScope | null>(null);
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const { refresh: refreshLearnerProfile } = useLearnerProfile();
  const { refresh: refreshAiStatus } = useAiStatus();

  async function handleReset(scope: AccountResetScope) {
    // Refresh every gate the reset could have invalidated BEFORE navigating
    // away — see the file header for why the order is not interchangeable.
    await refreshUser();
    await refreshLearnerProfile();

    if (scope === 'data_and_key') {
      await refreshAiStatus();
      navigate('/setup/ai-key', { replace: true });
      return;
    }

    navigate('/setup/journey', { replace: true });
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Danger zone
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Erase your OathPath data and start over. Both actions below are
          permanent — there is no undo, and no backup this app can restore
          from.
        </Typography>

        <Paper
          variant="outlined"
          sx={{ p: { xs: 2, sm: 3 }, mb: 3, borderColor: 'error.main' }}
        >
          <Typography variant="h5" component="h2" gutterBottom>
            Reset my data
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Erases everything you have done in OathPath. Your OpenAI key
            stays saved.
          </Typography>
          <Button
            variant="outlined"
            color="error"
            onClick={() => setOpenScope('data')}
          >
            Reset my data
          </Button>
        </Paper>

        <Paper
          variant="outlined"
          sx={{ p: { xs: 2, sm: 3 }, borderColor: 'error.main' }}
        >
          <Typography variant="h5" component="h2" gutterBottom>
            Reset everything, including my AI key
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The same, and removes your saved OpenAI key. You will set the app
            up again from the beginning. Your key is not deleted at OpenAI.
          </Typography>
          <Button
            variant="outlined"
            color="error"
            onClick={() => setOpenScope('data_and_key')}
          >
            Reset everything
          </Button>
        </Paper>
      </Box>

      {openScope && (
        <ResetAccountDialog
          open={openScope !== null}
          scope={openScope}
          onClose={() => setOpenScope(null)}
          onReset={() => handleReset(openScope)}
        />
      )}
    </Container>
  );
}
