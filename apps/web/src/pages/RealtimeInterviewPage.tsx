/**
 * The spoken mock interview (`/practice/interviews/:id/voice`).
 *
 * Issue #159, epic #60 / E11 — the screen the whole product points at. Issue
 * #60's own summary is the standard this file is held to, and it is a standard
 * about feel rather than about features:
 *
 *   > By the time a user walks into their naturalization interview, the
 *   > experience should feel familiar. The user should feel like they are
 *   > speaking with a patient human coach, not operating a voice command
 *   > interface.
 *
 * =============================================================================
 * THERE IS NO PUSH-TO-TALK, AND ITS ABSENCE IS THE FEATURE
 * =============================================================================
 *
 * The microphone opens once, when the learner starts, and stays open until they
 * end. There is no hold-to-speak button, no tap-to-answer, no "your turn"
 * indicator gating their voice, and nothing on this screen that has to be
 * pressed before speaking. A learner may interrupt the officer mid-sentence;
 * the officer may take its turn when they pause.
 *
 * That is not a nicety. A half-duplex rehearsal teaches a learner to wait for
 * a signal the real interview does not give, and — worse — to answer in
 * complete, uninterrupted takes, which is the one thing a nervous applicant in
 * a real interview does not do. `PushToTalkButton` exists and is right for
 * `/practice/reading`, where one sentence is scored in one take; it is
 * deliberately not imported here.
 *
 * =============================================================================
 * NO VERDICT APPEARS ANYWHERE BEFORE THE DEBRIEF
 * =============================================================================
 *
 * `InterviewPage`'s central constraint, inherited unchanged
 * (`docs/specs/mock-interview.md` §10): no tick, no cross, no colour, no score,
 * no per-answer feedback, and nothing that changes appearance based on how the
 * learner is doing. It matters MORE here than on the text screen, because a
 * reassurance delivered in a warm human voice within a second of answering is
 * far more convincing than one printed on a card — and the real interview will
 * never provide it.
 *
 * Structurally: the tool results this screen relays carry no outcome field, and
 * `grade_answer`'s `recorded` flag is a statement about the RECORD (a reading
 * transcript the recogniser did not trust writes no row) rather than about the
 * answer. Nothing here reads it.
 *
 * =============================================================================
 * THE WRITING SEGMENT IS DICTATED AND NEVER SHOWN
 * =============================================================================
 *
 * `docs/specs/english-test.md` §4, held on this transport as a DOM invariant —
 * see `useRealtimeInterview`'s header for the two separate leaks it closes. The
 * screen's part is small and load-bearing: it renders `LiveTranscript`, whose
 * only branch on a withheld line prints a code-owned constant, and
 * `DictationAnswer`, which is `WritingPracticePage`'s own field and has no prop
 * a sentence could travel in.
 *
 * =============================================================================
 * THE END CONTROL IS IN THE HEADER, AND THAT IS WHY
 * =============================================================================
 *
 * A live transcript grows without bound, so a control placed after it scrolls
 * off the screen — and the moment somebody most wants out of a rehearsal of a
 * stressful conversation is the moment it is going badly, which is also the
 * moment they are furthest down the page. It sits beside the `h1` instead:
 * always in view, second in the tab order, never disabled while connected
 * (`EndInterviewControl`'s own header states why it is never disabled and never
 * asks "are you sure?"), and it stops every media track before it completes the
 * interview — so the operating system's microphone light goes out when the
 * learner says stop, not when a request settles.
 *
 * =============================================================================
 * EVERY FAILURE ENDS AT THE TEXT INTERVIEW
 * =============================================================================
 *
 * §12's third locked decision. A dropped connection mid-conversation NAVIGATES
 * there rather than offering a panel, and the difference is deliberate: the
 * officer has gone silent and the learner is sitting in it, so a screen that
 * waits for a click leaves them wondering what happened, while the text screen
 * has the outstanding question on it and an answer box ready. The failures that
 * happen BEFORE they have started speaking — an unbound role, a refused
 * microphone, a mint that failed, a handshake that never completed — render a
 * panel instead, because nothing has begun and a sudden navigation would be the
 * more startling of the two.
 *
 * =============================================================================
 * ACCESSIBILITY AND WIDTH
 * =============================================================================
 *
 * One `h1` ("Spoken mock interview"), `h2` on each panel beneath it, a real
 * `<label>` on the one field this screen ever shows, and the conversation in a
 * POLITE live region mounted from the first render — never assertive, which
 * would interrupt a screen-reader user on every fragment of the officer's
 * speech. Every fallback is in a region assistive technology announces.
 *
 * Mobile-first: every responsive value steps at `sm` (600px), never `md`, and
 * none of `CLAUDE.md`'s five coupled breakpoint gates is touched here.
 */

