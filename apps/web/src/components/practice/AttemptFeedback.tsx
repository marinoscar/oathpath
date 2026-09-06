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
 *
 * =============================================================================
 * THE ANSWER IS READ ALOUD TOO (#287, epic #280)
 * =============================================================================
 *
 * With auto-submit a learner can ask and answer entirely by voice, and then had
 * to look at the screen to find out what the right answer was. The real
 * interview is spoken in both directions, and `VISION.md`'s "patient human
 * coach" is a coach who SAYS the answer back.
 *
 * SINCE #358 (epic #345) IT IS ALSO THE ONLY `QuestionAudio` ON THE PAGE WHILE
 * A VERDICT IS UP: `PracticeSessionPage` unmounts the question's player when a
 * result arrives, so the answer's is the one player mounted. Three players —
 * the question's, the answer's and the hands-free loop's — could previously be
 * in the tree at once, each with a text button and a status line of its own,
 * for what is at any moment one thing worth hearing.
 *
 * It is the same `QuestionAudio` the question uses, with its `copy` prop
 * re-worded — not a second player. Everything that makes that component
 * trustworthy is therefore inherited rather than re-decided here: the browser's
 * own voice by default (so this works on a fresh install with no `speak`
 * binding and no warning anywhere), the control ABSENT rather than disabled
 * where nothing can speak, and the shared "one voice at a time" registry that
 * keeps this mount and the question's from talking over each other.
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
import { DEFAULT_SPEECH_RATE, QuestionAudio } from '../voice/QuestionAudio';
import { AcceptedAnswers } from './AcceptedAnswers';
import { AiFeedbackCard } from './AiFeedbackCard';

/**
 * The five strings the answer's player says instead of the question's.
 *
 * `unavailable` still points at the text, because unlike the writing screen the
 * accepted answer IS on this page — it is rendered immediately above this
 * control, by `AcceptedAnswers`, and a learner whose browser cannot speak has
 * lost nothing but the reading.
 */
const ANSWER_AUDIO_COPY = {
  play: 'Read the answer aloud',
  stop: 'Stop reading',
  preparing: 'Preparing the voice…',
  speaking: 'Reading the answer aloud.',
  unavailable: 'The answer could not be read aloud. The text is above.',
};

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

  // ---------------------------------------------------------------------------
  // Voice (#287, epic #280). Every one of these defaults, so the pre-existing
  // callers compile — and read — exactly as they did.
  // ---------------------------------------------------------------------------

  /**
   * `user_settings.voice.readAnswersAloud` — start reading without a click.
   *
   * Defaults to `false`, matching `DEFAULT_VOICE_READ_ANSWERS_ALOUD`: the
   * control is always there, but it speaks by itself only for a learner who
   * asked it to.
   */
  readAnswersAloud?: boolean;

  /**
   * Has anything in this session been clicked, tapped or keyed yet?
   *
   * AUTOPLAY IS ARMED BY THIS AND NOTHING ELSE. Browsers refuse sound until the
   * document has had a user gesture, and a refusal is not a failure: `playBlob`
   * answers `false`, the browser voice is tried, and if that is refused too the
   * screen stays exactly as it was. There is deliberately no error state for
   * it — nothing went wrong, and a learner who never clicked anything did not
   * ask to hear this.
   */
  hasUserGesture?: boolean;

  /** `user_settings.voice.preferPremiumVoice`. A wish; `speak` may be unbound. */
  premiumVoice?: boolean;
  /** `user_settings.voice.preferredVoice` — the PROVIDER's voice id. */
  preferredVoice?: string;
  /** `user_settings.voice.speechRate` — the BROWSER path's playback rate. */
  speechRate?: number;
}

