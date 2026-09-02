/**
 * The 65/20 marker.
 *
 * Issue #121, epic #51. `civics_questions.senior_eligible` marks membership in
 * the fixed subset an applicant aged 65 or older, and a permanent resident for
 * twenty years or more, is examined from. It is worth showing on `/learn`
 * because it is the one property of a question that changes what a learner in
 * that situation has to study — and because a learner who qualifies and cannot
 * see which questions apply to them is being asked to memorise a hundred
 * questions for an interview that draws on twenty.
 *
 * IT NEVER AFFECTS AN ANSWER, and nothing here implies it does. The
 * accommodation filters the question SET; the answer to "who is the Speaker of
 * the House" does not change because of who is being asked
 * (`civics-content.md` §5).
 *
 * THE SHORT LABEL IS EXPLAINED ON THE PAGE, NOT INSIDE THE CHIP. "65/20" is
 * opaque on its own, and a `title` attribute is unavailable to a touch user and
 * unreliable to a screen reader. So the chip carries the short form, and the
 * surfaces that use it render `SENIOR_MARKER_DESCRIPTION` once, visibly, as
 * ordinary prose — see `QuestionList` and `QuestionDetail`.
 */

import { Chip } from '@mui/material';

/** The visible label. Short on purpose: it sits on a list row at 360px. */
export const SENIOR_MARKER_LABEL = '65/20';

/** The one-sentence explanation every surface using the chip must also render. */
export const SENIOR_MARKER_DESCRIPTION =
  'Questions marked 65/20 are the ones asked of applicants who are 65 or older and have been permanent residents for 20 years or more.';

export interface SeniorEligibleChipProps {
  size?: 'small' | 'medium';
}

export function SeniorEligibleChip({ size = 'small' }: SeniorEligibleChipProps) {
  return (
    <Chip
      // `span`, not the default `div`: this renders inside list-item text and
      // inside a heading row, and a block element there is invalid markup that
      // browsers recover from inconsistently.
      component="span"
      size={size}
      variant="outlined"
      color="secondary"
      label={SENIOR_MARKER_LABEL}
      // Both colours come from the palette, so the dark theme is a re-render
      // rather than a second design.
      sx={{ fontWeight: 600 }}
    />
  );
}

export default SeniorEligibleChip;
