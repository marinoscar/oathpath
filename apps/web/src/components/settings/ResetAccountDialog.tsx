/**
 * The confirmation dialog for a self-service data reset.
 *
 * Issue #270. Baseline is `AiKeyForm`'s own remove-dialog (bottom of
 * `components/ai/AiKeyForm.tsx`): `Dialog`/`DialogTitle`/`DialogContent`/
 * `DialogActions`, a plain `Cancel` beside a `color="error"` confirm button,
 * the consequence stated in `DialogContentText` before the button that causes
 * it. This extends that idiom with what a data reset needs and a key removal
 * did not — a LIVE, PER-SCOPE consequence list (rather than one fixed
 * sentence) and a TYPED confirmation phrase (rather than a click), because
 * both scopes here are irreversible and total in a way removing a credential
 * is not: there is no "paste it back in" for a deleted practice history.
 *
 * =============================================================================
 * THIS DIALOG NEVER NAVIGATES
 * =============================================================================
 *
 * `onReset` fires after a SUCCESSFUL reset and nothing else — no `navigate()`
 * call lives in this file. The page that opens this dialog is the one that
 * knows what "after" means for each scope (`/setup/journey` for `data`,
 * `/setup/ai-key` for `data_and_key`) and, more importantly, the one that
 * owns the contexts (`AuthContext`, `LearnerProfileContext`, `AiStatusContext`)
 * that MUST be refreshed before that navigation happens — see
 * `UserDataResetPage`'s own header for why refresh has to run first. Folding
 * navigation into this component would mean it deciding, on the page's
 * behalf, which contexts to refresh for which scope; the page already has to
 * make that decision to render its own two "reset" buttons correctly, so
 * making it a second time here is the exact drift a shared dialog exists to
 * avoid.
 *
 * =============================================================================
 * THE PHRASE COMES FROM THE SERVER, NEVER A WEB CONSTANT
 * =============================================================================
 *
 * `summary.phrases[scope]` is `ACCOUNT_RESET_PHRASES` on the API, echoed
 * back — see `AccountDataSummary`'s own doc comment. Hardcoding `'DELETE MY
 * DATA'` here would be a second copy of a security-relevant string that the
 * server re-verifies before deleting anything; the day either phrase changes
 * server-side, a hardcoded copy here would silently disable this dialog's
 * only real gate (the button would stay disabled forever, or worse, accept
 * the WRONG phrase and let the server's 400 be the only thing standing in
 * the way).
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Skeleton,
  TextField,
  Typography,
} from '@mui/material';

import { useAccountReset } from '../../hooks/useAccountReset';
import type { AccountResetScope } from '../../types';

export interface ResetAccountDialogProps {
  open: boolean;
  scope: AccountResetScope;
  onClose: () => void;
  /** Fires after a SUCCESSFUL reset. This component never navigates — see the file header. */
  onReset: () => void;
}

/**
 * Table name -> what a person reads.
 *
 * A RECORD, NOT A `switch`, matching `AiKeyForm.tsx`'s own `FAILURE_COPY`
 * idiom: every key `ACCOUNT_RESET_TABLES` (plus `storage_objects`) declares
 * gets an entry here, in one place, rather than a fallback branch that would
 * quietly print a raw snake_case table name the day a fourteenth table is
 * added. A key with no entry below falls back to a humanized version of the
 * table name itself (see `describeCount`) so a forgotten label degrades to
 * something legible, never to nothing.
 */
const TABLE_LABELS: Record<string, string> = {
  practice_attempts: 'practice attempts',
  mock_interviews: 'mock interviews',
  mock_interview_turns: 'interview conversation turns',
  practice_sessions: 'practice sessions',
  question_mastery: 'question progress records',
  readiness_snapshots: 'readiness snapshots',
  daily_activity: 'days of recorded activity',
  english_attempts: 'English reading and writing attempts',
  ai_usage_events: 'recorded AI usage events',
  notifications: 'notifications',
  notification_deliveries: 'notification delivery records',
  personal_access_tokens: 'personal access tokens',
  device_codes: 'device sign-in sessions',
  learner_profiles: 'learner profile',
  user_settings: 'saved app settings',
  storage_objects: 'uploaded files',
};

