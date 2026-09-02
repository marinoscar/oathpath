/**
 * The verdict, and — only when a grader actually produced one — why the answer
 * missed and the one line of coaching that goes with it.
 *
 * Issue #125, epic #53. E3 (#79) rendered a bare verdict: a chip, a sentence,
 * and a note saying who decided. This is that same block with the AI grading
 * rung's output folded into it, and it is deliberately ONE component used by
 * both surfaces that show a judgement — the live session screen
 * (`AttemptFeedback`) and the summary's per-question review (`AttemptReview`).
 *
 * =============================================================================
 * ONE COMPONENT, BECAUSE A LEARNER MUST READ THE SAME JUDGEMENT TWICE
 * =============================================================================
 *
 * A learner sees the verdict live, and then again when they revisit the
 * session. If those two screens each assembled the cause and the coaching from
 * the attempt row themselves, they would drift — one would gate on
 * `gradingMethod`, the other on `failureCause != null`, and a learner would
 * come back to a debrief that says something subtly different from what they
 * were told at the time. On a product whose premise is accurate confidence,
 * a judgement that changes when you look at it again is corrosive in a way a
 * missing feature is not.
 *
 * =============================================================================
 * THE RULE THAT MATTERS MOST: A DETERMINISTIC GRADE INVENTS NOTHING
 * =============================================================================
 *
 * **`gradingMethod: 'exact'` and `'self'` render the plain verdict and stop.**
 * No cause, no coaching, no placeholder, no "we couldn't analyse this one".
 *
 * That is not defensive coding — it is the whole point of the ladder. Rung 3 of
 * `ai-evaluation.md` §6 says an unavailable, failed or schema-invalid grading
 * call falls back to the deterministic result and persists
 * `gradingMethod: 'exact'` with all three AI columns NULL. So "graded exactly"
 * covers both "the matcher matched" and "no AI opinion exists", and in neither
 * case has anything diagnosed this learner. Rendering a cause there would be
 * the product telling somebody a specific, memorable, confident story about
 * their own mind that no grader ever told — `ai-evaluation.md` §8 names that
 * the "manufactured diagnosis" and rejects it explicitly, which is also why the
 * taxonomy keeps an honest `unknown` rather than forcing a guess.
 *
 * The gate below is therefore `gradingMethod === 'ai'` FIRST, and the presence
 * of the fields second. Gating on the fields alone would work today and would
 * quietly become wrong the moment any other path writes one of them.
 *
 * =============================================================================
 * NULL AND `unknown` ARE DIFFERENT, AND BOTH ARE RENDERED HONESTLY
 * =============================================================================
 *
 * `failureCause: null` on an `ai`-graded attempt means the grader said
 * `correct` — a correct verdict has nothing to explain, so the API writes no
 * cause (§6 rung 2). `unknown` means the grader ran and could not tell, which
 * has its own copy in `failureCause.ts` and is shown, because "we can't tell
 * from this answer alone" is a true and useful thing to read.
 *
 * =============================================================================
 * THE COACHING LINE IS A SENTENCE, NOT AN ANSWER
 * =============================================================================
 *
 * `aiFeedback.feedback` is capped at 240 characters server-side and its schema
 * has no field that could carry an accepted answer (`ai-evaluation.md` §7). It
 * is rendered as ordinary text — never as HTML, never through
 * `dangerouslySetInnerHTML` — and it is placed BELOW the cause and ABOVE
 * nothing: the accepted answers are `AttemptFeedback`'s to render, from the
 * attempt's own frozen snapshot, and they never come from anything a model
 * said.
 */

import { Box, Chip, Stack, Typography } from '@mui/material';

import type { PracticeAttempt } from '../../types';
import { failureCauseDisplay } from './failureCause';
import { gradingMethodNote, outcomeDisplay } from './outcome';

export interface AiFeedbackCardProps {
  /** The recorded attempt. The only source of everything rendered here. */
  attempt: PracticeAttempt;

  /**
   * Render the verdict chip and its sentence.
   *
   * `false` on the summary's review rows, which already carry the chip in
   * their own header line beside the question number — stating the same
   * judgement twice on one card reads as two judgements. Everything below the
   * verdict is unchanged either way, which is what keeps the two surfaces
   * saying the same thing.
   */
  includeVerdict?: boolean;
}

export function AiFeedbackCard({
  attempt,
  includeVerdict = true,
}: AiFeedbackCardProps) {
  const verdict = outcomeDisplay(attempt.outcome);
  const provenance = gradingMethodNote(attempt.gradingMethod);

  /**
   * Did a grader actually run on this attempt?
   *
   * The gate for EVERYTHING below the verdict. See the file header — an
   * `exact` or `self` grade has no diagnosis behind it, and the absence is
   * correct rather than missing.
   */
  const graded = attempt.gradingMethod === 'ai';

  const cause = graded ? failureCauseDisplay(attempt.failureCause) : null;
  // Trimmed and length-checked so a model that returned whitespace produces no
  // empty paragraph with a heading over it.
  const coaching = graded ? (attempt.aiFeedback?.feedback ?? '').trim() : '';

  /**
   * Nothing to contribute at all.
   *
   * The ordinary `exact`-graded case on the summary screen, where the verdict
   * is already in the row's header: no provenance note (the deterministic
   * matcher is the normal case and labelling every normal row is noise), no
   * cause, no coaching. Returning `null` rather than an empty `<Box>` keeps a
   * stray element and its margin out of a layout that has nothing to say.
   */
  if (!includeVerdict && !provenance && !cause && !coaching) return null;

  return (
    <Box sx={{ mt: includeVerdict ? 0 : 2 }}>
      {includeVerdict && (
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          {/* The chip is the verdict at a glance; the sentence beside it is the
              verdict for anybody reading rather than scanning. Both are text,
              so neither depends on colour alone — a red chip and a green chip
              are the same chip to a learner who cannot distinguish them. */}
          <Chip label={verdict.label} color={verdict.color} size="small" />
          <Typography variant="body2" color="text.secondary">
            {verdict.detail}
          </Typography>
        </Stack>
      )}

      {provenance && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {provenance}
        </Typography>
      )}

      {cause && (
        // Set apart with a rule down its side rather than a nested box: this is
        // the one part of the card that is about the learner rather than about
        // the answer, and it should read as a remark, not as an alert. `info`
        // colouring would make a diagnosis look like a system message; a plain
        // border in the divider colour is legible in both themes without
        // claiming a severity it does not have.
        <Box
          sx={{
            mt: 2,
            pl: 2,
            borderLeft: 2,
            borderColor: 'divider',
          }}
        >
          <Typography variant="subtitle2" component="p" sx={{ fontWeight: 600 }}>
            {cause.headline}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {cause.detail}
          </Typography>

          {coaching && (
            <Typography variant="body2" sx={{ mt: 1.5 }}>
              {coaching}
            </Typography>
          )}
        </Box>
      )}

      {/* The grader ran, said `correct`, and left a sentence: there is no cause
          to explain (a correct verdict has nothing to explain), but the
          sentence is still worth reading, so it is not lost with the block
          above. */}
      {!cause && coaching && (
        <Typography variant="body2" sx={{ mt: 2 }}>
          {coaching}
        </Typography>
      )}
    </Box>
  );
}

export default AiFeedbackCard;
