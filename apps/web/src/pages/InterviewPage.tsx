/**
 * The mock interview itself (`/practice/interviews/:id`).
 *
 * Issue #140, epic #57 / E8 — the screen `VISION.md`'s single aspiration lands
 * on: "by the time a user walks into their naturalization interview, the
 * experience should feel familiar".
 *
 * =============================================================================
 * THE ONE CONSTRAINT THIS WHOLE SCREEN IS BUILT AROUND
 * =============================================================================
 *
 * **NO CORRECT/INCORRECT SIGNAL APPEARS ANYWHERE BEFORE THE INTERVIEW IS
 * COMPLETED** — no tick, no cross, no colour, no score, no count of correct
 * answers, no per-answer feedback, and nothing that changes appearance based on
 * how the learner is doing. Progress may say "Question 4 of 10"; it may never
 * say how many were right.
 *
 * `docs/specs/mock-interview.md` §10 gives the reason as a concrete failure
 * this design avoids: a learner who sees a green tick after each answer is not
 * rehearsing the thing they are afraid of. The real interview gives no
 * per-question feedback — an applicant does not learn whether question four was
 * right before question five is asked — and a rehearsal that reassures or
 * corrects along the way is teaching them to expect a signal the actual event
 * will never give. `VISION.md`'s Product Principle 7, "coaching decreases as
 * the user approaches authentic interview simulation", is the same instruction
 * from the other side: the Quick 5 drill reveals its verdict per question
 * because it is coaching, and this withholds it entirely because it is the
 * closest thing to the real event this product offers.
 *
 * Three things keep it true, and all three have to stay:
 *
 *  1. **The API is built for it.** A turn's terminal frame carries officer
 *     text, a phase, a turn index and a pacing count — there is no outcome
 *     field on it, and `GET /api/interviews/:id` returns `debrief: null` until
 *     the interview is `completed`.
 *  2. **`useMockInterview` holds no verdict**, because nothing sends it one.
 *  3. **This page renders no practice vocabulary.** Nothing here imports
 *     `components/practice/outcome.ts`, and it must not: `outcomeDisplay`'s
 *     "Correct" / "Partly right" / "Not a match" and its success/error palette
 *     roles are the coaching language of the drill screens, and the only way
 *     they reach this one is if somebody deliberately brings them.
 *
 * A test asserts the absence of that vocabulary directly, so a later change
 * that added a tick fails rather than ships.
 *
 * =============================================================================
 * `unavailable` IS NOT AN ERROR, AND THE INTERVIEW CONTINUES EITHER WAY
 * =============================================================================
 *
 * All three terminal frames — `done`, `unavailable`, `error` — carry the turn
 * that happened. The engine decides everything (which question is next, whether
 * the answer passed, when the civics phase stops); the model supplies the
 * officer's PHRASING and nothing else, so when the dispatcher is unavailable or
 * fails, the server substitutes a fixed, code-owned neutral officer line and
 * proceeds identically (§5.2). The officer turn on screen in that case is real
 * and was really returned.
 *
 * So `unavailable` renders the turn plus the shared `AiNotReady` (#43, and
 * `CLAUDE.md` requires that component rather than a bespoke message) — never an
 * error alert, never a spinner that keeps spinning, never a blocked screen. The
 * one cause `AiNotReady` is not true of is `no_user_key`, which is the
 * learner's own to fix; that gets its own short alert pointing at the page that
 * fixes it, exactly as `ExplainPanel` does and for the reason that file states.
 *
 * =============================================================================
 * THE END CONTROL DOES NOT DISCARD THE INTERVIEW
 * =============================================================================
 *
 * It is reachable in every phase, including mid-stream, is one tap, and calls
 * `POST /api/interviews/:id/complete` — so leaving finishes the interview with
 * a real debrief instead of abandoning it. `useMockInterview.complete()` fires
 * the abort first, because the officer's words are generated on the learner's
 * own key and a conversation that is over should stop costing money.
 *
 * -----------------------------------------------------------------------------
 * WHERE IT GOES AFTERWARDS
 * -----------------------------------------------------------------------------
 *
 * It navigates to `/practice/interviews/:id/debrief`.
 *
 * This block used to say something else, and the difference is the whole
 * content of issue #145. It read: "It navigates to `/practice`. That is
 * deliberate and temporary: the debrief screen is issue #145,
 * `/practice/interviews/:id/debrief` DOES NOT EXIST YET, and sending a learner
 * to a route that is not mounted would land them on the catch-all redirect to
 * `/` — the 'a next action must never point at a route that redirects' rule,
 * met one layer down." **That condition has now been met**: the debrief route
 * is mounted in `App.tsx`, so {@link afterCompletionPath} points at it and
 * nothing else on this page changed — the completion call, the abort and the
 * copy were all already right.
 *
 * The note that got us here was the same shape as the E1→E3 re-pointing note
 * `apps/api/src/journey/next-action.ts` carries, and this replacement is the
 * same shape as that file's own "E8 CLAIMS `interview`" paragraph, for the same
 * reason: recording that the destination now exists is what stops the next
 * contributor re-deriving whether it does.
 *
 * =============================================================================
 * QUIETER THAN THE REST OF THE APP, DELIBERATELY
 * =============================================================================
 *
 * No confetti, no streak badge, no celebration, no emoji, restrained colour.
 * This is a rehearsal of a formal encounter with a government official, and
 * `VISION.md` is explicit that this product never manufactures pressure or
 * cheer. The only emphasis on the screen is on the officer's current turn,
 * because that is the question on the table.
 *
 * =============================================================================
 * ACCESSIBILITY AND WIDTH
 * =============================================================================
 *
 * One `h1` ("Mock interview"), the officer's turns beneath it, and a real
 * `<label>` on the answer box (`AnswerBox`). The transcript is a live region
 * that is MOUNTED FROM THE FIRST RENDER and only ever has its contents changed
 * — a live region inserted at the same moment as its content is commonly missed
 * entirely by assistive technology, the same reasoning `PracticeSessionPage`
 * gives for its verdict region.
 *
 * It is `aria-live="polite"`, and the choice matters: officer text arrives
 * token by token, and an `assertive` region would interrupt the reader on every
 * fragment — "Thank", "you. Let", "us continue" — which is worse than silence
 * and would make the screen unusable with a screen reader. `aria-busy` is set
 * while tokens are still arriving so the announcement waits for a settled turn,
 * exactly as `ExplainPanel` handles its own stream.
 *
 * Mobile-first: every responsive value steps at `sm` (600px), never `md`, and
 * none of `CLAUDE.md`'s five coupled breakpoint gates is touched here — this
 * page only agrees with them.
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import {
  Link as RouterLink,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';

import { AiNotReady } from '../components/ai/AiNotReady';
import { AI_KEY_SETTINGS_PATH } from '../components/ai/ExplainPanel';
import { AnswerBox } from '../components/interview/AnswerBox';
import { EndInterviewControl } from '../components/interview/EndInterviewControl';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { OfficerCard } from '../components/interview/OfficerCard';
import { PhaseProgress } from '../components/interview/PhaseProgress';
import { interviewDebriefPath } from '../components/interview/paths';
import { useMockInterview } from '../hooks/useMockInterview';

/** What `AiNotReady` calls this feature in its first line. */
const FEATURE_NAME = 'The officer’s own wording';

