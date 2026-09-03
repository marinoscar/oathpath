/**
 * Where the applicant answers.
 *
 * Issue #140, epic #57 / E8. One `<form>`, one labelled field, one button, and
 * deliberately nothing else.
 *
 * =============================================================================
 * THE CONTROLS THE PRACTICE SCREEN HAS AND THIS ONE DOES NOT
 * =============================================================================
 *
 * `PracticeSessionPage` offers three ways to end a question — Submit, "Show me
 * the answer", and Skip. This box offers ONE, and the two that are missing are
 * missing on purpose rather than unbuilt:
 *
 *   * **No reveal.** A real officer does not show an applicant the accepted
 *     answer mid-interview. `VISION.md`'s Product Principle 7 — "coaching
 *     decreases as realism increases" — is the whole reason this screen exists
 *     as something other than a longer drill.
 *   * **No skip.** The API has no `skipped` field on a turn body at all
 *     (`interview-turn.dto.ts`), and an empty answer is accepted instead. An
 *     applicant who says nothing has still taken their turn: the officer
 *     acknowledges it and moves on, exactly as at the real event. Rejecting an
 *     empty answer would make "I don't know" the one thing a rehearsal of a
 *     high-stakes conversation refuses to let a nervous person say — so the
 *     submit button stays enabled on an empty field, and says so.
 *
 * =============================================================================
 * ACCESSIBILITY
 * =============================================================================
 *
 * A REAL `<label>` (MUI's `label` prop renders one bound to the input, never a
 * placeholder pretending to be one), a real `<form>` so the keyboard's usual
 * submit works, and focus taken whenever a new officer turn arrives so a
 * keyboard or screen-reader user is never hunting for where to type.
 *
 * Multiline, because an interview answer is spoken language and can run longer
 * than a drill's few words — but `Enter` still submits and `Shift+Enter` still
 * breaks the line, which is what a person typing a sentence expects.
 */

import { useEffect, useRef } from 'react';
import { Box, Button, Stack, TextField, Typography } from '@mui/material';

export interface AnswerBoxProps {
  value: string;
  onChange: (value: string) => void;
  /** Send this answer. The page owns the request. */
  onSubmit: () => void;
  /** True while the officer's reply is streaming — the box waits its turn. */
  disabled?: boolean;
  /** True while this answer is in flight, for the button's own label. */
  pending?: boolean;
  /**
   * Changes whenever there is a new officer turn to answer, and is what moves
   * focus back to the field. A plain counter or a turn id — anything stable
   * between renders of the same question.
   */
  focusKey?: string | number;
}

export function AnswerBox({
  value,
  onChange,
  onSubmit,
  disabled = false,
  pending = false,
  focusKey,
}: AnswerBoxProps) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // A new officer turn takes the focus back. Keyed on the caller's own value
  // rather than on a render, so it does not fight a learner who is mid-sentence
  // when some unrelated state changes.
  useEffect(() => {
    if (!disabled) inputRef.current?.focus();
  }, [focusKey, disabled]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    onSubmit();
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ mt: 3 }}>
      <TextField
        // A REAL `<label>`, bound to the input by MUI. Never a placeholder.
        label="Your answer"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputRef={inputRef}
        fullWidth
        multiline
        minRows={2}
        autoComplete="off"
        // Off, deliberately, exactly as on the practice screen: the browser's
        // autocorrect offers a different word than the learner meant, and their
        // answer is compared as text.
        spellCheck={false}
        disabled={disabled}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter breaks the line. A multiline field
          // otherwise swallows the key a person typing one sentence expects to
          // finish with.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (!disabled) onSubmit();
          }
        }}
        helperText="Answer the way you would out loud. You will not be told how you did until the interview is over."
      />

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ mt: 2, alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        <Button type="submit" variant="contained" size="large" disabled={disabled}>
          {pending ? 'Sending…' : 'Answer'}
        </Button>

        {/* Said plainly rather than enforced. See the file header: an empty
            answer is a real answer here. */}
        {!value.trim() && (
          <Typography variant="body2" color="text.secondary">
            You can answer without typing anything if you don&rsquo;t know.
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

export default AnswerBox;
