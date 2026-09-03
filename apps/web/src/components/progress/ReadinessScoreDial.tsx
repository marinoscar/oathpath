/**
 * The readiness score dial — `/progress`'s headline number.
 *
 * Issue #139, epic #55 / E6. NO CHARTING LIBRARY: this app has none
 * (`apps/web/package.json`), the same constraint `MasteryBreakdownBar`'s own
 * header states, and `CircularProgress variant="determinate"` with the score
 * overlaid as text is the low-risk primitive this task's own instructions
 * name for exactly this case.
 *
 * This ring carries a real `role="progressbar"` with a real `aria-valuenow`,
 * because `score` is a real, server-computed value (§5's
 * `round(weightedSum * 100)`) — reporting it as a progressbar is the honest
 * choice, not the dishonest one. E1's goal-ring placeholder was the opposite
 * case and claimed no role at all: `dailyGoal.tracked` was `false` all
 * through E1, so there was no number to report. E7 (#138) measured the day
 * and replaced that placeholder with `components/home/GoalRing.tsx`, which
 * now claims the role too — on the strength of a measurement, exactly as
 * this one does.
 *
 * The two rings answer DIFFERENT questions and must never borrow each
 * other's words: this one is readiness, `GoalRing` is consistency
 * (`docs/specs/habit-streaks.md` §8, `PRD.md`).
 */

import { Box, Chip, CircularProgress, Typography } from '@mui/material';

export interface ReadinessScoreDialProps {
  /** 0-100. */
  score: number;
  /** The learner's `JourneyStage` key, e.g. `practicing` — shown as a chip. */
  stage: string;
}

/** `practicing` → `Practicing`. A formatting utility, not a stage registry —
 * see `readiness.ts`'s own header on why this file declares no stage list. */
function formatStageKey(stage: string): string {
  return stage
    .split('_')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

export function ReadinessScoreDial({ score, stage }: ReadinessScoreDialProps) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
      <Box sx={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
        <CircularProgress
          variant="determinate"
          value={score}
          size={120}
          thickness={4}
          role="progressbar"
          aria-valuenow={score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Readiness score: ${score} out of 100`}
        />
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Typography component="span" variant="h4" sx={{ fontWeight: 700 }}>
            {score}
          </Typography>
        </Box>
      </Box>

      <Box>
        <Typography variant="body2" color="text.secondary">
          out of 100
        </Typography>
        <Chip
          label={formatStageKey(stage)}
          size="small"
          color="primary"
          variant="outlined"
          sx={{ mt: 0.5 }}
        />
      </Box>
    </Box>
  );
}

export default ReadinessScoreDial;
