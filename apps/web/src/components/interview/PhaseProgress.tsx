/**
 * Where the learner is in the interview — and nothing about how they are doing.
 *
 * Issue #140, epic #57 / E8.
 *
 * =============================================================================
 * TWO FACTS, AND THE THIRD ONE THIS COMPONENT MUST NEVER RENDER
 * =============================================================================
 *
 * It renders the part of the interview currently under way ("Part 3 of 6 ·
 * Civics questions") and, inside the civics phase, which question is on the
 * table ("Question 4 of 10").
 *
 * It does NOT render how many were right, and it structurally cannot: the only
 * shape it is given is `InterviewProgress`, which carries `civicsAsked` and
 * `civicsPlanned` and deliberately has no `civicsCorrect` field — the API left
 * it off this payload for exactly this reason, even though the interview's
 * header row has one. `docs/specs/mock-interview.md` §10 is the rule and the
 * reason: "6 of 10 asked" is pacing, which the real interview also gives an
 * applicant; "4 of 6 correct" is a running score, which it never does. A
 * learner who sees a tick after each answer is rehearsing reassurance the
 * actual event will not provide.
 *
 * =============================================================================
 * "PART 3 OF 6" IS POSITION, NOT A PREVIEW
 * =============================================================================
 *
 * The six phases are deliberately NOT listed. Naming what is coming would turn
 * a progress line into a syllabus, and the interview's shape — how many
 * questions, whether it stops early — is something the learner is supposed to
 * experience rather than read ahead of. A count of parts tells them how far
 * along they are without telling them what is in the parts they have not
 * reached; the officer's own turns are what introduce each one.
 *
 * The one number that IS a preview, honestly, is `civicsPlanned` — and it is
 * the number the early stop is legible against. A learner stopped at 6 of 10
 * can see that a full run would have been 10, which is what makes finishing
 * early read as the real test's own mechanic rather than as a bug.
 *
 * =============================================================================
 * ACCESSIBILITY
 * =============================================================================
 *
 * Text first, and there is no progress bar. A bar here would either announce a
 * percentage nobody asked for or be silent decoration above a live region that
 * is already announcing the officer — and, worse, a filling bar reads as a
 * score to a glancing eye, which is the one thing this line must not look like.
 */

import { Typography } from '@mui/material';

import { phaseLabel, phasePosition, INTERVIEW_PHASE_ORDER } from './phases';
import type { InterviewProgress } from '../../types';

export interface PhaseProgressProps {
  /** The phase the interview is in now, or null before the first turn is read. */
  phase: string | null;
  progress: InterviewProgress | null;
  /** True once the only remaining action is finishing — no question is open. */
  awaitingCompletion?: boolean;
}

export function PhaseProgress({
  phase,
  progress,
  awaitingCompletion = false,
}: PhaseProgressProps) {
  if (!phase) return null;

  const position = phasePosition(phase);
  const parts: string[] = [];

  if (position !== null) {
    parts.push(`Part ${position} of ${INTERVIEW_PHASE_ORDER.length}`);
  }
  parts.push(phaseLabel(phase));

  /**
   * Which civics question is on the table.
   *
   * `civicsAsked` counts questions ANSWERED, so the one awaiting an answer is
   * the next one — hence `+ 1`, clamped so a phase that has just ended cannot
   * read "Question 11 of 10". Rendered only while the civics phase is actually
   * open: once the stop rule has fired, "Question 7 of 10" beside a closing
   * statement would be describing a question nobody is going to be asked.
   */
  const civicsPosition =
    phase === 'civics' && progress && !awaitingCompletion
      ? Math.min(progress.civicsAsked + 1, progress.civicsPlanned)
      : null;

  return (
    <>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {parts.join(' · ')}
      </Typography>

      {civicsPosition !== null && progress && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          Question {civicsPosition} of {progress.civicsPlanned}
        </Typography>
      )}
    </>
  );
}

export default PhaseProgress;
