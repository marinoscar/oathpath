/**
 * What this interview did to the learner's readiness.
 *
 * Issue #145, epic #57 / E8.
 *
 * =============================================================================
 * EVERY NUMBER IS THE SERVER'S. THE WEB NEVER COMPUTES A SCORE.
 * =============================================================================
 *
 * `docs/specs/mock-interview.md` §11: "the web renders these numbers; it never
 * computes a pass rule or a score of its own". `POST /api/interviews/:id/complete`
 * triggered a readiness recompute (`ReadinessService`, `readiness-model.md` §7's
 * synchronous trigger extended to a third call site by this epic) and froze its
 * result into `mock_interviews.result`, so this component is reading a
 * measurement rather than taking one.
 *
 * Concretely, and each of these is a thing this file could plausibly have done
 * and does not:
 *
 *   * `delta` is NOT `score - previousScore`. The server computed it against
 *     the immediately-prior snapshot; two numbers this component happens to
 *     hold are not guaranteed to be those two snapshots, and a browser
 *     subtracting them would silently produce a different answer the day they
 *     are not.
 *   * `capMessage` is NOT written here. It is
 *     `readiness/top-recommendation.ts`'s `cappedRecommendation()` sentence,
 *     quoted from `PRD.md` by way of `readiness-model.md` §3, and rendered
 *     VERBATIM — §11 asks for exactly that word. A second literal of the
 *     product's own words in this bundle is a second place they can drift.
 *   * `interviewComponent.value` is NOT rescaled into a percentage or a bar.
 *     It is the `interview` component's own value on its own 0-to-1 scale
 *     (`min(mockInterviewsPassed / 2, 1)`, `readiness-model.md` §2.8), and it
 *     is printed as it arrived, against the scale it is on.
 *
 * =============================================================================
 * A FIRST SNAPSHOT HAS NO CHANGE, AND SAYS NOTHING RATHER THAN "+0"
 * =============================================================================
 *
 * `previousScore` and `delta` are both null on a learner's very first readiness
 * snapshot — there is no earlier score to compare against, and "+0" or "no
 * change" would claim a measurement nobody made. `readinessChangeSentence`
 * returns null for that case and this renders nothing, the same honest-absence
 * posture `ProgressPage` takes for its trend line with fewer than two points.
 *
 * =============================================================================
 * THE CAP IS AN EXPLANATION, NOT A WARNING
 * =============================================================================
 *
 * `capReason: 'typed_only'` means the score has a structural ceiling because
 * every piece of evidence behind it was typed — and §13 makes this screen the
 * one most likely to LIFT it: the moment a learner passes their first mock
 * interview, `interview.value` moves off 0, `capReason` becomes null and the
 * ceiling stops applying. So it renders as `info` and as prose, never as an
 * error or a caution: nothing has gone wrong, and the sentence the server sent
 * already explains what would change it.
 */

import { Alert, Box, Paper, Stack, Typography } from '@mui/material';

import type { InterviewReadinessSummary } from '../../types';
import { capLiftedSentence, readinessChangeSentence } from './debriefCopy';

export interface ReadinessMovementProps {
  readiness: InterviewReadinessSummary;
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

export function ReadinessMovement({ readiness, headingId }: ReadinessMovementProps) {
  const change = readinessChangeSentence(
    readiness.delta,
    readiness.previousScore,
  );
  // Exactly one of these two is ever a string — `capLiftedSentence` returns
  // null while the cap applies, and `capMessage` is null once it has lifted —
  // so the screen can never carry both readings of the same boundary.
  const lifted = capLiftedSentence(readiness);

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
        Readiness
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mt: 1 }}>
        <Typography
          component="p"
          variant="h4"
          sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
        >
          {readiness.score}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          / 100
        </Typography>
      </Box>

      {/* Omitted entirely, rather than rendered as "no change", when the server
          sent no previous score to compare against. */}
      {change && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {change}
        </Typography>
      )}

      <Stack spacing={0.5} sx={{ mt: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Mock interviews passed: {readiness.interviewComponent.evidenceCount}
        </Typography>
        {/* Printed on its own scale, with the scale named. `0.5 of 1` is
            honest about what the number is; `50%` would be this component
            rescaling a measurement it did not take. */}
        <Typography variant="body2" color="text.secondary">
          Interview component: {readiness.interviewComponent.value} of 1
        </Typography>
        {/* THE OTHER HALF OF WHY A SPOKEN REHEARSAL WEIGHS MORE (issue #160,
            `realtime-interview.md` §8). `interview` above counts a pass
            whatever the transport; this counts distinct civics questions
            answered correctly ALOUD, so a realtime interview moves both and a
            typed one moves only the first. Until this line existed, the
            component that actually distinguishes them was the one the debrief
            did not show — and `PRD.md` requires the score to be explainable.
            Printed on its own scale for the same reason as its sibling. */}
        <Typography variant="body2" color="text.secondary">
          Questions answered aloud: {readiness.spokenComponent.evidenceCount}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Spoken component: {readiness.spokenComponent.value} of 1
        </Typography>
      </Stack>

      {/* VERBATIM, and only when the server says the cap applies. A
          `role="status"` rather than MUI's default `"alert"`: this is standing
          content explaining a score, not a transient error to interrupt a
          screen-reader user with — the same override `ProgressPage` makes for
          its own recommendation card. */}
      {readiness.capReason !== null && readiness.capMessage && (
        <Alert severity="info" icon={false} role="status" sx={{ mt: 2 }}>
          <Typography variant="body2">{readiness.capMessage}</Typography>
        </Alert>
      )}

      {/* THE OTHER SIDE OF THE SAME BOUNDARY (issue #160). Before this, a
          learner who had just passed their first mock interview watched the
          capped sentence vanish and nothing take its place — which reads as the
          product losing interest rather than as a ceiling lifting. The sentence
          names the two evidence counts the cap itself reads and no others; see
          `capLiftedSentence` on why it is assembled here rather than sent, and
          on why `english` is not one of them. */}
      {lifted && (
        <Alert severity="info" icon={false} role="status" sx={{ mt: 2 }}>
          <Typography variant="body2">{lifted}</Typography>
        </Alert>
      )}
    </Paper>
  );
}

export default ReadinessMovement;
