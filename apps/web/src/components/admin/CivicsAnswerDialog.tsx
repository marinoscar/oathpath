/**
 * Correct one dynamic civics answer — the two-step dialog behind every Edit
 * button on `/admin/settings/civics` (#126, epic #51).
 *
 * =============================================================================
 * WHY THERE IS A CONFIRMATION STEP AT ALL
 * =============================================================================
 *
 * A wrong edit here is immediately visible to every learner studying that
 * question, and it is not undoable by retyping: the lifecycle
 * (`civics-content.md` §4) closes a row and opens another, so a mistake leaves
 * two rows on the record rather than one corrected value. That is the case a
 * confirmation is actually for.
 *
 * It is deliberately NOT a generic "Are you sure?". A yes/no over a question
 * the admin can no longer see confirms nothing — they would be agreeing to
 * their own memory of what they typed. So the confirm step NAMES the change:
 * which question, which state, the value being replaced and the value
 * replacing it, side by side, with the source and the effective date that will
 * be recorded. Everything a reviewer would want in the audit row is on screen
 * before the write, not after it.
 *
 * =============================================================================
 * THE STEPS REPLACE EACH OTHER, THEY ARE NOT STACKED
 * =============================================================================
 *
 * The form is UNMOUNTED while the summary is shown, rather than hidden behind
 * it. A hidden duplicate would double the tab order with fields a keyboard user
 * can reach but not see — the same rule `SettingsHub` follows for its two
 * responsive treatments — and it would put the new answer text on screen twice,
 * so "the confirmation names the new value" would be true of a page that never
 * showed a summary at all.
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import type {
  CivicsAnswerCorrection,
  CivicsDynamicAnswer,
  CivicsDynamicQuestion,
} from '../../types';

export interface CivicsAnswerDialogProps {
  open: boolean;
  /** The question being corrected — named in full on the confirm step. */
  question: CivicsDynamicQuestion;
  /** The state this correction is for, or null for a `national` answer. */
  stateCode: string | null;
  /**
   * The row that will be CLOSED, or null when this slot has no open answer at
   * all — the gap `missingStateCodes` reports. Both cases are ordinary and the
   * dialog says which one it is instead of rendering an empty "current" value.
   */
  currentAnswer: CivicsDynamicAnswer | null;
  isSaving: boolean;
  /** The API's own message, verbatim, when the correction was refused. */
  error: string | null;
  onDismissError: () => void;
  onClose: () => void;
  /** Resolves truthy when the correction landed; the caller closes the dialog. */
  onSubmit: (input: CivicsAnswerCorrection) => Promise<unknown>;
}

/** The scope's own words. `national` has no state, and saying so beats an empty cell. */
export function describeSlot(
  question: CivicsDynamicQuestion,
  stateCode: string | null,
): string {
  return question.dynamicScope === 'state' && stateCode
    ? stateCode
    : 'National — this answer does not vary by state';
}

/** `#43 (v2008)` — how a reviewer names a question. */
export function questionLabel(question: CivicsDynamicQuestion): string {
  return `#${question.number} (${question.testVersionCode})`;
}

/** One labelled row of the confirmation summary. */
function SummaryRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: { xs: 0, sm: 2 } }}>
      <Typography
        component="dt"
        variant="body2"
        color="text.secondary"
        sx={{ minWidth: { sm: 160 }, flexShrink: 0 }}
      >
        {term}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, wordBreak: 'break-word' }}>
        {children}
      </Typography>
    </Box>
  );
}