/**
 * Where a finished interview sends the learner: its own debrief (#145).
 *
 * A thin alias over `interviewDebriefPath` rather than a second spelling of the
 * URL — see `components/interview/paths.ts`. It is kept as a named export
 * because this file's header explains what it points at and why, and a reader
 * following that explanation should find something to look at.
 */
export function afterCompletionPath(interviewId: string): string {
  return interviewDebriefPath(interviewId);
}

export default function InterviewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * Why this learner is here rather than on the spoken screen (#159, E11).
   *
   * Set only when `RealtimeInterviewPage` navigated here after a voice
   * connection it could not re-establish. It is a SENTENCE, not a code, and it
   * is announced — a learner whose officer went silent mid-question and who
   * then finds themselves looking at a text box deserves one line saying what
   * happened, not a screen that pretends this is where they meant to be.
   *
   * Router state rather than a query parameter, because it describes how this
   * navigation happened rather than what this URL is: a bookmark of an
   * interview should not carry it.
   */
  const voiceFallback =
    typeof (location.state as { voiceFallback?: unknown } | null)
      ?.voiceFallback === 'string'
      ? (location.state as { voiceFallback: string }).voiceFallback
      : null;

  const {
    interview,
    officerTurns,
    phase,
    progress,
    awaitingCompletion,
    isLoading,
    loadError,
    refresh,
    turnStatus,
    isStreaming,
    streamingText,
    unavailableCause,
    turnError,
    submitTurn,
    isCompleting,
    completeError,
    complete,
  } = useMockInterview(id);

  const [answer, setAnswer] = useState('');

  const handleSubmit = () => {
    if (isStreaming) return;
    submitTurn(answer);
    // Cleared immediately rather than on the turn landing: the answer has been
    // sent, and a field still holding it reads as though it has not been.
    setAnswer('');
  };

  const handleEnd = async () => {
    if (!id) return;
    const debrief = await complete();
    // Only on success. A failed completion leaves the learner where they are,
    // with the reason on screen, rather than navigating away from an interview
    // that is still open.
    if (debrief) navigate(afterCompletionPath(id), { replace: true });
  };

  // ---------------------------------------------------------------------------
  // The states that are not an interview
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box role="status" aria-live="polite" aria-label="Loading your interview">
          <LoadingSpinner />
        </Box>
      </Container>
    );
  }

  if (loadError || !interview) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box sx={{ py: { xs: 1, sm: 2 } }}>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
            Mock interview
          </Typography>
          <Alert
            severity="error"
            sx={{ mt: 3 }}
            action={
              <Button color="inherit" size="small" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          >
            {loadError ?? 'That interview could not be loaded.'}
          </Alert>
          <Button
            component={RouterLink}
            to="/practice"
            startIcon={<ArrowBackIcon />}
            sx={{ mt: 3, ml: -1 }}
          >
            Back to Practice
          </Button>
        </Box>
      </Container>
    );
  }

  /**
   * A finished (or abandoned) interview is not redirected away from.
   *
   * A redirect would take a learner who followed a link to their own interview
   * and drop them somewhere they did not ask for, with no explanation. It says
   * plainly what state the interview is in instead.
   *
   * #145 was going to replace this block with the stored debrief. It does not,
   * and the reason is worth recording: the debrief got its OWN route
   * (`/practice/interviews/:id/debrief`, §14's third), so rendering it here as
   * well would put the same result at two URLs, only one of which a history row
   * or a bookmark points at. This block links there instead — one debrief, one
   * address, and this screen keeps its single job of conducting an interview.
   */
  if (interview.status !== 'in_progress') {
    return (
      <Container maxWidth="md" disableGutters>
        <Box sx={{ py: { xs: 1, sm: 2 } }}>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
            Mock interview
          </Typography>
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mt: 3 }}>
            <Typography variant="h6" component="h2">
              This interview is finished.
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              There is nothing left to answer here.
            </Typography>
            <Button
              component={RouterLink}
              to={interviewDebriefPath(interview.id)}
              variant="contained"
              sx={{ mt: 2 }}
            >
              See how it went
            </Button>
          </Paper>
          <Button
            component={RouterLink}
            to="/practice"
            startIcon={<ArrowBackIcon />}
            sx={{ mt: 3, ml: -1 }}
          >
            Back to Practice
          </Button>
        </Box>
      </Container>
    );
  }

  /**
   * The `unavailable` cause an ADMINISTRATOR has to fix.
   *
   * `no_user_key` is excluded because `AiNotReady`'s "this is not a problem
   * with your key" is not true of it — `ExplainPanel`'s header has the full
   * argument for why that is not a prop on the shared component.
   */
  const adminUnavailable =
    turnStatus === 'unavailable' && unavailableCause !== 'no_user_key';

  const lastIndex = officerTurns.length - 1;

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Mock interview
        </Typography>

        <Box sx={{ mt: 0.5 }}>
          <PhaseProgress
            phase={phase}
            progress={progress}
            awaitingCompletion={awaitingCompletion}
          />
        </Box>

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {/* ARRIVED FROM THE SPOKEN SCREEN (#159). Not an error: the interview
            itself is untouched — same id, same engine state, same next question
            — and the only thing that changed is which transport is carrying it.
            `role="status"` rather than `role="alert"`, because nothing here
            needs interrupting; the officer's turn below is what the learner
            should be reading. */}
        {voiceFallback && (
          <Alert severity="info" role="status" sx={{ mb: 3 }}>
            <AlertTitle>{voiceFallback}</AlertTitle>
            You are carrying on by typing, in the same interview. Nothing you
            already answered was lost, and the next question is below.
          </Alert>
        )}

        {/* THE TRANSCRIPT, AND THE LIVE REGION. Mounted from the first render
            and only ever added to — see the file header for why that ordering
            is what makes the announcement happen at all, and why it is polite
            rather than assertive. */}
        <Stack
          spacing={2}
          aria-live="polite"
          aria-busy={isStreaming}
          aria-label="Interview transcript"
        >
          {officerTurns.map((turn, index) => (
            <OfficerCard
              key={turn.id}
              text={turn.text}
              phase={turn.phase}
              isCurrent={index === lastIndex && !isStreaming}
            />
          ))}

          {/* The turn currently arriving. Replaced by the real officer turn
              above the moment the terminal frame lands, which carries the same
              words plus (in the civics phase) the question read verbatim from
              the database. */}
          {isStreaming && (
            <OfficerCard
              text={streamingText}
              phase={phase ?? 'smalltalk'}
              isCurrent
              isStreaming
            />
          )}
        </Stack>

        {/* NOT AN ERROR, AND THE INTERVIEW DID NOT STOP. The officer turn above
            is real and was really returned; only its wording is plainer. */}
        {turnStatus === 'unavailable' && (
          <Box sx={{ mt: 2 }}>
            <Alert severity="info" role="status">
              The officer is using plainer wording for now. The interview itself
              is unaffected &mdash; same questions, same order, graded the same
              way.
            </Alert>

            {adminUnavailable && <AiNotReady feature={FEATURE_NAME} />}

            {unavailableCause === 'no_user_key' && (
              // The one cause that IS the learner's to fix.
              <Alert severity="info" sx={{ mt: 2 }}>
                <AlertTitle>Add your AI key for a more natural officer</AlertTitle>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  The officer&rsquo;s wording is generated on your own AI key,
                  and there isn&rsquo;t one saved on your account yet.
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  component={RouterLink}
                  to={AI_KEY_SETTINGS_PATH}
                >
                  Add your key
                </Button>
              </Alert>
            )}
          </Box>
        )}

        {/* A DELIVERY FAILURE, NOT A BROKEN INTERVIEW — which is why this is a
            warning rather than an error. The answer was graded and the turn was
            recorded before the response opened; what did not arrive is the
            officer's phrasing. */}
        {turnStatus === 'error' && turnError && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {turnError}
          </Alert>
        )}

        {completeError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {completeError}
          </Alert>
        )}

        {/* AWAITING COMPLETION: the officer has finished and there is nothing
            left to answer. The finish control takes the place of the answer
            box, so focus never lands on a field that accepts nothing. */}
        {awaitingCompletion ? (
          <Box sx={{ mt: 3 }}>
            <Typography color="text.secondary" sx={{ maxWidth: '60ch' }}>
              That&rsquo;s the end of the interview. Finish it to see how it
              went &mdash; question by question, with the accepted answers.
            </Typography>
            <Box sx={{ mt: 2 }}>
              <EndInterviewControl
                variant="finish"
                pending={isCompleting}
                onEnd={() => void handleEnd()}
              />
            </Box>
          </Box>
        ) : (
          <AnswerBox
            value={answer}
            onChange={setAnswer}
            onSubmit={handleSubmit}
            disabled={isStreaming}
            pending={isStreaming}
            // A new officer turn is a new question to answer, so the field
            // takes the focus back.
            focusKey={officerTurns.length}
          />
        )}

        {/* REACHABLE IN EVERY PHASE, INCLUDING MID-STREAM. Rendered outside the
            branch above so it is present whether the learner is answering or
            finishing — see `EndInterviewControl` for why it is never disabled
            and never asks "are you sure?". */}
        {!awaitingCompletion && (
          <Box sx={{ mt: 4 }}>
            <EndInterviewControl
              pending={isCompleting}
              onEnd={() => void handleEnd()}
            />
          </Box>
        )}
      </Box>
    </Container>
  );
}
