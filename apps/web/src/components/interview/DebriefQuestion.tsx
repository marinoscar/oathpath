/**
 * One civics question as it was actually asked and graded.
 *
 * Issue #145, epic #57 / E8. The debrief is the FIRST place in this whole
 * feature where a verdict appears — `docs/specs/mock-interview.md` §10 keeps
 * every turn response, every progress count and `GET /api/interviews/:id`'s own
 * `debrief: null` free of one until the interview is completed — so this is the
 * component that finally renders one.
 *
 * =============================================================================
 * IT REUSES THE PRACTICE VOCABULARY ON PURPOSE, WHERE `InterviewPage` REFUSES IT
 * =============================================================================
 *
 * `outcomeDisplay` from `components/practice/outcome.ts` is imported here and
 * deliberately never imported by `InterviewPage.tsx`, whose own header names
 * that import as the exact way a tick could reach the live screen. The
 * distinction is not stylistic:
 *
 *   * DURING the interview, "Correct" / "Not a match" is coaching language the
 *     real event never provides, so the live screen must not be able to reach
 *     it (a test asserts the absence of every one of those words there).
 *   * AFTER it, the same words are the honest report §11 asks for, and having
 *     ONE file own how a recorded outcome is worded and coloured is what keeps
 *     the practice summary and this debrief from disagreeing about what
 *     `skipped` is called.
 *
 * `outcomeDisplay` also falls back rather than indexing a `Record` and hoping,
 * which matters here for a reason specific to interviews: `partial` is
 * genuinely reachable in an interview's outcomes (the AI grader runs on a
 * deterministic miss, `ai-evaluation.md`'s ladder), so this list meets values
 * the drill screens rarely produce.
 *
 * =============================================================================
 * THE ACCEPTED ANSWERS ARE FROZEN, AND THAT IS WHY THIS DOES NOT REUSE
 * `AcceptedAnswers`
 * =============================================================================
 *
 * `acceptedAnswers` on a debrief question is a `string[]` taken from the
 * attempt's own `answer_snapshot` — the answers as they stood when that answer
 * was graded, never a live re-query (§11, and `practice-sessions.md` §6's
 * reason this product inherits everywhere: a `national`- or `state`-scope
 * answer changes by design, so re-resolving at read time would tell a learner
 * who correctly named the Speaker of the House in June that they were wrong,
 * because someone else holds the office now).
 *
 * `components/practice/AcceptedAnswers` renders a `PracticeSnapshotAnswer[]` —
 * objects with ids, a resolution state and a state code — and the API sends
 * this shape as plain strings. Adapting one to the other would mean inventing
 * ids for display, so this renders the strings directly and keeps the one thing
 * that panel's copy is load-bearing for: **the "any one of these is accepted"
 * label**, which several civics questions genuinely need. A learner reading an
 * unlabelled list of five accepted answers would reasonably conclude they had
 * to produce all five.
 *
 * `acceptedAnswers` survives with retention off (§8.2): what is withheld when a
 * learner declines to keep their transcript is their own words, never the
 * evidence of what happened. There is nowhere on this card for the learner's
 * response text to appear, which is why it can be rendered identically for a
 * retained and a non-retained interview.
 */

import { Box, Chip, Paper, Stack, Typography } from '@mui/material';

import type { InterviewDebriefQuestion } from '../../types';
import { outcomeDisplay } from '../practice/outcome';

export interface DebriefQuestionProps {
  question: InterviewDebriefQuestion;
}

export function DebriefQuestion({ question }: DebriefQuestionProps) {
  const verdict = outcomeDisplay(question.outcome);
  const many = question.acceptedAnswers.length > 1;

  return (
    <Paper component="li" variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          Question {question.number}
        </Typography>
        {/* Text as well as colour — a red chip and a green chip are the same
            chip to a learner who cannot tell them apart. */}
        <Chip label={verdict.label} color={verdict.color} size="small" />
        <Typography variant="body2" color="text.secondary">
          {question.categoryName}
        </Typography>
      </Stack>

      {/* `h3` under the page's `h2` section heading — the page owns the single
          `h1`. The size is design; the level is semantics. */}
      <Typography variant="h6" component="h3" sx={{ mt: 0.5, fontWeight: 600 }}>
        {question.prompt}
      </Typography>

      <Box sx={{ mt: 2 }}>
        <Typography
          variant="overline"
          component="h4"
          color="text.secondary"
          sx={{ display: 'block', mb: 0.5 }}
        >
          {many ? 'Accepted answers' : 'Accepted answer'}
        </Typography>

        {question.acceptedAnswers.length === 0 ? (
          // Honest rather than blank. An empty snapshot means no answer was
          // recorded for this question at the moment it was graded, which is a
          // content gap and not something the learner did.
          <Typography variant="body2" color="text.secondary">
            No answer was recorded for this question.
          </Typography>
        ) : many ? (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Any one of these is accepted.
            </Typography>
            <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 3 }}>
              {question.acceptedAnswers.map((answer) => (
                <Typography component="li" variant="body1" key={answer}>
                  {answer}
                </Typography>
              ))}
            </Stack>
          </>
        ) : (
          <Typography variant="body1" component="p" sx={{ fontWeight: 600 }}>
            {question.acceptedAnswers[0]}
          </Typography>
        )}
      </Box>
    </Paper>
  );
}

export default DebriefQuestion;
