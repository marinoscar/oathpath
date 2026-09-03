/**
 * How the civics section went — the verdict, the counts, and why it stopped.
 *
 * Issue #145, epic #57 / E8. The first thing on the debrief, because it is the
 * thing the learner opened the page for.
 *
 * =============================================================================
 * THIS COMPONENT DOES NO ARITHMETIC. NONE AT ALL.
 * =============================================================================
 *
 * Every number on screen is a field of the {@link InterviewCivicsResult} it is
 * handed, and every sentence is produced by `debriefCopy.ts` from those same
 * fields. There is no `correct / asked * 100`, no `asked - correct`, and above
 * all no literal pass mark: `threshold` and `planned` were echoed by the API
 * from the `civics_test_versions` row this interview was created against, and
 * `docs/specs/mock-interview.md` §11 is explicit that a client re-typing either
 * would reintroduce, one layer up, exactly the code-versus-data divergence the
 * engine reads that row to avoid. `debriefCopy.ts`'s header carries the full
 * argument; this component's contribution is having nowhere to put a constant.
 *
 * =============================================================================
 * THE VERDICT IS TEXT, NOT ONLY A COLOUR
 * =============================================================================
 *
 * "Civics section passed" / "Civics section not passed" is rendered as words in
 * a chip whose colour is a MUI palette role, so the dark theme is a re-render
 * rather than a second design and a learner who cannot distinguish the two
 * colours reads the same fact everyone else does — the identical reasoning
 * `components/practice/AttemptReview.tsx` gives for its own outcome chip.
 *
 * It is a chip and not a banner, and the colour on a miss is `error` and not
 * `warning`: dressing a failed section as a caution would be softening a real
 * result into vagueness, which §11.1 rules out in the same breath as
 * sharpening it into judgment.
 */

import { Chip, Paper, Stack, Typography } from '@mui/material';

import type { InterviewCivicsResult } from '../../types';
import {
  civicsCountsSentence,
  civicsVerdictLabel,
  stopReasonSentence,
} from './debriefCopy';

export interface CivicsResultPanelProps {
  civics: InterviewCivicsResult;
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

export function CivicsResultPanel({ civics, headingId }: CivicsResultPanelProps) {
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
        How the civics section went
      </Typography>

      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 1.5, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Chip
          label={civicsVerdictLabel(civics.passed)}
          color={civics.passed ? 'success' : 'error'}
        />
      </Stack>

      {/* `tabular-nums` so the two number pairs line up rather than shifting
          under each other as digits change width. */}
      <Typography sx={{ mt: 2, fontVariantNumeric: 'tabular-nums' }}>
        {civicsCountsSentence(civics)}
      </Typography>

      {/* WHY IT ENDED, ALWAYS — including in the ordinary `all_asked` case.
          §4.1: an early stop is a real mechanic of the real test, and a learner
          who sees a section that ran six of ten questions with no explanation
          is looking at something indistinguishable from a bug. */}
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mt: 1.5, maxWidth: '60ch' }}
      >
        {stopReasonSentence(civics.stopReason, civics)}
      </Typography>
    </Paper>
  );
}

export default CivicsResultPanel;
