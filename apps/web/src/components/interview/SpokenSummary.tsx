/**
 * How the spoken half of this interview went.
 *
 * Issue #160, epic #60 / E11. `docs/specs/realtime-interview.md` §6.
 *
 * =============================================================================
 * THREE COUNTS, ALL THE SERVER'S, ALL TRACEABLE TO A ROW
 * =============================================================================
 *
 * `answers`, `correct` and `misheard` are counted server-side over this
 * interview's own `practice_attempts` rows — spoken answers, the ones graded
 * correct, and the ones carrying `failure_cause: 'misheard'`. Nothing here
 * counts chips on screen, subtracts one number from another, or says anything
 * about how the learner sounded.
 *
 * That last omission is the point rather than an oversight. §4.2 discards any
 * verdict the realtime model implied, and a "how you came across" line on this
 * band would be exactly that verdict arriving through a door the tool contract
 * closed — a model's impression of a conversation, rendered as a finding. If it
 * is not on a row, it is not on this card.
 *
 * =============================================================================
 * ABSENT, NOT EMPTY, FOR A TEXT INTERVIEW
 * =============================================================================
 *
 * The API sends `{ answers: 0, correct: 0, misheard: 0 }` for every text
 * interview rather than omitting the object, and `spokenSummarySentence`
 * returns null for it, so this component renders nothing. A band reading "0
 * answers spoken aloud" on a rehearsal that was never meant to be spoken is
 * noise: `PhaseCoverage` is where this screen says what a rehearsal did not
 * include, and it says it once.
 */

import { Alert, Paper, Stack, Typography } from '@mui/material';

import type { InterviewSpokenSummary } from '../../types';
import { misheardNote, spokenSummarySentence } from './debriefCopy';

export interface SpokenSummaryProps {
  spoken: InterviewSpokenSummary;
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

export function SpokenSummary({ spoken, headingId }: SpokenSummaryProps) {
  const summary = spokenSummarySentence(spoken);

  // Nothing was spoken. See the header: silence is the honest render, and
  // `PhaseCoverage` already carries what this rehearsal did not include.
  if (!summary) return null;

  const misheard = misheardNote(spoken);

  return (
    <Paper
      component="section"
      aria-labelledby={headingId}
      variant="outlined"
      sx={{ p: { xs: 2, sm: 3 } }}
    >
      <Typography
        id={headingId}
        component="h2"
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', letterSpacing: '0.08em' }}
      >
        Answered aloud
      </Typography>

      <Stack spacing={1} sx={{ mt: 1 }}>
        <Typography sx={{ maxWidth: '60ch' }}>{summary}</Typography>

        {/* `role="status"` rather than MUI's default `"alert"`: this is
            standing content explaining a result, not a transient error worth
            interrupting a screen-reader user with — the same override
            `ReadinessMovement` makes for the cap. `info`, never `warning`:
            being misheard is not something the learner did. */}
        {misheard && (
          <Alert severity="info" icon={false} role="status">
            <Typography variant="body2">{misheard}</Typography>
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}

export default SpokenSummary;