export function CivicsAnswerDialog({
  open,
  question,
  stateCode,
  currentAnswer,
  isSaving,
  error,
  onDismissError,
  onClose,
  onSubmit,
}: CivicsAnswerDialogProps) {
  const [text, setText] = useState('');
  const [sourceNote, setSourceNote] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const [touched, setTouched] = useState(false);

  // A fresh dialog every time it opens. Carrying the previous slot's typing
  // into the next one is how an admin records Ohio's governor as Oregon's.
  useEffect(() => {
    if (open) {
      setText('');
      setSourceNote('');
      setEffectiveFrom('');
      setStep('edit');
      setTouched(false);
    }
  }, [open, question.questionId, stateCode]);

  const trimmedText = text.trim();
  const trimmedSource = sourceNote.trim();
  // `sourceNote` is REQUIRED by the API and required here for the same reason:
  // `VISION.md`'s "OathPath owns the truth" is a promise a learner can check,
  // and an unsourced correction would make the runtime path the one place in
  // this epic where provenance is optional.
  const textError = touched && !trimmedText ? 'Enter the new answer.' : undefined;
  const sourceError = touched && !trimmedSource ? 'A source is required for every correction.' : undefined;

  const titleId = 'civics-correction-title';

  const handleReview = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!trimmedText || !trimmedSource) return;
    onDismissError();
    setStep('confirm');
  };

  const handleConfirm = async () => {
    const result = await onSubmit({
      questionId: question.questionId,
      // OMITTED for a national answer, never sent as null: the API rejects a
      // `stateCode` on a national question outright rather than ignoring it.
      ...(question.dynamicScope === 'state' && stateCode ? { stateCode } : {}),
      text: trimmedText,
      sourceNote: trimmedSource,
      // An empty box is not a date. Omitted, the server clock stands in — the
      // honest value when no precise real-world date is knowable.
      ...(effectiveFrom ? { effectiveFrom } : {}),
    });
    if (result) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={isSaving ? undefined : onClose}
      aria-labelledby={titleId}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle id={titleId}>
        {step === 'edit' ? 'Correct this answer' : 'Review this correction'}
      </DialogTitle>

      {step === 'edit' ? (
        <Box component="form" onSubmit={handleReview} noValidate>
          <DialogContent dividers>
            <Stack spacing={2}>
              <Box component="dl" sx={{ m: 0, display: 'grid', gap: 0.5 }}>
                <SummaryRow term="Question">
                  {questionLabel(question)} {question.prompt}
                </SummaryRow>
                <SummaryRow term="State">{describeSlot(question, stateCode)}</SummaryRow>
                <SummaryRow term="Current answer">
                  {currentAnswer ? (
                    currentAnswer.text
                  ) : (
                    <em>No answer is recorded for this slot yet.</em>
                  )}
                </SummaryRow>
              </Box>

              <Divider />

              <TextField
                label="New answer"
                value={text}
                onChange={(event) => setText(event.target.value)}
                required
                fullWidth
                multiline
                minRows={2}
                autoFocus
                error={!!textError}
                helperText={textError ?? 'The accepted answer, exactly as a learner should say it.'}
              />
              <TextField
                label="Source"
                value={sourceNote}
                onChange={(event) => setSourceNote(event.target.value)}
                required
                fullWidth
                multiline
                minRows={2}
                error={!!sourceError}
                helperText={
                  sourceError ??
                  'Required. Which official record this answer and its date come from, and when you checked it.'
                }
              />
              <TextField
                label="Effective from"
                type="date"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                fullWidth
                // A date input renders its own placeholder, so the label has to
                // be shrunk or it sits on top of it.
                slotProps={{ inputLabel: { shrink: true } }}
                helperText="The real-world date this became correct, from the same source. Leave blank to record today."
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" variant="contained">
              Review correction
            </Button>
          </DialogActions>
        </Box>
      ) : (
        <>
          <DialogContent dividers>
            {/* NAMES THE CHANGE, rather than asking "are you sure?" over a
                question the admin can no longer see. */}
            <Box component="dl" sx={{ m: 0, display: 'grid', gap: 1 }}>
              <SummaryRow term="Question">
                {questionLabel(question)} {question.prompt}
              </SummaryRow>
              <SummaryRow term="State">{describeSlot(question, stateCode)}</SummaryRow>
              <SummaryRow term="Current answer">
                {currentAnswer ? (
                  currentAnswer.text
                ) : (
                  <em>No answer is recorded for this slot yet.</em>
                )}
              </SummaryRow>
              <SummaryRow term="New answer">
                <strong>{trimmedText}</strong>
              </SummaryRow>
              <SummaryRow term="Source">{trimmedSource}</SummaryRow>
              <SummaryRow term="Effective from">
                {effectiveFrom || 'Today (no real-world date given)'}
              </SummaryRow>
            </Box>

            <Alert severity="info" sx={{ mt: 2 }}>
              {/* Said plainly BEFORE the write, because the mental model is the
                  whole difference between this surface and an ordinary editor. */}
              This does not overwrite the current answer. It closes it and opens a new one, so
              the answer a learner was graded against last month stays on record.
            </Alert>

            {error && (
              <Alert severity="error" sx={{ mt: 2 }} onClose={onDismissError}>
                <AlertTitle>The correction was not recorded</AlertTitle>
                {error}
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setStep('edit')} disabled={isSaving}>
              Back
            </Button>
            <Button onClick={handleConfirm} variant="contained" disabled={isSaving}>
              {isSaving ? 'Recording…' : 'Record correction'}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}
