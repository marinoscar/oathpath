/**
 * What to do next — the readiness engine's own recommendation, ending the
 * debrief.
 *
 * Issue #160, epic #60 / E11. `PRD.md` requires a readiness score to be
 * explainable AND paired with a next action; `readiness/top-recommendation.ts`
 * §8.2 is what decides that action from this learner's own weighted headroom.
 *
 * =============================================================================
 * THE SERVER WROTE THE COPY AND CHOSE THE DESTINATION
 * =============================================================================
 *
 * `title`, `reason` and `path` are rendered as they arrived. Two things follow,
 * and both are things this file could plausibly have done and does not:
 *
 *   * **It picks no action of its own.** The debrief used to end on a fixed
 *     pair of buttons — "Try another interview", "Back to Practice" — which is
 *     a recommendation the engine did not make, on the one screen where the
 *     engine has just finished working out what this learner should actually do
 *     next. Those two links are still on the page, below this card, as
 *     navigation rather than as advice.
 *   * **It does not choose the link.** `top-recommendation.ts`'s own header
 *     states the rule this inherits: A RECOMMENDATION MUST POINT AT THE
 *     DESTINATION IT NAMES. That file spent two whole epics with a card naming
 *     mock interviews and linking to the general practice page, and the fix was
 *     to move `path` next to the copy so the two are edited in the same three
 *     lines. A client that mapped `componentKey` to a route of its own would
 *     reintroduce exactly that split, one layer up.
 *
 * =============================================================================
 * THE CAPPED CASE: THE SAME SENTENCE MUST NOT APPEAR TWICE
 * =============================================================================
 *
 * When `capReason` is `'typed_only'`, `top-recommendation.ts` returns the fixed
 * cap copy as the recommendation's own `reason`, and the API sends that same
 * string as `capMessage` — deliberately, so neither field is a second literal
 * of the product's own words. `ReadinessMovement` renders it verbatim just
 * above this card, so repeating it here would show a learner the identical
 * sentence twice in two panels and read as a bug. Compared, never re-derived:
 * the `title` and the action still render, because those are not duplicated
 * anywhere.
 */

import { Button, Paper, Stack, Typography } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import { Link as RouterLink } from 'react-router-dom';

import type { InterviewReadinessSummary } from '../../types';

export interface NextStepProps {
  readiness: InterviewReadinessSummary;
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

export function NextStep({ readiness, headingId }: NextStepProps) {
  const { recommendation, capMessage } = readiness;

  // See the header: the capped recommendation's `reason` IS `capMessage`, and
  // `ReadinessMovement` has already rendered it verbatim.
  const reason =
    capMessage !== null && recommendation.reason === capMessage
      ? null
      : recommendation.reason;

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
        What to do next
      </Typography>

      <Stack spacing={1.5} sx={{ mt: 1, alignItems: 'flex-start' }}>
        {/* `h3` under the section's `h2`. The recommendation's own title, as
            the server wrote it. */}
        <Typography variant="h6" component="h3" sx={{ fontWeight: 600 }}>
          {recommendation.title}
        </Typography>

        {reason && (
          <Typography color="text.secondary" sx={{ maxWidth: '60ch' }}>
            {reason}
          </Typography>
        )}

        {/* An INVITATION, never a push — the same posture the page's own
            closing links take. No countdown, no streak, nothing a learner could
            lose: `VISION.md` forbids manufacturing pressure by name, and the
            screen read straight after a failed rehearsal is the one most
            tempting to sell urgency on. */}
        <Button
          component={RouterLink}
          to={recommendation.path}
          variant="contained"
          endIcon={<ArrowForwardIcon />}
          sx={{ alignSelf: { xs: 'stretch', sm: 'flex-start' } }}
        >
          {recommendation.title}
        </Button>
      </Stack>
    </Paper>
  );
}

export default NextStep;
