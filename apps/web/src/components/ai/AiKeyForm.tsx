/**
 * The one place a user pastes, tests, and removes their own OpenAI key.
 *
 * Issue #40, epic #25. TWO CHROMES CONSUME THIS AND NEITHER FORKS IT: the
 * first-run onboarding screen (#41) and the ongoing management page (#42).
 *
 * Two copies would drift, and the half most likely to drift is the failure
 * copy — the part that gets written carefully once and carelessly the second
 * time. That copy is the deliverable here, not decoration: the audience is
 * often an ESL speaker who has never met an API key, and "Request failed" is
 * not something they can act on.
 *
 * -----------------------------------------------------------------------------
 * FOUR FAILURE CLASSES, NAMED SEPARATELY
 * -----------------------------------------------------------------------------
 *
 * See `AiKeyFailureKind` in `hooks/useAiKey.ts` for the classification and why
 * it exists. The one that matters most:
 *
 *   THE KEY WORKS BUT CANNOT REACH A MODEL. Telling that user their key was
 *   rejected sends them to replace a perfectly good credential — and, because
 *   the real problem is on the administrator's side, the replacement will fail
 *   the same way.
 *
 * The raw provider text is shown IN ADDITION, in monospace, the way
 * `EmailSettingsPage` shows a verbatim provider error. It is never the message.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE PROPS ARE FOR
 * -----------------------------------------------------------------------------
 *
 * The two chromes differ in heading level, whether Remove is offered, and what
 * happens after a successful test. Those differences are PROPS, so neither
 * consumer reaches inside this component to restyle it.
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ScienceIcon from '@mui/icons-material/Science';

import {
  classifyTestFailure,
  hasSurroundingWhitespace,
  looksLikeApiKey,
  useAiKey,
} from '../../hooks/useAiKey';
import type { AiKeyFailureKind } from '../../hooks/useAiKey';

/**
 * How long the success state stays on screen before `onVerified` fires.
 *
 * Long enough to read "Your key is working" and register that something went
 * right; short enough not to feel like a stall. This is the moment the
 * onboarding screen exists to produce, and skipping past it undoes the work.
 */
const HANDOFF_DELAY_MS = 1200;

export interface AiKeyFormProps {
  /**
   * Heading level for this form's own title, so the consuming page keeps a
   * sensible document outline. Onboarding is the page's only content and uses
   * `h2`; the settings page already has an `h4` above it.
   */
  headingLevel?: 'h2' | 'h3' | 'h6';

  /** Show the Remove control. Meaningless during first-run onboarding. */
  showRemove?: boolean;

  /**
   * Called after a test that fully succeeded.
   *
   * Onboarding uses it to hand off into the app. The settings page passes
   * nothing — the user is already where they want to be.
   */
  onVerified?: () => void;

  /** Called after the key is removed, so the page can react. */
  onRemoved?: () => void;
}

/**
 * The user-facing sentence for each failure class.
 *
 * A RECORD RATHER THAN A `switch`, so adding a class to `AiKeyFailureKind`
 * fails to compile until its copy is written — where a `switch` would fall
 * through to a generic message and quietly undo the whole point.
 */
const FAILURE_COPY: Record<
  AiKeyFailureKind,
  { title: string; body: string }
> = {
  malformed: {
    title: "That doesn't look like a complete key",
    body:
      'An OpenAI key starts with "sk-" and is much longer than this. It is easy to ' +
      'miss the end when copying — go back and copy the whole line.',
  },
  rejected: {
    title: 'OpenAI did not accept this key',
    body:
      'The key may have been deleted, or copied from a different account. Create a ' +
      'new one in your OpenAI dashboard and paste it here.',
  },
  unreachable: {
    title: 'Your key is fine — but it cannot use one of the models we need',
    body:
      'The key works. It just does not have access to a model this app is set up to ' +
      'use, which usually means the account needs credit added or the model enabled. ' +
      'The details are below.',
  },
  network: {
    title: 'We could not reach the server',
    body:
      'Nothing is wrong with your key. Check your connection and try again.',
  },
};