export function AttemptFeedback({
  result,
  onNext,
  nextLabel,
  onSelfMark,
  selfMarking,
  selfMarkError,
  readAnswersAloud = false,
  hasUserGesture = false,
  premiumVoice = false,
  preferredVoice,
  speechRate = DEFAULT_SPEECH_RATE,
}: AttemptFeedbackProps) {
  const { attempt } = result;

  /**
   * The one accepted answer to READ — the FIRST, never a concatenation.
   *
   * `AcceptedAnswers` presents the first as the canonical one (it is the only
   * one rendered when there is a single answer, and the head of the list
   * otherwise), and this speaks what that panel presents. Several civics
   * questions accept five or more alternatives; stringing them together would
   * read a paragraph to somebody who asked to hear "the answer", and would
   * imply — exactly as an unlabelled list would — that all of them are wanted.
   *
   * `undefined` where there is nothing to say: a `state_required` snapshot
   * shows the notice and no answer text at all, and an empty snapshot is an
   * honest "nothing recorded". Speaking in either case would be inventing
   * content the panel above deliberately does not show.
   */
  const spokenAnswer =
    attempt.answerSnapshot.answerResolution === 'state_required'
      ? undefined
      : result.acceptedAnswers[0]?.text;

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
      <AiFeedbackCard
        attempt={attempt}
        // THE RECOURSE, FOLDED INTO THE CARD'S OWN DISCLOSURE (#358, epic
        // #345). It used to be a fixed paragraph below the accepted answers,
        // on every cold, unrevealed miss. The sentence is unchanged and the
        // case it renders on is unchanged; what changed is that it is now
        // behind the same "How this was graded" toggle the provenance note
        // sits behind, because it is the same kind of thing — a true, rarely
        // wanted explanation of the grading record — and because a second
        // toggle beside that one would have cut the prose and added the
        // surface straight back.
        //
        // ONE QUIET SENTENCE, ON ONLY THE CASE IT EXPLAINS: never after a skip
        // (nothing was claimed) and never after a correct answer (nothing to
        // explain). A learner who answered cold and was told "not a match" has
        // no self-mark control on this screen, and without this the reason
        // looks like the product refusing to listen rather than the record
        // refusing to accept an unchecked claim.
        details={
          !canSelfMark && attempt.outcome === 'incorrect' && !attempt.revealed ? (
            <Typography variant="body2" color="text.secondary">
              If you think your answer was right, choose &ldquo;Show me the
              answer&rdquo; next time &mdash; we can only count your own call
              once you&rsquo;ve seen what it was compared against.
            </Typography>
          ) : undefined
        }
      />

      {/* `my: 1.5` rather than `2` since #358: on a 360x640 phone the verdict,
          the accepted answers and the next action have to fit together, and
          the rhythm between them is one of the few places to find the room
          without deleting something a learner needs. */}
      <Divider aria-hidden sx={{ my: 1.5 }} />

      {/* The answers, and the FIRST moment they exist anywhere on this page. */}
      <AcceptedAnswers
        answers={result.acceptedAnswers}
        answerResolution={attempt.answerSnapshot.answerResolution}
        resolvedForStateCode={attempt.answerSnapshot.resolvedForStateCode}
        headingComponent="h3"
      />

      {/* THE SAME PLAYER THE QUESTION USES, re-worded (#287). It sits with the
          answers it reads, and appears on EVERY revealed answer — a graded
          attempt, a skip, and "Show me the answer" — because this component is
          reached by exactly those three paths and none of them is a case where
          hearing the answer is less useful.

          `onPlayed` IS DELIBERATELY NOT PASSED, AND MUST NOT BE ADDED. That
          prop exists so a caller can record `promptMode: 'heard'` on the
          attempt it writes — see its own comment. The attempt this screen shows
          is ALREADY WRITTEN, and it is an attempt at a question the learner
          answered before any of this played. Wiring `onPlayed` here would put a
          claim in `practice_attempts` that the learner heard a question they
          did not, on the strength of having heard the answer afterwards. */}
      {spokenAnswer && (
        <Box sx={{ mt: 1, ml: -1 }}>
          <QuestionAudio
            text={spokenAnswer}
            copy={ANSWER_AUDIO_COPY}
            premiumVoice={premiumVoice}
            voice={preferredVoice}
            rate={speechRate}
            // Only for a learner who asked, and only once the document has had
            // a gesture. Both halves are the host's to know.
            autoPlay={readAnswersAloud && hasUserGesture}
            // THIS PLAYER IS INSIDE THE PAGE'S ONE LIVE REGION (#358). Its
            // status line is still rendered and still announced — by the
            // region that contains it, rather than by a second region nested
            // inside that one. See `QuestionAudio`'s `announce` prop.
            announce={false}
          />
        </Box>
      )}

      {selfMarkError && (
        // `role="presentation"` — the LOOK of an alert without a second live
        // region (#358). This block renders inside `PracticeSessionPage`'s one
        // `role="status"` region, so the failure is announced as that region's
        // change; MUI's default `role="alert"` here would be a live region
        // nested in a live region, read twice and interrupting the verdict it
        // arrived beside. The same reasoning that page already applies to its
        // own nested alerts.
        <Alert severity="error" role="presentation" sx={{ mt: 2 }}>
          {selfMarkError}
        </Alert>
      )}

      {/* A WRAPPING ROW ON EVERY WIDTH, NOT A COLUMN ON `xs` (#358). Stacking
          full-width turned two controls into two rows on the phone the whole
          screen has to fit in, and pushed the primary action further from the
          verdict it belongs to. Wrapping keeps them side by side where they
          fit and costs a row only where they genuinely do not. */}
      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 2, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
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
