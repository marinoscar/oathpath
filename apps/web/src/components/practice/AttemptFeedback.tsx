/**
 * The verdict, the accepted answers, and the way onward — everything a learner
 * sees AFTER an attempt is recorded.
 *
 * Issue #79, epic #52; the verdict block replaced by `AiFeedbackCard` in #125
 * (E4), which is the ONLY change this screen needed to carry the AI grading
 * rung's output. The verdict, the failure cause and the coaching line are one
 * component precisely so this screen and the summary's review rows cannot come
 * to disagree about a judgement the learner reads twice.
 *
 * =============================================================================
 * THIS COMPONENT EXISTS BECAUSE THE ANSWERS MUST HAVE NOWHERE ELSE TO LIVE
 * =============================================================================
 *
 * It takes a `PracticeAttemptResult` — the response to the POST that already
 * wrote the attempt row — and nothing else. There is no "answers" prop the
 * session screen could pass early, no `revealed` boolean gating a block that is
 * already in the tree, and no question object carrying an answer alongside its
 * prompt. The only way to render this component is to have a graded attempt in
 * hand, which means the evidence is already recorded and the answer has been
 * earned.
 *
 * That shape is the enforcement mechanism for the constraint
 * `PracticeSessionPage`'s header sets out at length: if the accepted answers
 * are in the DOM before the learner has produced something, the exercise is
 * multiple choice wearing a text box.
 *
 * =============================================================================
 * SELF-MARK IS DELIBERATELY NOT THE EASY PATH
 * =============================================================================
 *
 * A `variant="text"`, `size="small"`, `color="inherit"` button, below the
 * primary action and visually quieter than it. That is a product decision, not
 * a styling preference, and it is worth stating plainly because the natural
 * instinct on a screen that has just told somebody they were wrong is to make
 * the "actually, I was right" button prominent and kind.
 *
 * A self-mark is REAL EVIDENCE — it writes `outcome: 'correct'` into
 * `practice_attempts`, the one table E5's mastery model, E6's readiness score
 * and E7's engagement signals all read. It is also the ONE point in that table
 * where the system trusts the learner's own judgement in place of an
 * independent check, which is why `gradingMethod: 'self'` exists and why
 * `practice-sessions.md` §9 locks E5 into weighing it lower than `exact`.
 *
 * An interface that makes it the obvious click produces evidence nobody can
 * trust: a learner clicking the biggest button on the screen out of habit is
 * not asserting anything, and the readiness number computed from a table full
 * of those assertions would tell them they are ready for an interview they are
 * not ready for. `VISION.md`'s whole premise is accurate confidence; a
 * flattering button is how a product loses that quietly, one default click at a
 * time.
 *
 * The primary action here is therefore always **moving on**.
 */

import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from '@mui/material';

import type { PracticeAttemptResult } from '../../types';
import { AcceptedAnswers } from './AcceptedAnswers';
import { AiFeedbackCard } from './AiFeedbackCard';

export interface AttemptFeedbackProps {
  /** The graded attempt, straight from the POST that recorded it. */
  result: PracticeAttemptResult;
  /** Move to the next question, or finish. The PRIMARY action, always. */
  onNext: () => void;
  /** What the primary action says — the caller knows whether this was the last. */
  nextLabel: string;
  /** Claim this one as correct. Rendered only when the API would accept it. */
  onSelfMark: () => void;
  selfMarking: boolean;
  /** A failed self-mark, as a string. Never swallowed, never a thrown error. */
  selfMarkError: string | null;
}

export function AttemptFeedback({
  result,
  onNext,
  nextLabel,
  onSelfMark,
  selfMarking,
  selfMarkError,
}: AttemptFeedbackProps) {
  const { attempt } = result;

  /**
   * Is the self-mark route open for this attempt?
   *
   * BOTH CONDITIONS ARE THE API'S, NOT THIS COMPONENT'S TASTE.
   * `POST .../self-mark` refuses an already-`correct` attempt with a 400 (there
   * is nothing to grant, and overwriting `exact` with `self` would *downgrade*
   * a verified match to a claim) and an unrevealed attempt with a 409 ("my
   * answer matched the accepted one" is only checkable against the accepted
   * one, not against the learner's memory of what they think it was).
   *
   * So the control is rendered exactly where the endpoint accepts it. Rendering
   * it everywhere and letting the 409 come back would be an affordance that
   * predictably fails — worse for the learner than one that appears when it
   * works, and worse for the record than either, because a learner who meets a
   * refusal twice learns to distrust the whole verdict.
   *
   * `PracticeSessionPage`'s header explains how a learner reaches the eligible
   * state: **Show me the answer** is a real submit that carries whatever they
   * typed AND sets `revealed`, so the one click both grades their words and
   * earns the right to claim them.
   */
  const canSelfMark = attempt.outcome !== 'correct' && attempt.revealed;

  return (
    <Box>
      {/* The verdict, and — only when a grader actually ran — the failure cause
          and the one line of coaching. THE SAME COMPONENT the summary screen's
          review rows render, so a learner revisiting this session reads the
          identical judgement they were given live. See `AiFeedbackCard` for
          why a deterministic grade shows the plain verdict and nothing else. */}
      <AiFeedbackCard attempt={attempt} />

      <Divider aria-hidden sx={{ my: 2 }} />

      {/* The answers, and the FIRST moment they exist anywhere on this page. */}
      <AcceptedAnswers
        answers={result.acceptedAnswers}
        answerResolution={attempt.answerSnapshot.answerResolution}
        resolvedForStateCode={attempt.answerSnapshot.resolvedForStateCode}
        headingComponent="h3"
      />

      {/* The recourse, named where its absence would otherwise be a mystery.
          A learner who answered cold and was told "not a match" has no
          self-mark control on this screen, and without this line the reason
          looks like the product refusing to listen rather than the record
          refusing to accept an unchecked claim. One quiet sentence, and only
          on the case it explains: never after a skip (nothing was claimed) and
          never after a correct answer (nothing to explain). */}
      {!canSelfMark && attempt.outcome === 'incorrect' && !attempt.revealed && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          If you think your answer was right, choose &ldquo;Show me the
          answer&rdquo; next time &mdash; we can only count your own call once
          you&rsquo;ve seen what it was compared against.
        </Typography>
      )}

      {selfMarkError && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {selfMarkError}
        </Alert>
      )}

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ mt: 3, alignItems: { xs: 'stretch', sm: 'center' } }}
      >
        <Button variant="contained" size="large" onClick={onNext}>
          {nextLabel}
        </Button>

        {canSelfMark && (
          <Button
            // Text, small, inherited colour: quieter than the primary action
            // beside it, on purpose. See this file's header — this is the
            // product decision, not the styling.
            variant="text"
            size="small"
            color="inherit"
            onClick={onSelfMark}
            disabled={selfMarking}
            startIcon={
              selfMarking ? <CircularProgress size={14} color="inherit" /> : undefined
            }
          >
            {selfMarking ? 'Saving…' : 'I was right'}
          </Button>
        )}
      </Stack>
    </Box>
  );
}

export default AttemptFeedback;