export function AiKeyForm({
  headingLevel = 'h6',
  showRemove = false,
  onVerified,
  onRemoved,
}: AiKeyFormProps) {
  const {
    status,
    isLoading,
    loadError,
    isSaving,
    saveError,
    isTesting,
    testResult,
    isRemoving,
    save,
    remove,
    test,
    clearTestResult,
    clearSaveError,
  } = useAiKey();

  const [value, setValue] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  /**
   * A locally-detected malformed paste.
   *
   * Held separately from `testResult` because it is not a test outcome — no
   * request was made. Catching it here is the point: sending a half-copied key
   * to the server comes back as "rejected", which tells the user their key is
   * wrong when what happened is that they missed the end of it.
   */
  const [localFailure, setLocalFailure] = useState<AiKeyFailureKind | null>(
    null,
  );

  const failure = localFailure ?? classifyTestFailure(testResult);
  const verified = testResult?.success === true;
  const busy = isSaving || isTesting || isRemoving;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;

    clearSaveError();
    setLocalFailure(null);

    const trimmedIsEmpty = value.trim().length === 0;

    // Nothing typed, and a key is already stored: this is the settings page's
    // "just test what I have" path, not a save.
    if (trimmedIsEmpty && status?.configured) {
      await test();
      return;
    }

    if (trimmedIsEmpty) {
      setLocalFailure('malformed');
      return;
    }

    if (!looksLikeApiKey(value)) {
      // Refused BEFORE the request, so the user is told what actually happened
      // rather than being told OpenAI rejected them.
      setLocalFailure('malformed');
      return;
    }

    // SENT VERBATIM. The warning below tells the user about surrounding
    // whitespace; this app does not silently alter a secret's bytes.
    const saved = await save(value);
    if (!saved) return;

    // The field is cleared on success. The stored key is unreadable, and a
    // field that kept showing what was typed would be the only place in the
    // app where a secret sits in the DOM after it was needed.
    setValue('');
    await test();
  }

  /**
   * Hand off once, when a test fully succeeds.
   *
   * IN AN EFFECT, not in the render body: calling a consumer's callback while
   * rendering is a side effect during render, and under StrictMode's double
   * invocation it would fire twice — which for onboarding means navigating
   * twice and, in the worst case, racing the success state off the screen
   * before the user sees it.
   *
   * The delay is deliberate and small. The success alert paints first; a
   * hand-off on the same frame reads as "nothing happened, and then I was
   * somewhere else", which for a first-time user who has just done something
   * unfamiliar is exactly the wrong feedback.
   */
  useEffect(() => {
    if (!verified || !onVerified) return;

    const timer = setTimeout(onVerified, HANDOFF_DELAY_MS);
    return () => clearTimeout(timer);
  }, [verified, onVerified]);

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress aria-label="Checking whether you have a key saved" />
      </Box>
    );
  }

  return (
    <Box component="form" onSubmit={handleSubmit} noValidate>
      <Typography variant={headingLevel === 'h6' ? 'h6' : 'h5'} component={headingLevel} gutterBottom>
        Your OpenAI key
      </Typography>

      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}

      <TextField
        fullWidth
        type="password"
        label="OpenAI API key"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          // A new paste makes the old diagnosis stale immediately.
          if (localFailure) setLocalFailure(null);
        }}
        disabled={busy}
        // So a password manager cannot silently re-send a credential.
        autoComplete="new-password"
        placeholder={status?.hint ?? 'sk-…'}
        helperText={
          status?.configured
            ? `A key is saved${
                status.updatedAt
                  ? ` (added ${new Date(status.updatedAt).toLocaleDateString()})`
                  : ''
              }. Leave this empty to keep it, or paste a new one to replace it.`
            : 'Paste the key you copied from OpenAI. It is stored encrypted and is never shown again.'
        }
        sx={{ mb: 1 }}
      />

      {hasSurroundingWhitespace(value) && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          There is a space or a line break around what you pasted. That is
          usually a copying accident — but we save your key exactly as you type
          it, so remove it if you did not mean it.
        </Alert>
      )}

      <Stack direction="row" spacing={2} sx={{ mt: 2, flexWrap: 'wrap' }}>
        <Button
          type="submit"
          variant="contained"
          disabled={busy}
          startIcon={isTesting ? undefined : <ScienceIcon />}
        >
          {isSaving
            ? 'Saving…'
            : isTesting
              ? 'Testing…'
              : status?.configured && value === ''
                ? 'Test my key'
                : 'Save and test'}
        </Button>

        {showRemove && status?.configured && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => setConfirmRemove(true)}
            disabled={busy}
          >
            Remove key
          </Button>
        )}
      </Stack>

      {saveError && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={clearSaveError}>
          {saveError}
        </Alert>
      )}

      {/* SUCCESS IS UNAMBIGUOUS, and per role — a first-time user has to read
          it as "done" without knowing what a role is. */}
      {verified && (
        <Alert
          severity="success"
          icon={<CheckCircleIcon />}
          sx={{ mt: 2 }}
          onClose={clearTestResult}
        >
          <AlertTitle>Your key is working</AlertTitle>
          Everything this app needs is ready to go.
          {testResult.roles.length > 0 && (
            <Box sx={{ mt: 1 }}>
              {testResult.roles.map((role) => (
                <Chip
                  key={role.roleKey}
                  size="small"
                  color="success"
                  label={role.roleKey}
                  sx={{ mr: 0.5, mt: 0.5 }}
                />
              ))}
            </Box>
          )}
        </Alert>
      )}

      {/* A PERSISTENT, DISMISSIBLE ALERT — never a snackbar. A diagnosis has to
          stay on screen long enough to act on. */}
      {failure && (
        <Alert
          severity={failure === 'unreachable' ? 'warning' : 'error'}
          sx={{ mt: 2 }}
          onClose={() => {
            setLocalFailure(null);
            clearTestResult();
          }}
        >
          <AlertTitle>{FAILURE_COPY[failure].title}</AlertTitle>
          {FAILURE_COPY[failure].body}

          {/* PER-ROLE RESULTS, not one boolean. A key can authenticate and
              still have no access to the grader's model. */}
          {testResult?.roles.map((role) => (
            <Box key={role.roleKey} sx={{ mt: 1 }}>
              <Chip
                size="small"
                color={role.reachable ? 'success' : 'error'}
                label={role.reachable ? 'working' : 'not available'}
                sx={{ mr: 1 }}
              />
              <Typography variant="body2" component="span">
                {role.modelId}
              </Typography>
              {role.error && (
                <Typography
                  variant="caption"
                  component="div"
                  sx={{ fontFamily: 'monospace', mt: 0.5, wordBreak: 'break-word' }}
                >
                  {role.error}
                </Typography>
              )}
            </Box>
          ))}

          {/* The raw provider text, IN ADDITION and never instead. */}
          {testResult?.error && testResult.roles.length === 0 && (
            <Box
              component="pre"
              sx={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                mt: 1,
                mb: 0,
              }}
            >
              {testResult.error}
            </Box>
          )}
        </Alert>
      )}

      {/* REMOVE IS A DISTINCT, CONFIRMED ACTION — never "clear the field and
          save". The dialog states the consequence, which is not obvious: the
          user is put back to the setup screen, because every AI feature runs
          on their own key. */}
      <Dialog open={confirmRemove} onClose={() => setConfirmRemove(false)}>
        <DialogTitle>Remove your key?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You will be taken back to the setup screen, because everything this
            app does needs your key. Your key is not deleted at OpenAI — you can
            paste the same one back in at any time.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRemove(false)}>Cancel</Button>
          <Button
            color="error"
            disabled={isRemoving}
            onClick={async () => {
              const removed = await remove();
              setConfirmRemove(false);
              if (removed) onRemoved?.();
            }}
          >
            {isRemoving ? 'Removing…' : 'Remove key'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