/** `practice_attempts` -> `practice attempts`, used only when `TABLE_LABELS` has no entry. */
function humanizeTableName(table: string): string {
  return table.replace(/_/g, ' ');
}

/** `('practice_attempts', 142)` -> `'142 practice attempts'`. */
function describeCount(table: string, count: number): string {
  const label = TABLE_LABELS[table] ?? humanizeTableName(table);
  return `${count.toLocaleString()} ${label}`;
}

export function ResetAccountDialog({
  open,
  scope,
  onClose,
  onReset,
}: ResetAccountDialogProps) {
  const { summary, isLoading, isResetting, resetError, reset, clearResetError } =
    useAccountReset();

  const [value, setValue] = useState('');

  /**
   * Reset the typed value and any stale error whenever the dialog closes,
   * reopens, or is asked to confirm a DIFFERENT scope. Without this, closing
   * the dialog after a failed `data` attempt and reopening it for
   * `data_and_key` would show the previous scope's error alongside the new
   * scope's (different, longer) phrase — a mismatch that reads as "the app is
   * confused" rather than "start over".
   */
  useEffect(() => {
    setValue('');
    clearResetError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope]);

  const phrase = summary?.phrases[scope];
  const nonZeroCounts = summary
    ? Object.entries(summary.counts).filter(([, count]) => count > 0)
    : [];
  const canConfirm =
    !isResetting && phrase !== undefined && value.trim() === phrase;

  async function handleConfirm() {
    if (!canConfirm) return;
    const result = await reset(scope, value);
    if (result) {
      onClose();
      onReset();
    }
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {scope === 'data' ? 'Reset your data?' : 'Reset everything?'}
      </DialogTitle>
      <DialogContent>
        <DialogContentText id="reset-account-consequence" component="div">
          <Typography variant="body2" gutterBottom>
            This will permanently erase:
          </Typography>

          {isLoading && (
            <Box sx={{ mb: 1 }}>
              <Skeleton width="70%" />
              <Skeleton width="60%" />
              <Skeleton width="50%" />
            </Box>
          )}

          {!isLoading && summary && (
            <Box component="ul" sx={{ mt: 0, mb: 2, pl: 3 }}>
              {nonZeroCounts.length === 0 && (
                <Box component="li">
                  <Typography variant="body2">Nothing yet — your account has no recorded data.</Typography>
                </Box>
              )}
              {nonZeroCounts.map(([table, count]) => (
                <Box component="li" key={table}>
                  <Typography variant="body2">{describeCount(table, count)}</Typography>
                </Box>
              ))}
            </Box>
          )}

          <Typography variant="body2" sx={{ fontWeight: 600 }} gutterBottom>
            Kept:
          </Typography>
          <Box component="ul" sx={{ mt: 0, mb: 2, pl: 3 }}>
            <Box component="li">
              <Typography variant="body2">Your sign-in and account stay.</Typography>
            </Box>
            {scope === 'data' && (
              <Box component="li">
                <Typography variant="body2">Your saved AI key stays.</Typography>
              </Box>
            )}
          </Box>

          <Typography variant="body2">This cannot be undone.</Typography>
        </DialogContentText>

        {isLoading ? (
          <Skeleton variant="rounded" height={56} sx={{ mt: 2 }} />
        ) : (
          <TextField
            fullWidth
            sx={{ mt: 2 }}
            label={phrase ? `Type ${phrase} to confirm` : 'Type the confirmation phrase'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={isResetting || !phrase}
            autoComplete="off"
            aria-describedby="reset-account-consequence reset-account-error"
          />
        )}

        {/* A PERSISTENT, DISMISSIBLE ALERT — never a snackbar, matching
            `AiKeyForm`'s own reasoning: a diagnosis has to stay on screen long
            enough to act on. */}
        {resetError && (
          <Alert
            id="reset-account-error"
            severity="error"
            role="alert"
            sx={{ mt: 2 }}
            onClose={clearResetError}
          >
            {resetError}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isResetting}>
          Cancel
        </Button>
        <Button color="error" disabled={!canConfirm} onClick={handleConfirm}>
          {isResetting ? 'Resetting…' : 'Erase my data'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
