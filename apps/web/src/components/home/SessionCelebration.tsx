/**
 * The session-end celebration — one earned sentence, at the top of the
 * practice debrief.
 *
 * Issue #138, epic #56 / E7 "Habit". `docs/specs/habit-streaks.md` §8.
 *
 * =============================================================================
 * IT RENDERS. IT DOES NOT DECIDE.
 * =============================================================================
 *
 * Every word comes from `selectCelebrationCopy` (`celebration-copy.ts`), a
 * pure function unit-tested against a table. A `switch` here would be a second
 * place the rule lives, and the first one to disagree with the tested one.
 * When that function returns `null` — a session that answered nothing, a day
 * with no measured time, an engagement summary that could not be loaded — the
 * caller renders NOTHING. §8's standard is that no sentence beats a sentence
 * that would have fitted anybody.
 *
 * =============================================================================
 * MOTION IS OPT-OUT
 * =============================================================================
 *
 * §8: "Session-end celebration motion respects `prefers-reduced-motion`... a
 * learner with the media query set sees the identical specific, earned copy
 * with no confetti, no ring animation, and no motion at all standing in for
 * it." The copy is the celebration; the fade is decoration on top of it, and
 * decoration is exactly what that preference switches off. Under the
 * preference the timeout is zero — the panel is simply there — and
 * `data-motion` says so in the DOM so the suppression is assertable.
 *
 * It is a `role="status"` with `aria-live="polite"`: the celebration appears
 * after the page's own data settles, so a screen-reader user who is already
 * reading the summary hears it announced rather than having to go looking.
 */

import { Fade, Paper, Typography, useMediaQuery } from '@mui/material';

import type { CelebrationCopy } from './celebration-copy';

export interface SessionCelebrationProps {
  copy: CelebrationCopy;
}

export function SessionCelebration({ copy }: SessionCelebrationProps) {
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  return (
    <Fade in appear timeout={prefersReducedMotion ? 0 : 400}>
      <Paper
        variant="outlined"
        role="status"
        aria-live="polite"
        data-testid="session-celebration"
        data-celebration-kind={copy.kind}
        data-motion={prefersReducedMotion ? 'reduced' : 'animated'}
        sx={{
          p: { xs: 2, sm: 3 },
          mb: 3,
          // A token, never a literal colour, so both themes are right from
          // one definition.
          borderColor: 'success.main',
        }}
      >
        <Typography component="p" variant="h6" sx={{ fontWeight: 600 }}>
          {copy.headline}
        </Typography>
        {copy.detail && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {copy.detail}
          </Typography>
        )}
      </Paper>
    </Fade>
  );
}

export default SessionCelebration;
