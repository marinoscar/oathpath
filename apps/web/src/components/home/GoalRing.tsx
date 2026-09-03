/**
 * The goal ring — `today.practiceSeconds` measured against
 * `dailyGoalMinutes * 60`.
 *
 * Issue #138, epic #56 / E7 "Habit". `docs/specs/habit-streaks.md` §4.6 and §8.
 *
 * =============================================================================
 * THIS SUPERSEDES `components/journey/DailyGoalRing.tsx`, WHICH IS DELETED
 * =============================================================================
 *
 * That component was E1's designed EMPTY STATE and its header said so in
 * capitals: no numeral anywhere, no `progressbar` role, and no props, because
 * `GET /api/journey/home` sent `dailyGoal.tracked: false` and carried no
 * measured field at all. `journey-shell.md` §10 spells out why a "0 of 5
 * minutes" was forbidden then: it was indistinguishable, to the person
 * reading it, from a learner who genuinely practised for zero minutes —
 * technically accurate and functionally a lie.
 *
 * E7 is what that placeholder was waiting for, and it removes the reason for
 * the prohibition rather than working around it: `daily_activity` now measures
 * the day, so a `0` here is a real, measured zero — the honest answer to "how
 * much have I practised today", not a stand-in for an unknown one. That file's
 * own header named this moment ("When E7 lands session tracking it adds the
 * measured field... and gives this component the props to draw it").
 *
 * It was superseded rather than extended because almost every line of its
 * documented identity inverts here — it must now take data, print a numeral
 * and claim the `progressbar` role it was written to refuse — and because the
 * ring is no longer a journey widget standing alone: it is one part of the
 * consistency surface (`ConsistencyCard`) that the streak and the freeze
 * budget also belong to. Two files both calling themselves the goal ring is
 * exactly what issue #138 forbids, so there is only this one.
 *
 * =============================================================================
 * WHAT IT KEEPS FROM THE PLACEHOLDER
 * =============================================================================
 *
 * The DASHED outline for a day with nothing measured on it. A broken ring
 * reads as "nothing here yet" where a solid one reads as "complete", and that
 * drawing was right about the zero state before E7 and is still right after
 * it. Theme tokens (`palette.divider`, `palette.primary`, `palette.success`)
 * rather than literal colours, so both themes are correct from one definition.
 *
 * =============================================================================
 * CONSISTENCY, NEVER READINESS
 * =============================================================================
 *
 * §8: "The word for what the ring measures is `consistency`, never
 * `readiness`." This ring answers "am I doing the work today" — it makes no
 * claim about preparedness, and `aria-valuetext` says minutes, never a
 * percentage of anything ready.
 */

import { Box, Typography, useMediaQuery, useTheme } from '@mui/material';

import { formatMinutes, wholeMinutes } from './minutes';

const SIZE = 96;
const RADIUS = 40;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface GoalRingProps {
  /** `today.practiceSeconds`, exactly as the server measured it. */
  practiceSeconds: number;
  /** `dailyGoalMinutes` — the learner's own goal, from their profile. */
  goalMinutes: number;
  /** `today.goalMet` — the SERVER's monotonic flag, never recomputed here. */
  goalMet: boolean;
}

export function GoalRing({ practiceSeconds, goalMinutes, goalMet }: GoalRingProps) {
  const theme = useTheme();
  // Motion is opt-out at the OS level, and this is the ring's only animation.
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const minutes = wholeMinutes(practiceSeconds);
  const goalSeconds = Math.max(goalMinutes, 0) * 60;
  // Clamped for the DRAWING only. `goalMet` above is the server's fact; this
  // fraction never decides whether the goal was met, it only decides how much
  // of a circle to paint.
  const fraction =
    goalSeconds > 0 ? Math.min(Math.max(practiceSeconds / goalSeconds, 0), 1) : goalMet ? 1 : 0;

  const nothingYet = practiceSeconds <= 0;
  const arcColor = goalMet ? theme.palette.success.main : theme.palette.primary.main;

  return (
    <Box
      // The whole ring is ONE progressbar to assistive technology, with a
      // value it can honestly supply — unlike E1's placeholder, which claimed
      // no role precisely because it had no value.
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={goalMinutes}
      aria-valuenow={minutes}
      aria-valuetext={`${formatMinutes(practiceSeconds)} of ${goalMinutes} today`}
      data-testid="goal-ring"
      sx={{ position: 'relative', flexShrink: 0, width: SIZE, height: SIZE }}
    >
      <Box
        component="svg"
        aria-hidden
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        sx={{ width: SIZE, height: SIZE, display: 'block' }}
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={theme.palette.divider}
          strokeWidth="8"
          // Dashed while nothing is measured — the placeholder's own drawing,
          // kept because it was right about an empty day.
          strokeDasharray={nothingYet ? '4 5' : undefined}
        />
        {fraction > 0 && (
          <circle
            data-testid="goal-ring-progress"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={arcColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            // An inline style, not `sx`: the suppression has to be legible in
            // the DOM so a test can assert it, and this is the one property
            // `prefers-reduced-motion` governs here.
            style={{
              transition: prefersReducedMotion ? 'none' : 'stroke-dashoffset 700ms ease-out',
            }}
            data-motion={prefersReducedMotion ? 'reduced' : 'animated'}
          />
        )}
      </Box>

      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography
          component="p"
          aria-hidden
          variant="h6"
          sx={{ fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}
        >
          {minutes}
        </Typography>
        <Typography component="p" aria-hidden variant="caption" color="text.secondary">
          {`of ${goalMinutes} min`}
        </Typography>
      </Box>
    </Box>
  );
}

export default GoalRing;
