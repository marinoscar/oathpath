/**
 * The counts on a finished session — correct, not matched, skipped.
 *
 * Issue #79, epic #52.
 *
 * =============================================================================
 * EVERY NUMBER HERE IS THE SERVER'S. NONE OF THEM IS DERIVED IN THE BROWSER.
 * =============================================================================
 *
 * The props are one `PracticeSessionSummary`, exactly as it was persisted by
 * `POST /api/practice/sessions/:id/complete`, and this component does no
 * arithmetic on it beyond reading fields. That is deliberate:
 * `practice-sessions.md` §10 says every number in that summary is computed from
 * the attempt rows that were actually written, and that if the summary ever
 * disagreed with the attempts, the attempts are right. A percentage assembled
 * here — `correct / answered * 100` — would be a fourth place the same fact is
 * stated, and the first one to be wrong when `partial` becomes reachable in E4.
 *
 * **There is no score, no grade and no pass/fail line**, and that is a boundary
 * rather than an omission. Readiness is E6 (#55), computed over the whole
 * evidence table with the interview's own pass threshold in front of it; a
 * "4/5 — you'd pass!" banner assembled from one session would be this product
 * telling a learner something about their real interview that nobody has
 * checked. `VISION.md`'s premise is accurate confidence, and a flattering
 * per-session verdict is exactly how a product loses it.
 *
 * =============================================================================
 * THE QUIET COUNTS ARE SHOWN, NOT HIDDEN
 * =============================================================================
 *
 * `selfMarked` and `revealed` are rendered as plain sentences when they are
 * non-zero. They make the tally above them WEAKER, which is precisely why they
 * belong on screen: a learner who self-marked three of their four "correct"
 * answers is entitled to know that before they read the four as evidence of
 * anything. Suppressing them would leave the same number on screen meaning two
 * very different things, with no way to tell which.
 *
 * `hintUsed` is not rendered — nothing in E3 produces a hint, so a line
 * reporting zero of them would describe a feature that does not exist.
 */

import { Box, Paper, Stack, Typography } from '@mui/material';

import type { PracticeSessionSummary } from '../../types';
import { formatDuration } from './outcome';

export interface SummaryTallyProps {
  summary: PracticeSessionSummary;
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

/** One count, as a number over a label. */
function Count({ value, label }: { value: number; label: string }) {
  return (
    <Box sx={{ minWidth: 88 }}>
      <Typography
        variant="h4"
        component="p"
        sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}

export function SummaryTally({ summary, headingId }: SummaryTallyProps) {
  const duration = formatDuration(summary.totalDurationMs);

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
        How it went
      </Typography>

      <Typography sx={{ mt: 1 }}>
        You answered {summary.answered} of {summary.plannedCount}.
      </Typography>

      {/* Wraps rather than scrolls at 360px: three counts side by side fit, and
          a fourth (E4's `partial`) drops to a second row instead of pushing the
          first one off the screen. */}
      <Stack
        direction="row"
        spacing={3}
        sx={{ mt: 2, flexWrap: 'wrap', rowGap: 2 }}
      >
        <Count value={summary.correct} label="correct" />
        {/* Rendered only when it can happen. E4's semantic grader is the first
            producer of `partial`; until then a permanent "0 partly right"
            column would describe a verdict this build cannot reach. */}
        {summary.partial > 0 && <Count value={summary.partial} label="partly right" />}
        <Count value={summary.incorrect} label="not matched" />
        <Count value={summary.skipped} label="skipped" />
      </Stack>

      {summary.selfMarked > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          {summary.selfMarked} of those you marked correct yourself.
        </Typography>
      )}

      {summary.revealed > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          You asked to see the answer on {summary.revealed}
          {summary.revealed === 1 ? ' question' : ' questions'}.
        </Typography>
      )}

      {duration && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {/* `timedAttempts` is named alongside the total, so a partial total
              can never be read as a complete one — the server sends null, not
              0, when nothing was timed, and this line does not render at all in
              that case. */}
          {duration} across {summary.timedAttempts}
          {summary.timedAttempts === 1 ? ' timed answer' : ' timed answers'}.
        </Typography>
      )}
    </Paper>
  );
}

export default SummaryTally;
