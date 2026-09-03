/**
 * The streak, and the freeze budget stated as protection.
 *
 * Issue #138, epic #56 / E7 "Habit". `docs/specs/habit-streaks.md` §4.1
 * (what `current` and `longest` mean), §4.5 (the freeze product rule) and §8
 * (the vocabulary boundary).
 *
 * =============================================================================
 * FREEZES ARE PROTECTION THE LEARNER ALREADY HAS — NEVER A COUNTDOWN
 * =============================================================================
 *
 * §4.5 states this as a product rule, not a styling preference: the UI says
 * "You have 2 freezes" the way a benefit is stated, never "Only 2 freezes
 * left!" the way a countdown is. So this component renders the freeze line
 * ONLY when the learner holds at least one, and phrases it as cover they
 * already have. A learner holding none is told nothing about freezes at all —
 * "0 freezes left" is a scarcity counter with the numeral removed, and the
 * absence of protection is not a fact this surface owes anybody in the middle
 * of encouraging them. `VISION.md`: "We should never create pressure, shame,
 * fear, or unhealthy compulsion to increase engagement metrics."
 *
 * `max` is rendered nowhere for the same reason: "2 of 2" invites the reading
 * "and then they are gone".
 *
 * =============================================================================
 * NEITHER NUMBER IS DERIVED HERE
 * =============================================================================
 *
 * `current` and `longest` arrive computed by `streak-engine.ts` (§4.2) and are
 * printed as they arrive. A browser-side recount over `recentDays` would be a
 * second implementation of the anchor rule (§4.1's "ending today OR
 * yesterday"), and the first one to disagree with the server at 2pm on a day
 * the learner has not practised yet — the exact case that rule exists for.
 *
 * =============================================================================
 * ZERO IS AN INVITATION, NOT A DEFICIT
 * =============================================================================
 *
 * A learner with no streak reads "No streak yet" and one sentence telling them
 * how one begins. They are never shown what they have failed to accumulate.
 */

import { Box, Typography } from '@mui/material';

export interface StreakBadgeProps {
  /** `streak.current` — consecutive qualifying local days, from the server. */
  current: number;
  /** `streak.longest` — the longest run anywhere in this learner's history. */
  longest: number;
  /** `freezes.remaining` — held right now, after this read's settlement. */
  freezesRemaining: number;
}

export function StreakBadge({ current, longest, freezesRemaining }: StreakBadgeProps) {
  const hasStreak = current > 0;

  return (
    <Box data-testid="streak">
      {hasStreak ? (
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography
            component="p"
            variant="h4"
            sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
          >
            {current}
          </Typography>
          <Typography component="p" variant="body1">
            {current === 1 ? 'day in a row' : 'days in a row'}
          </Typography>
        </Box>
      ) : (
        <>
          <Typography component="p" variant="h6" sx={{ fontWeight: 600 }}>
            No streak yet
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Practise today and your streak starts today.
          </Typography>
        </>
      )}

      {longest > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {`Your longest run so far is ${longest} ${longest === 1 ? 'day' : 'days'}.`}
        </Typography>
      )}

      {freezesRemaining > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {hasStreak
            ? `Your streak is protected today — you have ${freezesRemaining} streak ${
                freezesRemaining === 1 ? 'freeze' : 'freezes'
              } in hand.`
            : `You have ${freezesRemaining} streak ${
                freezesRemaining === 1 ? 'freeze' : 'freezes'
              } in hand for a day you cannot practise.`}
        </Typography>
      )}
    </Box>
  );
}

export default StreakBadge;
