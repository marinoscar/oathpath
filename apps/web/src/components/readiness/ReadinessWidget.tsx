/**
 * The compact readiness card on Home — "am I becoming more ready?", answered
 * in one glance, without repeating `/progress`'s full dial and breakdown.
 *
 * Issue #142, epic #55 / E6 "Readiness and Progress". Mirrors
 * `components/journey/NextUpCard.tsx`'s shape: a `Card`/`CardContent`
 * section with its own `h2`, a `RouterLink`-backed button rather than an
 * `onClick`, and every word of server-written copy (`topRecommendation`)
 * rendered VERBATIM — no local `switch` re-templating it.
 *
 * =============================================================================
 * THE TREND NEVER FABRICATES A DIRECTION FROM ONE DATA POINT
 * =============================================================================
 *
 * `previousScore` is `number | null` — `null` for "no prior snapshot", a
 * real possibility for a learner on their first day. This component renders
 * NOTHING for the trend in that case rather than inventing "no change" or
 * treating `undefined` as `0`, the identical honesty rule §10 already states
 * elsewhere in this codebase for a countdown or a goal ring with nothing to
 * report. `readinessTrendText` — shared with `/progress`'s own trend
 * sentence — is the single place that logic lives, so the two surfaces can
 * never describe the same two numbers differently.
 *
 * =============================================================================
 * THE CAP HINT IS SHORTENED, NEVER SOFTENED
 * =============================================================================
 *
 * `docs/specs/readiness-model.md` §3's fixed cap sentence is long — right for
 * `/progress`'s own prominent notice, too much for a compact Home card
 * competing with `NextUpCard`, the interview countdown and the goal ring for
 * the same screen. This component's own short phrase names the same fact
 * (limited interview practice) and points at `/progress`, where the fixed
 * sentence renders in full — it never claims to BE that sentence, and it
 * never softens what it says ("may want to" / "consider") the way
 * `TrustFooter`'s own header already warns against for the trust copy.
 */

import { Box, Button, Card, CardContent, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

import type { ReadinessSnapshotResponse } from '../../types';
import { readinessTrendText } from '../progress/readiness';

export interface ReadinessWidgetProps {
  readiness: ReadinessSnapshotResponse;
  /**
   * The most recent PRIOR snapshot's score — `null` when none exists yet.
   * Callers resolve this with `findPreviousReadinessScore`
   * (`components/progress/readiness.ts`) over `useReadinessHistory`'s own
   * result, the identical helper `/progress`'s trend section uses.
   */
  previousScore: number | null;
  /** Ties the card to its heading for assistive technology. */
  headingId: string;
}

export function ReadinessWidget({ readiness, previousScore, headingId }: ReadinessWidgetProps) {
  const trend = readinessTrendText(readiness.score, previousScore);

  return (
    <Card
      component="section"
      aria-labelledby={headingId}
      variant="outlined"
      sx={{ mb: { xs: 3, sm: 4 } }}
    >
      <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography
          id={headingId}
          component="h2"
          variant="overline"
          color="text.secondary"
          sx={{ display: 'block', letterSpacing: '0.08em' }}
        >
          Readiness
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mt: 1 }}>
          <Typography component="p" variant="h4" sx={{ fontWeight: 700 }}>
            {readiness.score}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            / 100
          </Typography>
        </Box>

        {trend && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {trend}
          </Typography>
        )}

        {readiness.capReason === 'typed_only' && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: '48ch' }}>
            Limited interview practice — see Progress for what to do next.
          </Typography>
        )}

        <Button
          component={RouterLink}
          to="/progress"
          variant="outlined"
          size="small"
          sx={{ mt: 2 }}
        >
          See your Progress
        </Button>
      </CardContent>
    </Card>
  );
}

export default ReadinessWidget;
