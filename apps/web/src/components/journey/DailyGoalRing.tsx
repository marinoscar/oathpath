/**
 * The daily-goal ring — a designed EMPTY STATE, not a progress indicator.
 *
 * Issue #74, epic #50, `docs/specs/journey-shell.md` §9.2 and §10, drawn from
 * the dashed grey ring in `journey-shell/home-{360,600}.svg`.
 *
 * =============================================================================
 * NO NUMERAL. NOT ONE, ANYWHERE IN THIS COMPONENT.
 * =============================================================================
 *
 * §9.2 is unusually blunt about this and §10 explains why: a ring reading "0 of
 * 5 minutes" because nothing is tracked yet is INDISTINGUISHABLE, to the person
 * looking at it, from a learner who genuinely practised for zero minutes today.
 * The zero is technically accurate and functionally a lie. So the ring shows
 * two lines of copy and no figure at all:
 *
 *   Label:            "Not tracked yet"
 *   Supporting line:  "Your daily goal will show here once practice sessions
 *                      exist."
 *
 * =============================================================================
 * WHY THIS COMPONENT TAKES NO DATA
 * =============================================================================
 *
 * `GET /api/journey/home` sends `dailyGoal: { minutes, tracked }`, and this
 * component reads NEITHER. Both omissions are decisions, not oversights:
 *
 *   * **`tracked` is `false` for the whole of E1**, and the payload carries no
 *     measured field to draw when it flips — the DTO's own comment says a
 *     `minutesToday` added before E7 has picked the branch §10 rules out. A
 *     `tracked ? … : …` here would therefore be a conditional with one real
 *     arm and one arm that invents its own contents, which is worse than no
 *     conditional: it would look wired up while being incapable of drawing a
 *     ring.
 *   * **`minutes` is a real fact the learner chose**, so printing it would not
 *     be fabrication — but a "15" beside a ring is read as a MEASUREMENT
 *     rather than as a setting, and §9.2's "no numeral, ever" is written to
 *     close exactly that gap and not only the obvious `0/5` one. The goal is
 *     visible where the learner set it, on `/settings/journey`.
 *
 * When E7 lands session tracking it adds the measured field to the payload and
 * gives this component the props to draw it, keeping this empty state for any
 * learner with no sessions yet. Until then, a prop this file could not honestly
 * use would be plumbing that implies data exists.
 *
 * The circle itself is an inline SVG with `aria-hidden`, because it depicts
 * nothing: there is no value, so there is no `progressbar` role to claim and no
 * `aria-valuenow` that could honestly be filled in. The two lines of text are
 * the whole of the accessible content.
 */

import { Box, Typography, useTheme } from '@mui/material';

/** §9.2's copy. The mockups render the label without terminal punctuation. */
const NOT_TRACKED_LABEL = 'Not tracked yet';
const NOT_TRACKED_SUPPORT =
  'Your daily goal will show here once practice sessions exist.';

export interface DailyGoalRingProps {
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

export function DailyGoalRing({ headingId }: DailyGoalRingProps) {
  const theme = useTheme();

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      // A stable handle for the test that asserts NO DIGIT appears anywhere in
      // this region — the assertion that keeps §9.2 enforced rather than
      // remembered.
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
          // Row at every width, including 360px: the ring is 96px and the
          // sentence beside it wraps to three short lines, which is exactly
          // what the 360 mockup shows. Nothing here is breakpoint-gated, so
          // none of `CLAUDE.md`'s five coupled `sm` gates is touched.
          flexDirection: 'row',
          alignItems: 'center',
          gap: { xs: 2, sm: 3 },
          mt: 1.5,
        }}
      >
        <Box sx={{ position: 'relative', flexShrink: 0, width: 96, height: 96 }}>
          {/* DASHED, not solid, and that is the point of the drawing: a broken
              outline reads as "nothing measured here" where a full ring reads
              as "complete". `theme.palette.divider` rather than a hex value, so
              it is correct in both themes from one definition. */}
          <Box
            component="svg"
            aria-hidden
            viewBox="0 0 96 96"
            sx={{ width: 96, height: 96, display: 'block' }}
          >
            <circle
              cx="48"
              cy="48"
              r="40"
              fill="none"
              stroke={theme.palette.divider}
              strokeWidth="8"
              strokeDasharray="4 5"
            />
          </Box>
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              px: 1,
            }}
          >
            <Typography
              component="p"
              variant="caption"
              color="text.secondary"
              align="center"
              sx={{ lineHeight: 1.2, fontWeight: 600 }}
            >
              {NOT_TRACKED_LABEL}
            </Typography>
          </Box>
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '40ch' }}>
          {NOT_TRACKED_SUPPORT}
        </Typography>
      </Box>
    </Box>
  );
}

export default DailyGoalRing;
