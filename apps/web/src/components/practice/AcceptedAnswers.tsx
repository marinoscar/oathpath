/**
 * What the learner was graded AGAINST — the answers, after the attempt.
 *
 * Issue #79, epic #52. Rendered by the session screen's feedback panel and by
 * every row of the summary's per-question list, from the same frozen
 * `answerSnapshot` in both places.
 *
 * =============================================================================
 * WHY THIS IS NOT `components/civics/AnswerPanel`
 * =============================================================================
 *
 * The two look alike on screen and are answering different questions, and
 * collapsing them would lose the distinction that makes a debrief honest a year
 * later:
 *
 *   * `AnswerPanel` renders a `CivicsQuestionDetail` — the answers as they are
 *     **now**, resolved live for this learner. That is what `/learn` is for.
 *   * This renders a `PracticeAnswerSnapshot` — the answers **as they stood at
 *     the instant this attempt was graded**, frozen and never re-resolved
 *     (`practice-sessions.md` §6). A dynamic answer changes by design
 *     (`civics-content.md` §4: the Speaker of the House), and a debrief that
 *     re-resolved it would tell a learner they used to be wrong about something
 *     they still know.
 *
 * Sharing one component would mean giving it a "which era of the truth is
 * this?" prop, and the day somebody defaulted that prop wrong, the summary
 * screen would start quietly re-grading history. Two components, two data
 * shapes, one shared `StateRequiredNotice` for the one state that genuinely is
 * identical.
 *
 * =============================================================================
 * THE THREE STATES, AND WHY NONE OF THEM IS AN ERROR
 * =============================================================================
 *
 *  1. `answerResolution === 'state_required'` → `StateRequiredNotice`, and NO
 *     answer text of any kind. Reused rather than re-worded: the reasoning is
 *     the acceptance criterion, not the wording.
 *  2. `answers` empty while resolved → an honest "nothing recorded". Content
 *     that has not been loaded is not a question without an answer, and
 *     inventing prose to fill the space is the same fabrication the spec
 *     rejects for a missing state.
 *  3. Otherwise → every accepted answer in the server's slot order, labelled
 *     "any one of these is accepted" the moment there is more than one.
 *
 * That label is load-bearing, exactly as it is on `/learn`: several civics
 * questions have more than one simultaneously accepted answer, and a learner
 * reading an unlabelled list of five would reasonably conclude they had to
 * produce all five.
 */

import { Alert, Box, Stack, Typography } from '@mui/material';

import type { CivicsAnswerResolution, PracticeSnapshotAnswer } from '../../types';
import { StateRequiredNotice } from '../civics/StateRequiredNotice';

export interface AcceptedAnswersProps {
  answers: PracticeSnapshotAnswer[];
  answerResolution: CivicsAnswerResolution;
  /** Set when the answers are state-specific; null for national ones. */
  resolvedForStateCode?: string | null;
  /**
   * Which heading element the "Accepted answer" label is, so the caller keeps
   * its own document outline sensible. This panel renders at two different
   * depths — inside the session screen's feedback (`h3`) and inside a summary
   * row (`h4`) — so it must never hardcode one.
   */
  headingComponent?: 'h3' | 'h4';
}

export function AcceptedAnswers({
  answers,
  answerResolution,
  resolvedForStateCode = null,
  headingComponent = 'h3',
}: AcceptedAnswersProps) {
  const many = answers.length > 1;

  return (
    <Box>
      <Typography
        variant="overline"
        component={headingComponent}
        color="text.secondary"
        sx={{ display: 'block', mb: 0.5 }}
      >
        {many ? 'Accepted answers' : 'Accepted answer'}
      </Typography>

      {answerResolution === 'state_required' ? (
        <StateRequiredNotice />
      ) : answers.length === 0 ? (
        // Polite, like every other designed absence in this app: nothing has
        // gone wrong, so nothing should interrupt a screen reader as though it
        // had.
        <Alert severity="info" role="status">
          No answer has been recorded for this question yet.
        </Alert>
      ) : (
        <>
          {many && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Any one of these is accepted.
            </Typography>
          )}

          {many ? (
            <Stack component="ul" spacing={0.5} sx={{ m: 0, pl: 3 }}>
              {answers.map((answer) => (
                <Typography component="li" variant="body1" key={answer.id}>
                  {answer.text}
                </Typography>
              ))}
            </Stack>
          ) : (
            <Typography variant="body1" component="p" sx={{ fontWeight: 600 }}>
              {answers[0].text}
            </Typography>
          )}

          {resolvedForStateCode && (
            // Shown whenever the answer IS state-specific, not only when
            // something looks off: a learner who moved and forgot to update
            // their plan was graded against somewhere they no longer live, and
            // this line is the only thing on the screen that could tell them.
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              This is the answer for {resolvedForStateCode}.
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}

export default AcceptedAnswers;