import { useEffect, useRef, useState } from 'react';
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
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';

import { AiNotReady } from '../components/ai/AiNotReady';
import { AI_KEY_SETTINGS_PATH } from '../components/ai/ExplainPanel';
import { DictationAnswer } from '../components/english/DictationAnswer';
import { EndInterviewControl } from '../components/interview/EndInterviewControl';
import { LiveTranscript } from '../components/interview/LiveTranscript';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { PhaseProgress } from '../components/interview/PhaseProgress';
import {
  interviewDebriefPath,
  interviewPath,
} from '../components/interview/paths';
import { useRealtimeInterview } from '../hooks/useRealtimeInterview';

/** What `AiNotReady` calls this feature in its first line. */
const FEATURE_NAME = 'The spoken interview';

/**
 * The role this screen needs, named to `AiNotReady`.
 *
 * `role="realtime"` is §7's one change to how that shared component is used:
 * the component itself, its copy, its `info` severity and its admin-only
 * "no model is bound to realtime" line are all already shipped and unchanged.
 */
const REALTIME_ROLE = 'realtime';

/**
 * What the text screen is told when a learner arrives there from a dropped
 * voice session.
 *
 * Passed as router state rather than a query parameter: it describes how this
 * navigation happened, not what the destination is, and a URL a learner could
 * bookmark or share should not carry it.
 */
export interface VoiceFallbackState {
  voiceFallback: string;
}

