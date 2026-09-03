/**
 * "Keep a transcript of this interview" — asked once, before it starts.
 *
 * Issue #140, epic #57 / E8. The web half of `transcript_retained`
 * (`docs/specs/mock-interview.md` §8), which is the most conservative thing
 * this product does with the most sensitive thing it touches.
 *
 * =============================================================================
 * OFF BY DEFAULT, AND ASKED EXACTLY ONCE
 * =============================================================================
 *
 * `defaultChecked` does not exist on this component and the caller's state
 * starts `false`, matching the API's DTO default and the database column's own
 * `@default(false)`. §15 records why retention-on-by-default lost: "the
 * conservative-handling posture applies to the DEFAULT, not only to the
 * OPTION" — a learner who never touches this control must not end up in the
 * permissive state.
 *
 * It is offered on the START screen and never again mid-interview, and that is
 * not a layout convenience. It is a per-interview decision made BEFORE there is
 * anything to retain: asking halfway through would be asking someone to consent
 * to keeping words they have already said, and asking every time would make the
 * answer a habit rather than a choice. §15 also records why it is not a user
 * setting — a standing preference applies to every future interview, including
 * one a learner starts without re-checking what their prior self configured.
 *
 * =============================================================================
 * THE SENTENCE
 * =============================================================================
 *
 * One plain sentence, and it says exactly what §8.2's table says is kept when
 * this is on: the applicant's own turn text, the response text on every graded
 * civics answer, and the AI grader's written feedback (which is included
 * because a grader's feedback quotes the learner's phrasing often enough that
 * storing it would be a second, indirect way to retain their words).
 *
 * The second line is §8.3, which is the other half of an honest choice: what is
 * kept EITHER WAY. A learner declining retention is declining to keep their own
 * phrasing — not the record of what they were asked, what the accepted answers
 * were, or how they did. Saying so is what stops "off" from reading like
 * "this interview will not count".
 */

import { Box, FormControlLabel, Switch, Typography } from '@mui/material';

export interface RetentionChoiceProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function RetentionChoice({
  checked,
  onChange,
  disabled = false,
}: RetentionChoiceProps) {
  return (
    <Box>
      {/* `FormControlLabel` renders a real `<label>` bound to the switch, so
          the whole sentence is the control's accessible name and its hit
          target. */}
      <FormControlLabel
        control={
          <Switch
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            disabled={disabled}
          />
        }
        label="Keep a transcript of this interview"
      />

      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 0.5, maxWidth: '60ch' }}
      >
        If you turn this on, we keep everything you type during this interview
        &mdash; your answers in your own words, and the assistant&rsquo;s
        written feedback on them.
      </Typography>

      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 1, maxWidth: '60ch' }}
      >
        Either way, we keep every question you were asked, the accepted answers,
        and whether you got it right. What you leave off is only the record of
        your own wording, which means you won&rsquo;t be able to re-read it
        later.
      </Typography>
    </Box>
  );
}

export default RetentionChoice;
