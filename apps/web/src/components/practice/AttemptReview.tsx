/**
 * One question from a finished session, read back: what the learner said, and
 * what was accepted.
 *
 * Issue #79, epic #52.
 *
 * =============================================================================
 * THE LEARNER'S OWN WORDS, VERBATIM, BESIDE THE ANSWER THEY WERE COMPARED TO
 * =============================================================================
 *
 * `responseText` is stored raw and rendered raw. Normalisation happens only
 * inside the matcher and is never written back, so this row shows what the
 * learner actually typed — not a lowercased, de-punctuated version of it that
 * would leave them wondering why the product had rewritten their answer.
 *
 * The accepted answers come from `attempt.answerSnapshot`, FROZEN at the
 * instant the attempt was graded, never re-resolved. That is what keeps this
 * screen honest a year later: a dynamic answer ("who is the Speaker of the
 * House") changes by design, and re-resolving it here would tell a learner they
 * used to be wrong about something they still know. `AcceptedAnswers` carries
 * the longer version of that argument.
 *
 * =============================================================================
 * A SKIP IS SHOWN AS A SKIP
 * =============================================================================
 *
 * Not as an empty row, not as a blank quotation, and not silently omitted from
 * the list. A skip is real evidence — it is what "I have no idea" looks like —
 * and a debrief that hid it would leave the learner reading a shorter session
 * than the one they sat through.
 */

import { Box, Chip, Paper, Stack, Typography } from '@mui/material';

import type { PracticeAttempt } from '../../types';
import { AcceptedAnswers } from './AcceptedAnswers';
import { AiFeedbackCard } from './AiFeedbackCard';
import { outcomeDisplay } from './outcome';

export interface AttemptReviewProps {
  attempt: PracticeAttempt;
}

export function AttemptReview({ attempt }: AttemptReviewProps) {
  const verdict = outcomeDisplay(attempt.outcome);
  const response = attempt.responseText?.trim() ?? '';

  return (
    <Paper component="li" variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          Question {attempt.question.number}
        </Typography>
        {/* Text as well as colour: a red chip and a green chip are the same
            chip to a learner who cannot tell them apart. */}
        <Chip label={verdict.label} color={verdict.color} size="small" />
      </Stack>

      {/* `h3` under the page's `h2` section heading — the summary page owns the
          single `h1`. The size is design; the level is semantics. */}
      <Typography variant="h6" component="h3" sx={{ mt: 0.5, fontWeight: 600 }}>
        {attempt.question.prompt}
      </Typography>

      <Box sx={{ mt: 2 }}>
        <Typography
          variant="overline"
          component="h4"
          color="text.secondary"
          sx={{ display: 'block', mb: 0.5 }}
        >
          Your answer
        </Typography>
        {attempt.outcome === 'skipped' && !response ? (
          <Typography variant="body1" color="text.secondary">
            You skipped this one.
          </Typography>
        ) : response ? (
          <Typography variant="body1">{response}</Typography>
        ) : (
          <Typography variant="body1" color="text.secondary">
            You didn&rsquo;t type an answer.
          </Typography>
        )}
      </Box>

      <Box sx={{ mt: 2 }}>
        <AcceptedAnswers
          answers={attempt.answerSnapshot.answers}
          answerResolution={attempt.answerSnapshot.answerResolution}
          resolvedForStateCode={attempt.answerSnapshot.resolvedForStateCode}
          headingComponent="h4"
        />
      </Box>

      {/* THE SAME JUDGEMENT THE LEARNER SAW LIVE, from the same component the
          session screen uses — who graded it, why the answer missed, and the
          one line of coaching. `includeVerdict={false}` because the header row
          above already carries the verdict chip beside the question number;
          stating one judgement twice on one card reads as two.

          It contributes NOTHING for a deterministically graded attempt with no
          note to make — no heading, no spacing, no empty rule — so an ordinary
          exact-match row reads exactly as it did before E4. */}
      <AiFeedbackCard attempt={attempt} includeVerdict={false} />

      {/* The other fact that makes a `correct` weaker, stated only when it is
          true. With the provenance note above, the two are what stop one
          number in the tally from meaning two different things. */}
      {attempt.revealed && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          You asked to see the answer on this one.
        </Typography>
      )}
    </Paper>
  );
}

export default AttemptReview;