export default function RealtimeInterviewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const {
    interview,
    isLoading,
    loadError,
    stage,
    fallback,
    transcript,
    isOfficerSpeaking,
    phase,
    progress,
    awaitingCompletion,
    writingPrompt,
    remoteStream,
    start,
    retry,
    submitWriting,
    isSubmittingWriting,
    isCompleting,
    completeError,
    end,
  } = useRealtimeInterview(id);

  const [written, setWritten] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /**
   * Play the officer's voice.
   *
   * `srcObject` rather than a URL: the remote track is a live `MediaStream`,
   * and there is no file to point at. Guarded because a test's audio element
   * and some older engines have no `srcObject` setter, and a screen that threw
   * here would take the whole interview down over the audio element rather
   * than over the audio.
   *
   * `play()` is called and its rejection swallowed on purpose: browsers block
   * autoplay without a user gesture, and the gesture that got us here — the
   * learner pressing Start — normally satisfies it. When it does not, the
   * element is still attached and playing begins on the next interaction; an
   * error alert about an autoplay policy is not something a learner rehearsing
   * for a citizenship interview can act on.
   */
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    try {
      element.srcObject = remoteStream;
    } catch {
      return;
    }
    if (remoteStream) void element.play?.().catch(() => undefined);
  }, [remoteStream]);

  /**
   * A connection that dropped mid-conversation goes straight to text.
   *
   * `replace`, so the browser's Back button does not return the learner to a
   * dead voice screen. The interview id is the same one, and the engine's state
   * is server-side — this is a transport change, and nothing already answered
   * is asked again.
   */
  useEffect(() => {
    if (!id) return;
    if (fallback?.code !== 'connection_lost') return;
    navigate(interviewPath(id), {
      replace: true,
      state: { voiceFallback: fallback.message } satisfies VoiceFallbackState,
    });
  }, [fallback, id, navigate]);

  const handleEnd = async () => {
    if (!id) return;
    const debrief = await end();
    // Only on success. A failed completion leaves the learner here, with the
    // reason on screen, rather than navigating away from an interview that is
    // still open.
    if (debrief) navigate(interviewDebriefPath(id), { replace: true });
  };

  const handleWriting = (answer: string) => {
    submitWriting(answer);
    // Cleared immediately rather than when the grade lands: the answer has been
    // sent, and a field still holding it reads as though it has not been.
    setWritten('');
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
            Spoken mock interview
          </Typography>
          <Alert severity="error" sx={{ mt: 3 }}>
            {loadError ?? 'That interview could not be loaded.'}
          </Alert>
          <BackToPractice />
        </Box>
      </Container>
    );
  }

  if (interview.status !== 'in_progress') {
    return (
      <Container maxWidth="md" disableGutters>
        <Box sx={{ py: { xs: 1, sm: 2 } }}>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
            Spoken mock interview
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
          <BackToPractice />
        </Box>
      </Container>
    );
  }

  const connected = stage === 'live';

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        {/* THE HEADER, AND THE END CONTROL IN IT. See the file header for why
            it lives here rather than under a transcript that grows without
            bound. */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{
            alignItems: { xs: 'flex-start', sm: 'center' },
            justifyContent: 'space-between',
          }}
        >
          <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
            Spoken mock interview
          </Typography>

          {stage !== 'idle' && stage !== 'fallback' && (
            <EndInterviewControl
              variant={awaitingCompletion ? 'finish' : 'end'}
              pending={isCompleting}
              onEnd={() => void handleEnd()}
            />
          )}
        </Stack>

        <Box sx={{ mt: 0.5 }}>
          <PhaseProgress
            phase={phase}
            progress={progress}
            awaitingCompletion={awaitingCompletion}
          />
        </Box>

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {/* The officer's voice. Hidden because there is nothing to look at and
            no control to offer: pausing the officer is not a thing an applicant
            can do in a real interview, and the one control that matters —
            stopping — is the end control above. */}
        <audio ref={audioRef} autoPlay hidden data-testid="officer-audio" />

        {completeError && (
          <Alert severity="error" role="alert" sx={{ mb: 3 }}>
            {completeError}
          </Alert>
        )}

        {stage === 'idle' && <BeforeYouBegin onStart={start} />}

        {stage === 'connecting' && (
          <Box role="status" aria-live="polite" sx={{ mb: 3 }}>
            <Typography color="text.secondary">
              Connecting you to the officer&hellip; your browser will ask for
              your microphone first.
            </Typography>
          </Box>
        )}

        {fallback && fallback.code !== 'connection_lost' && id && (
          <FallbackPanel
            fallback={fallback}
            interviewId={id}
            onRetry={retry}
          />
        )}

        {/* THE CONVERSATION. Mounted from the moment the session is live and
            only ever added to — a live region inserted at the same moment as
            its content is commonly missed entirely by assistive technology.

            IT SURVIVES A RECONNECT, which is why the condition includes a
            transcript that already has something in it rather than only
            `stage === 'live'`. A re-mint puts the stage back to `connecting`
            for a second or two, and a screen that blanked the conversation
            there would tell a learner, at the exact moment their officer went
            quiet, that everything they had said was gone. */}
        {(connected || stage === 'ended' || transcript.length > 0) && (
          <LiveTranscript
            entries={transcript}
            isOfficerSpeaking={isOfficerSpeaking}
          />
        )}

        {/* THE WRITING SEGMENT. The sentence is being spoken as this renders,
            and it is not on this page — see the file header. */}
        {connected && writingPrompt && (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mt: 3 }}>
            <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
              Write what the officer read
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
              Ask the officer to repeat it if you need to hear it again &mdash;
              that is allowed, and it is not held against you.
            </Typography>
            <DictationAnswer
              value={written}
              onChange={setWritten}
              onSubmit={handleWriting}
              pending={isSubmittingWriting}
              submitLabel="Give this to the officer"
              pendingLabel="Sending…"
            />
          </Paper>
        )}

        {connected && awaitingCompletion && (
          <Typography color="text.secondary" sx={{ mt: 3, maxWidth: '60ch' }}>
            That&rsquo;s the end of the interview. Finish it to see how it went
            &mdash; question by question, with the accepted answers.
          </Typography>
        )}

        <BackToPractice />
      </Box>
    </Container>
  );
}

