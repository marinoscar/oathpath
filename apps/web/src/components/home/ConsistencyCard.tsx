/**
 * Home's consistency surface — the goal ring, today's measured minutes, the
 * streak and the freeze budget, in one section.
 *
 * Issue #138, epic #56 / E7 "Habit". `docs/specs/habit-streaks.md` §4.6 (the
 * one read this renders) and §8 (the copy rules).
 *
 * =============================================================================
 * ONE SECTION, ONE HEADING, ONE QUESTION
 * =============================================================================
 *
 * The ring and the streak are not two topics that happen to sit together: they
 * are the same question at two time scales — "am I doing the work today" and
 * "have I been doing it". Splitting them into two `h2` regions would ask a
 * screen-reader user to walk two headings to assemble one answer, and would
 * put the freeze line (which is about the streak) under whichever of the two
 * it was arbitrarily filed beneath. The section keeps E1's heading, `Daily
 * goal`, and its `data-testid` handle.
 *
 * =============================================================================
 * CONSISTENCY IS THE WORD. READINESS IS NOT.
 * =============================================================================
 *
 * §8: "The word for what the ring measures is `consistency`, never `readiness`
 * or `progress-toward-readiness`." Home already carries a separate readiness
 * widget (#142) answering the other of `PRD.md`'s two questions; this section
 * must never borrow its vocabulary, and there is a test over every component
 * in this directory asserting none of it appears.
 *
 * =============================================================================
 * NOTHING HERE IS COMPUTED IN THE BROWSER
 * =============================================================================
 *
 * `goalMet` is the server's monotonic flag (§2.3), `current`/`longest` come
 * from the pure streak engine (§4.2), and `practiceSeconds` is measured
 * server-side from `Clock`-stamped timestamps precisely because a
 * client-supplied duration would be unfalsifiable (§2.3). This component reads
 * fields and formats minutes; it decides nothing.
 */

import { Box, Typography } from '@mui/material';

import type { EngagementSummary } from '../../types';
import { GoalRing } from './GoalRing';
import { StreakBadge } from './StreakBadge';
import { formatMinutes } from './minutes';

export interface ConsistencyCardProps {
  engagement: EngagementSummary;
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

/**
 * Today's one sentence, derived from the day's own measurement.
 *
 * The zero case is an INVITATION, not a deficit: it names what a session
 * costs, borrowing §5.1's own "five minutes is enough" framing with the
 * learner's real goal in place of the example's five. It never names what has
 * not happened.
 */
export function todaySentence(engagement: EngagementSummary): string {
  const { today, dailyGoalMinutes } = engagement;

  if (today.goalMet) {
    return `That is ${formatMinutes(today.practiceSeconds)} today — your goal.`;
  }
  if (today.practiceSeconds > 0) {
    return `${formatMinutes(today.practiceSeconds)} today, towards your ${dailyGoalMinutes}-minute goal.`;
  }
  return `${dailyGoalMinutes} ${
    dailyGoalMinutes === 1 ? 'minute' : 'minutes'
  } is enough today — a quick session covers your goal.`;
}

export function ConsistencyCard({ engagement, headingId }: ConsistencyCardProps) {
  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      // The handle E1's placeholder shipped, kept so the surface stays
      // findable by the tests that have always asserted against it.
      data-testid="daily-goal"
      sx={{ mb: { xs: 3, sm: 4 } }}
    >
      <Typography
        id={headingId}
        component="h2"
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', letterSpacing: '0.08em' }}
      >
        Daily goal
      </Typography>

      <Box
        sx={{
          display: 'flex',
          // Row at every width, including 360px — the ring is 96px and the
          // sentences beside it wrap. Nothing here is breakpoint-gated, so
          // none of `CLAUDE.md`'s five coupled `sm` gates is touched.
          flexDirection: 'row',
          alignItems: 'center',
          gap: { xs: 2, sm: 3 },
          mt: 1.5,
        }}
      >
        <GoalRing
          practiceSeconds={engagement.today.practiceSeconds}
          goalMinutes={engagement.dailyGoalMinutes}
          goalMet={engagement.today.goalMet}
        />

        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '40ch' }}>
            {todaySentence(engagement)}
          </Typography>

          <Box sx={{ mt: 1.5 }}>
            <StreakBadge
              current={engagement.streak.current}
              longest={engagement.streak.longest}
              freezesRemaining={engagement.freezes.remaining}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

export default ConsistencyCard;
