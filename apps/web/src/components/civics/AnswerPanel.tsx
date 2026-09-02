/**
 * The answer half of a civics question — shared by the detail view and the back
 * of every flashcard.
 *
 * Issue #121, epic #51. ONE COMPONENT, TWO CHROMES, the same arrangement
 * `JourneyProfileForm` has across `/setup/journey` and `/settings/journey`, for
 * the same reason: the deliverable here is the COPY and the three answer STATES
 * — resolved, `state_required`, and nothing recorded — and a second copy of
 * those is written well once and badly the second time. In particular, a forked
 * flashcard back is exactly where "just show the national answer" would
 * eventually creep in, unreviewed.
 *
 * =============================================================================
 * THE THREE STATES, AND WHY NONE OF THEM IS AN ERROR
 * =============================================================================
 *
 *  1. `answerResolution === 'state_required'` → `StateRequiredNotice`, and NO
 *     answer text of any kind. See that file; this is an acceptance criterion,
 *     not a preference.
 *  2. `answers` empty while resolved → an honest "nothing recorded yet". This
 *     is content that has not been loaded, not a question without an answer,
 *     and inventing prose to fill the space would be the same fabrication the
 *     spec rejects for a missing state.
 *  3. Otherwise → every currently accepted answer, in the server's slot order,
 *     with the freshness claim under it.
 *
 * =============================================================================
 * "ANY ONE OF THESE IS ACCEPTED" IS LOAD-BEARING, NOT DECORATION
 * =============================================================================
 *
 * Several civics questions have MORE THAN ONE simultaneously accepted answer —
 * "Name one branch or part of the government" has three, "What is one right in
 * the First Amendment?" has five. A learner reading an unlabelled list of five
 * would reasonably conclude they must produce all five. So the list is labelled
 * the moment there is more than one item, and never when there is exactly one
 * (where the same sentence would imply an alternative that does not exist).
 *
 * =============================================================================
 * NO SCORE, NO JUDGEMENT, NOWHERE IN THIS FILE
 * =============================================================================
 *
 * `/learn` is `VISION.md`'s "See it → Understand it", deliberately BEFORE any
 * recall. There is no control here asking whether the learner got it, no tally,
 * and no scheduling hook — those are E3–E5 and belong on a screen a learner has
 * been prepared for. A "did you know it?" pair of buttons added to this panel
 * would turn every reading pass into an unannounced test.
 */

import { Box, Alert, Stack, Typography } from '@mui/material';

import type { CivicsQuestionDetail } from '../../types';
import { StateRequiredNotice } from './StateRequiredNotice';
import { formatVerifiedAt } from './verifiedAt';

export interface AnswerPanelProps {
  question: CivicsQuestionDetail;
  /**
   * The learner's state as a NAME, resolved by the caller from the state list
   * `LearnerProfileContext` already holds. Falls back to the two-letter code:
   * `resolvedForStateCode` is the fact, and the name is only a nicety.
   */
  stateName?: string | null;
  /**
   * Which heading element "Answer" is, so the caller can keep the document
   * outline sensible under its own headings. Never a bare `h3` here, because
   * this panel is rendered at two different depths.
   */
  headingComponent?: 'h3' | 'h4';
  /**
   * Show each answer's citation.
   *
   * True on the detail view, where `VISION.md`'s "OathPath owns the truth" is a
   * promise a learner should be able to CHECK. False on a flashcard, where the
   * point is the answer and the citation is one more thing between the learner
   * and the next card — it is one tap away on the same question's detail view.
   */
  showSources?: boolean;
}

export function AnswerPanel({
  question,
  stateName,
  headingComponent = 'h3',
  showSources = false,
}: AnswerPanelProps) {
  const { answers, answerResolution, resolvedForStateCode, verifiedAt } = question;
  const asOf = formatVerifiedAt(verifiedAt);
  const many = answers.length > 1;

  // Deduplicated: a multi-answer question loaded from one content file cites
  // the same source on every row, and five identical citations under five
  // answers is noise that makes a genuinely differing one harder to notice.
  const sources = showSources
    ? [...new Set(answers.map((a) => a.sourceNote).filter((n): n is string => !!n))]
    : [];

  return (
    <Box>
      <Typography
        variant="overline"
        component={headingComponent}
        color="text.secondary"
        sx={{ display: 'block', mb: 1 }}
      >
        {many ? 'Answers' : 'Answer'}
      </Typography>

      {answerResolution === 'state_required' ? (
        <StateRequiredNotice />
      ) : answers.length === 0 ? (
        // Polite, like every other designed absence on this screen: content
        // that has not been loaded is not a fault, and an assertive role would
        // interrupt a screen reader to say so.
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
            <Stack component="ul" spacing={1} sx={{ m: 0, pl: 3 }}>
              {answers.map((answer) => (
                <Typography component="li" variant="h6" key={answer.id}>
                  {answer.text}
                </Typography>
              ))}
            </Stack>
          ) : (
            <Typography variant="h6" component="p">
              {answers[0].text}
            </Typography>
          )}

          {resolvedForStateCode && (
            // Shown whenever the answer IS state-specific, not only when
            // something looks off: a learner who moved and forgot to update
            // their plan is reading a confident, well-formatted answer for
            // somewhere they no longer live, and this line is the only thing
            // on the screen that could tell them.
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1.5 }}
            >
              This is the answer for {stateName || resolvedForStateCode}.
            </Typography>
          )}

          {asOf && (
            <Typography
              variant="caption"
              color="text.secondary"
              component="p"
              sx={{ mt: 1.5 }}
            >
              Current as of {asOf}.
            </Typography>
          )}

          {sources.map((note) => (
            <Typography
              key={note}
              variant="caption"
              color="text.secondary"
              component="p"
              sx={{ mt: 0.5 }}
            >
              Source: {note}
            </Typography>
          ))}
        </>
      )}
    </Box>
  );
}

export default AnswerPanel;