/** The one control that starts everything, and what it is about to do. */
function BeforeYouBegin({ onStart }: { onStart: () => void }) {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
      <Typography variant="h6" component="h2" sx={{ fontWeight: 600 }}>
        Before you begin
      </Typography>

      <Stack spacing={1.5} sx={{ mt: 2, maxWidth: '60ch' }}>
        <Typography variant="body2" color="text.secondary">
          This is a conversation, not a recording. Your microphone stays on for
          the whole interview and there is nothing to press when it is your
          turn &mdash; you can speak over the officer, and they will stop and
          listen.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          You won&rsquo;t be told how you are doing while it runs. Everything
          comes at the end, exactly as it does in the real interview.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          You can end it at any point, and you can switch to typing at any
          point. Neither loses anything you have already answered.
        </Typography>
      </Stack>

      {/* THE GESTURE. It is what gets the microphone permission prompt in front
          of the learner deliberately rather than on page load, and it is also
          what most browsers require before any audio may play — an interview
          that started itself would open with a silent officer. */}
      <Button variant="contained" size="large" onClick={onStart} sx={{ mt: 3 }}>
        Start the spoken interview
      </Button>
    </Paper>
  );
}

/**
 * Why the spoken interview cannot run, and the way onward.
 *
 * `role="alert"` so it is announced: a learner who pressed Start and heard
 * nothing needs to be told why without having to go looking.
 *
 * EVERY BRANCH OFFERS THE TEXT INTERVIEW, and it is the primary action in all
 * of them. §12's third locked decision is not a fallback in the apologetic
 * sense — the text interview drives the identical engine and produces the
 * identical debrief.
 */
function FallbackPanel({
  fallback,
  interviewId,
  onRetry,
}: {
  fallback: NonNullable<ReturnType<typeof useRealtimeInterview>['fallback']>;
  interviewId: string;
  onRetry: () => void;
}) {
  const adminUnavailable =
    fallback.code === 'ai_unavailable' && fallback.cause !== 'no_user_key';

  return (
    <Box sx={{ mb: 3 }}>
      {/* THE SHARED COMPONENT, UNFORKED, NAMING THE ROLE. An administrator
          reading this gets "no model is bound to realtime" and a link to the
          settings page; everybody else gets "nothing is wrong on your side",
          which is true. */}
      {adminUnavailable && (
        <AiNotReady feature={FEATURE_NAME} role={REALTIME_ROLE} />
      )}

      <Alert severity="info" role="alert">
        <AlertTitle>{fallback.message}</AlertTitle>

        {fallback.remedy && (
          <Typography variant="body2" sx={{ mb: 1 }}>
            {fallback.remedy}
          </Typography>
        )}

        <Typography variant="body2" sx={{ mb: 2 }}>
          You can take this interview by typing instead. It is the same
          interview, the same questions and the same result &mdash; nothing you
          have already answered is lost.
        </Typography>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button
            variant="contained"
            size="small"
            component={RouterLink}
            to={interviewPath(interviewId)}
          >
            Continue by typing
          </Button>

          {fallback.retryable && (
            <Button variant="outlined" size="small" onClick={onRetry}>
              Try the voice connection again
            </Button>
          )}

          {/* THE ONE CAUSE THAT IS THE LEARNER'S OWN TO FIX. `AiNotReady`'s
              "this is not a problem with your key" is not true of it, which is
              why it is not rendered above — see `ExplainPanel`'s header for the
              full argument. */}
          {fallback.cause === 'no_user_key' && (
            <Button
              variant="outlined"
              size="small"
              component={RouterLink}
              to={AI_KEY_SETTINGS_PATH}
            >
              Add your key
            </Button>
          )}
        </Stack>
      </Alert>
    </Box>
  );
}

function BackToPractice() {
  return (
    <Button
      component={RouterLink}
      to="/practice"
      startIcon={<ArrowBackIcon />}
      sx={{ mt: 4, ml: -1 }}
    >
      Back to Practice
    </Button>
  );
}
