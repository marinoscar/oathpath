/**
 * Reading practice (`/practice/reading`) — one sentence at a time, read aloud.
 *
 * Issue #144, epic #59 / E10 "Reading and writing tests". The reading half of
 * the naturalization interview's English segments; the writing half is #147 and
 * is deliberately a different screen with a different rule (there the sentence
 * is dictated and NEVER shown — `docs/specs/english-test.md` §4).
 *
 * =============================================================================
 * THE SENTENCE IS SHOWN. THAT IS THE TEST, NOT A LEAK.
 * =============================================================================
 *
 * This is the exact opposite of `PracticeSessionPage`'s central constraint, and
 * the difference is worth stating so that nobody "fixes" it later by hiding the
 * sentence out of habit. A civics question measures whether the learner KNOWS
 * something, so the accepted answers must not be on the page while they answer.
 * A reading sentence measures whether the learner can READ IT ALOUD — the words
 * are the prompt, not the answer. Hiding them would leave nothing to read.
 *
 * =============================================================================
 * NOTHING IS SCORED BEFORE THE LEARNER CONFIRMS THE TRANSCRIPT
 * =============================================================================
 *
 * `docs/specs/english-test.md` §3 reuses E9's confirm-before-grade mechanism
 * verbatim, and its own words are the requirement: "the confirm step is not
 * optional UI polish, it is the entire anti-penalty mechanism." So the
 * recogniser's guess lands in an EDITABLE field with a real `<label>`, and no
 * `POST /api/english/attempts` happens until the learner presses the button
 * themselves. Auto-submitting the transcript is the obvious one-less-click
 * simplification and it would turn every mishearing of an accent into a
 * recorded reading failure — `VISION.md`'s named harm, one layer down.
 *
 * =============================================================================
 * `misheard` IS THE ABSENCE OF A RECORDED FAILURE — NEVER A FAILURE
 * =============================================================================
 *
 * `POST /api/english/attempts` answers a discriminated union and BOTH ARMS ARE
 * HTTP 200. `scored` wrote one `english_attempts` row. `misheard` wrote
 * **nothing at all** — no row, no `outcome: 'incorrect'`, nothing — because a
 * reading attempt's entire evidentiary content IS the transcript, so a
 * transcript we do not believe is not weak evidence of a reading skill, it is
 * none (§3). This screen therefore renders that arm as a RETRY with the diff
 * shown for information, and says in as many words that nothing went on the
 * record. It must never be folded into the failure branch: it is the one place
 * this codebase deliberately diverges from practice, where `misheard` IS a
 * `failureCause` on a row that IS written.
 *
 * A NEAR MISS INSIDE TOLERANCE IS A PASS. §2.3's rule is compound — one word
 * wrong is not a failure — and the server has already applied it. This screen
 * shows `correct` as a pass with the diff beside it, never as "correct, but…".
 *
 * =============================================================================
 * VOICE IS OPTIONAL HERE, EXACTLY AS IT IS EVERYWHERE ELSE
 * =============================================================================
 *
 * With the `transcribe` role unbound the screen does not disappear and the
 * microphone is not a dead button: `AiNotReady` names the role (through
 * `VoiceUnavailableNotice`, the shared component — never a bespoke message),
 * and the learner reads the sentence aloud and marks their own reading.
 *
 * WHAT A SELF-MARK ACTUALLY SENDS, and why only one direction of it is
 * recorded. `POST /api/english/attempts` has no self-mark and no
 * `gradingMethod` — the request carries `responseText` and the server scores
 * it. So "I read it word for word" is submitted as exactly that: the learner
 * confirming that the words they produced were the sentence's own, which is the
 * same act as confirming a recogniser's transcript, and `responseText` is
 * defined as "the learner-CONFIRMED transcript" either way. The screen says
 * plainly that nobody but them checked it.
 *
 * "I missed a word" records NOTHING, and that is the honest answer rather than
 * a gap. Without a transcript there is no way to know WHICH words were missed,
 * and the only submittable shape for "some of it was wrong" would be an empty
 * `responseText` — which the scorer reads as every single word missing and
 * would write as a word-level record of something the learner never said. That
 * is §3's own reasoning applied one case over: when there is no trustworthy
 * account of the words, the honest response is to record nothing rather than to
 * record something hedged. Nothing of value is lost from readiness either — the
 * `english` component credits each sentence by its BEST in-window outcome
 * (§6.2), so a recorded failure would not have moved it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import MicIcon from '@mui/icons-material/Mic';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { SentenceDiff } from '../components/english/SentenceDiff';
import { PushToTalkButton } from '../components/voice/PushToTalkButton';
import { VoiceUnavailableNotice } from '../components/voice/VoiceUnavailableNotice';
import { isLowConfidence } from '../components/voice/confidence';
import { useAudioCapture } from '../hooks/useAudioCapture';
import { useIsMounted } from '../hooks/useIsMounted';
import { useVoiceAvailability } from '../hooks/useVoiceAvailability';
import {
  getNextEnglishSentence,
  recordEnglishAttempt,
  transcribeAudio,
} from '../services/api';
import type {
  EnglishAttemptResult,
  EnglishOutcome,
  EnglishSentence,
} from '../types';

/** `/practice`, spelled once. */
const PRACTICE_PATH = '/practice';

/**
 * What the microphone produced, waiting to be confirmed.
 *
 * THE TEXT IS NOT IN HERE — it goes into `response`, the same state the
 * editable field is bound to, so fixing a mishearing is the same gesture as
 * fixing a typo and there is only ever one place to look for the sentence.
 * `PracticeSessionPage`'s `SpokenDraft` makes the identical split for the
 * identical reason.
 *
 * What this carries is the one fact the field cannot: how sure the recogniser
 * was. It decides how the confirmation step READS, and nothing else — the
 * server owns the verdict.
 */
interface SpokenDraft {
  /** 0..1, or NULL for "the recogniser did not say". NEVER coerce it to 0. */
  confidence: number | null;
}

/** How the words being submitted were arrived at. Copy only. */
type Source = 'spoken' | 'self';

/**
 * The headline for each outcome.
 *
 * A near miss inside tolerance IS a pass (§2.3: "one word wrong is not a
 * failure"), and `correct`'s line says so with no "but" in it. The diff below
 * shows the slip; the headline does not take the pass back.
 */
const OUTCOME_TITLE: Record<EnglishOutcome, string> = {
  correct: 'You read that sentence.',
  partial: 'Most of that sentence came through.',
  incorrect: 'That one did not come through.',
};

export default function ReadingPracticePage() {
  const isMounted = useIsMounted();

  const [sentence, setSentence] = useState<EnglishSentence | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** The words about to be submitted. Editable, always. */
  const [response, setResponse] = useState('');
  const [spokenDraft, setSpokenDraft] = useState<SpokenDraft | null>(null);
  const [source, setSource] = useState<Source>('spoken');
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const [result, setResult] = useState<EnglishAttemptResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /** The learner said their reading missed words. Recorded nowhere — see header. */
  const [selfMissed, setSelfMissed] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);

  // THE PAGE OWNS THE CAPTURE HOOK, not the button: the recording has to reach
  // an upload this page is responsible for, and a blob trapped inside a button
  // is a blob nothing can send.
  const capture = useAudioCapture();
  const { release: releaseRecording } = capture;
  // THE SINGLE READER of the role's binding state. `transcribeBound` is false
  // while the status is still unknown, which is what makes the microphone
  // appear a beat late rather than appear dead.
  const { transcribeBound } = useVoiceAvailability();

  /**
   * Forget everything belonging to the attempt being abandoned.
   *
   * `releaseRecording()` is in here for the reason `useAudioCapture`'s header
   * gives — that call is the line where the audio stops existing
   * (`docs/specs/voice.md` §4) — and there is deliberately no path that skips
   * it.
   */
  const clearAttemptState = useCallback(() => {
    setResponse('');
    setSpokenDraft(null);
    setSource('spoken');
    setVoiceError(null);
    setTranscribing(false);
    setResult(null);
    setSubmitError(null);
    setSelfMissed(false);
    releaseRecording();
  }, [releaseRecording]);

  const loadSentence = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const { sentence: next } = await getNextEnglishSentence('reading');
      if (!isMounted()) return;
      setSentence(next);
      clearAttemptState();
    } catch (err) {
      if (isMounted()) {
        setLoadError(
          err instanceof Error
            ? err.message
            : 'That reading sentence could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [clearAttemptState, isMounted]);

  useEffect(() => {
    void loadSentence();
    // ONCE. `loadSentence` is stable (its own dependencies are), and this
    // effect releases the recording, so an unstable identity here would be a
    // render loop the profiler blames on React.
  }, [loadSentence]);

  // ---------------------------------------------------------------------------
  // Audio in, text out. NOTHING HERE GRADES ANYTHING.
  // ---------------------------------------------------------------------------

  /**
   * The recording this page has already sent.
   *
   * Keyed on the blob's own identity rather than on a boolean, so a re-render —
   * or a development double-mount — cannot upload the same recording twice and
   * spend the learner's own key on it twice.
   */
  const uploadedRef = useRef<Blob | null>(null);
  const recording = capture.recording;

  useEffect(() => {
    if (!recording || uploadedRef.current === recording) return;
    uploadedRef.current = recording;

    setTranscribing(true);
    setVoiceError(null);

    void (async () => {
      try {
        const { text, confidence } = await transcribeAudio(recording);
        if (!isMounted()) return;

        const heard = text.trim();
        if (!heard) {
          // Not an error the API reports — it is what silence sounds like, and
          // what a tap instead of a hold produces. Saying so beats dropping the
          // learner into a confirmation step over an empty box.
          setVoiceError('Nothing was picked up in that recording.');
          return;
        }

        setResponse(heard);
        setSource('spoken');
        // CONFIDENCE STRAIGHT THROUGH, `null` INCLUDED. Not `?? 0`: unknown is
        // not low, and coercing it would greet every learner on a provider that
        // reports no score with "that may not be what you said" about a
        // transcript nothing was uncertain about.
        setSpokenDraft({ confidence });
      } catch (err) {
        if (!isMounted()) return;
        setVoiceError(
          err instanceof Error
            ? err.message
            : 'That recording could not be turned into text.',
        );
      } finally {
        if (isMounted()) setTranscribing(false);
        // THE AUDIO STOPS EXISTING HERE, on success and on failure alike.
        releaseRecording();
      }
    })();
  }, [isMounted, recording, releaseRecording]);

  // The transcript takes focus the moment it lands, so a learner reading it
  // with a screen reader — or one who just wants to fix a word — is already in
  // the field they need rather than hunting for it.
  useEffect(() => {
    if (spokenDraft) inputRef.current?.focus();
  }, [spokenDraft]);

  // ---------------------------------------------------------------------------
  // Submitting
  // ---------------------------------------------------------------------------

  const trimmed = response.trim();
  /** NULL MEANS UNKNOWN. Read out once, never coalesced to a number. */
  const draftConfidence = spokenDraft?.confidence ?? null;
  const lowConfidence = isLowConfidence(draftConfidence);

  const submit = useCallback(
    async (text: string, from: Source, confidence: number | null) => {
      if (!sentence) return;
      setSubmitting(true);
      setSubmitError(null);
      setSelfMissed(false);
      try {
        const attempt = await recordEnglishAttempt({
          sentenceId: sentence.id,
          responseText: text,
          // OMITTED when the recogniser reported none — ABSENT IS UNKNOWN, and
          // a `0` is a confident-sounding false claim that the recogniser was
          // certain it heard nothing, which the server reads as a mishearing
          // and stamps on a perfectly good reading.
          //
          // Omitted on a SELF-MARK too, and not because it is unknown: no
          // recogniser ran at all, so any value would be a claim about a step
          // that never happened.
          ...(from === 'spoken' && confidence !== null
            ? { asrConfidence: confidence }
            : {}),
          // `replayCount` is deliberately not sent. It belongs to the writing
          // segment — a reading sentence is shown, not dictated — and a
          // non-zero one here is a 400.
        });
        if (isMounted()) {
          setResult(attempt);
          setSource(from);
        }
      } catch (err) {
        if (isMounted()) {
          setSubmitError(
            err instanceof Error
              ? err.message
              : 'That reading could not be recorded.',
          );
        }
      } finally {
        if (isMounted()) setSubmitting(false);
      }
    },
    [isMounted, sentence],
  );

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    void submit(trimmed, 'spoken', draftConfidence);
  };

  /**
   * Throw away what was heard and record again.
   *
   * THE WORDS GO WITH THE RECORDING. Leaving the old transcript in the field
   * under a fresh "hold to record" is how a learner ends up submitting the
   * words they had just asked to replace.
   */
  const handleRecordAgain = () => {
    setSpokenDraft(null);
    setResponse('');
    setVoiceError(null);
    setResult(null);
    setSubmitError(null);
    releaseRecording();
  };

  /** "I read it word for word." See the file header for what this sends. */
  const handleSelfCorrect = () => {
    if (!sentence) return;
    void submit(sentence.text, 'self', null);
  };

  /** "I missed a word." Records nothing, and says so. See the file header. */
  const handleSelfMissed = () => {
    setResult(null);
    setSubmitError(null);
    setSelfMissed(true);
  };

  // ---------------------------------------------------------------------------
  // The states that are not a sentence
  // ---------------------------------------------------------------------------

  const heading = (
    <>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
        Reading practice
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
        Read the sentence out loud, the way you would to an officer. One
        sentence at a time &mdash; in the real interview you only need to read
        one of three correctly.
      </Typography>
      <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />
    </>
  );

  if (isLoading) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box sx={{ py: { xs: 1, sm: 2 } }}>
          {heading}
          <Box role="status" aria-live="polite" aria-label="Loading a sentence">
            <LoadingSpinner />
          </Box>
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        {heading}

        {loadError && (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            action={
              <Button color="inherit" size="small" onClick={() => void loadSentence()}>
                Try again
              </Button>
            }
          >
            {loadError}
          </Alert>
        )}

        {/* MOUNTED UNCONDITIONALLY. It renders null unless `transcribe` is KNOWN
            to be unbound, which is why it can sit here rather than behind a
            condition this page would have to get right — and it is the SHARED
            component naming the role, never a bespoke message. */}
        <VoiceUnavailableNotice feature="Checking your reading out loud" />

        {/* An empty bank is an honest absence, not a failure and not a 404: the
            request was valid and the answer is that no reading sentences are
            loaded here yet. Nothing for the learner to fix, so nothing that
            should interrupt a screen reader as though something had gone
            wrong. */}
        {!loadError && !sentence && (
          <Alert severity="info" role="status">
            There are no reading sentences loaded yet, so there is nothing to
            practise on this screen. Nothing is wrong on your side.
          </Alert>
        )}

        {sentence && (
          <>
            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
              <Typography variant="overline" component="p" color="text.secondary">
                Read this out loud
              </Typography>
              {/* THE PROMPT, and it is meant to be seen — see the file header.
                  `lang="en"` so a screen reader set to another language reads
                  it with English pronunciation rules, on a screen whose whole
                  subject is producing English words. */}
              <Typography
                variant="h5"
                component="h2"
                lang="en"
                sx={{ fontWeight: 600, mt: 0.5, overflowWrap: 'anywhere' }}
              >
                {sentence.text}
              </Typography>

              {sentence.vocabTags.length > 0 && (
                <Stack
                  direction="row"
                  spacing={1}
                  useFlexGap
                  sx={{ flexWrap: 'wrap', mt: 2 }}
                >
                  {sentence.vocabTags.map((tag) => (
                    <Chip key={tag} label={tag} size="small" variant="outlined" />
                  ))}
                </Stack>
              )}

              {submitError && (
                <Alert severity="error" sx={{ mt: 3 }}>
                  {submitError}
                </Alert>
              )}

              {/* ---------------------------------------------------------
                  The voice path.
                  --------------------------------------------------------- */}
              {transcribeBound ? (
                <Box component="form" onSubmit={handleSubmit} sx={{ mt: 3 }}>
                  <PushToTalkButton
                    capture={capture}
                    label="Hold to read aloud"
                    disabled={transcribing || submitting || result !== null}
                  />

                  {/* MOUNTED WITH THE VOICE PATH AND EMPTY UNTIL THERE IS
                      SOMETHING TO SAY — a live region inserted at the same
                      moment as its content is commonly never announced. */}
                  <Box role="status" aria-live="polite" sx={{ mt: 1 }}>
                    {transcribing && (
                      <Typography variant="body2" color="text.secondary">
                        Writing down what you read…
                      </Typography>
                    )}

                    {!transcribing && voiceError && (
                      // NOT MUI's default `role="alert"`: this sits inside the
                      // polite region above, and a live region nested in a live
                      // region is how the same sentence gets read twice.
                      <Alert severity="warning" role="presentation">
                        <AlertTitle>{voiceError}</AlertTitle>
                        <Typography variant="body2">
                          Hold the button and read it again.
                        </Typography>
                      </Alert>
                    )}

                    {/* THE CONFIRMATION STEP. Nothing has been scored at this
                        point and nothing will be until the learner presses the
                        button themselves. The confidence decides the WORDS here
                        and nothing else — the number itself is never rendered,
                        because "41% confident" is a diagnostic detail somebody
                        studying for their interview cannot act on. */}
                    {!transcribing && !voiceError && spokenDraft && !result && (
                      <Alert severity="info" icon={false} role="presentation">
                        <AlertTitle>
                          {lowConfidence
                            ? 'That may not be what you read.'
                            : 'Is this what you read?'}
                        </AlertTitle>
                        <Typography variant="body2">
                          {lowConfidence
                            ? 'Your recording was hard to make out, so this is more likely our mistake than yours. Fix anything that is wrong below, or read it again — nothing has been scored yet.'
                            : 'Check it below and fix anything we got wrong. Nothing is scored until you choose Check my reading.'}
                        </Typography>
                      </Alert>
                    )}
                  </Box>

                  <TextField
                    // A REAL `<label>` — MUI's `label` prop renders one bound to
                    // the input, never a placeholder pretending to be one.
                    label="What you read"
                    value={response}
                    onChange={(event) => setResponse(event.target.value)}
                    inputRef={inputRef}
                    fullWidth
                    multiline
                    autoComplete="off"
                    // Off, deliberately: an autocorrect that "fixes" a word the
                    // learner did not say would put the platform's guess into
                    // the record instead of theirs.
                    spellCheck={false}
                    sx={{ mt: 2 }}
                    // Also disabled while a transcription is in flight: the box
                    // is about to be filled with what they just read, and
                    // typing into it meanwhile would have their words
                    // overwritten without warning.
                    disabled={submitting || result !== null || transcribing}
                    helperText="This is what we heard. Change anything that is wrong — it is scored exactly as it reads here."
                  />

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ mt: 2, alignItems: { xs: 'stretch', sm: 'center' } }}
                  >
                    <Button
                      type="submit"
                      variant="contained"
                      size="large"
                      disabled={!trimmed || submitting || result !== null}
                    >
                      {submitting ? 'Checking…' : 'Check my reading'}
                    </Button>
                    {spokenDraft && !result && (
                      <Button
                        variant="outlined"
                        startIcon={<MicIcon />}
                        onClick={handleRecordAgain}
                        disabled={submitting}
                      >
                        Read it again
                      </Button>
                    )}
                  </Stack>
                </Box>
              ) : (
                /* ---------------------------------------------------------
                   The self-marked path. The screen still works; it just says
                   what it is. See the file header for what each button sends.
                   --------------------------------------------------------- */
                <Box sx={{ mt: 3 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ maxWidth: '60ch' }}>
                    Read the sentence out loud, then tell us how it went. Nobody
                    but you is checking this one, so it is weaker evidence than
                    a recording we could compare word by word &mdash; and your
                    readiness score treats it that way.
                  </Typography>

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ mt: 2, alignItems: { xs: 'stretch', sm: 'center' } }}
                  >
                    <Button
                      variant="contained"
                      size="large"
                      startIcon={<CheckCircleOutlinedIcon />}
                      onClick={handleSelfCorrect}
                      disabled={submitting || result !== null}
                    >
                      {submitting ? 'Recording…' : 'I read it word for word'}
                    </Button>
                    <Button
                      variant="outlined"
                      onClick={handleSelfMissed}
                      disabled={submitting || result !== null}
                    >
                      I missed or changed a word
                    </Button>
                  </Stack>
                </Box>
              )}
            </Paper>

            {/* MOUNTED FROM THE FIRST RENDER AND EMPTY UNTIL THERE IS A
                VERDICT. That ordering is what makes the announcement happen at
                all. Nothing renders into this region but a server result. */}
            <Box
              role="status"
              aria-live="polite"
              // NAMED, unlike the practice screen's equivalent region, because
              // this page has three live regions on it at once: the push-to-talk
              // indicator's, the transcription's, and this one. An unnamed
              // third would leave a screen-reader user with three anonymous
              // "status" landmarks and no way to tell which one holds the
              // result.
              aria-label="Your result"
              sx={{ mt: 3 }}
            >
              {selfMissed && (
                <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
                  <Typography variant="h6" component="h2">
                    Nothing recorded.
                  </Typography>
                  <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
                    Without a recording there is no way to know which words you
                    missed, and a record that guessed would not be a record of
                    anything. Read it again, or move on &mdash; either way this
                    attempt is not on your history as a failure.
                  </Typography>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ mt: 3, alignItems: { xs: 'stretch', sm: 'center' } }}
                  >
                    <Button variant="contained" onClick={() => setSelfMissed(false)}>
                      Read it again
                    </Button>
                    <Button variant="outlined" onClick={() => void loadSentence()}>
                      Next sentence
                    </Button>
                  </Stack>
                </Paper>
              )}

              {result && result.status === 'misheard' && (
                <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
                  {/* NOT AN OUTCOME AND NOT A FAILURE. The row does not exist.
                      `severity="info"` rather than `warning` for exactly that
                      reason: nothing went wrong with the learner's reading, and
                      the screen must not imply that it did. */}
                  <Typography variant="h6" component="h2">
                    We are not sure we heard that correctly.
                  </Typography>
                  <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
                    Your recording was hard to make out, so{' '}
                    <strong>nothing has been recorded</strong> &mdash; this is
                    not on your history as a missed sentence. Here is what we
                    thought we heard. Have another go.
                  </Typography>

                  <Box sx={{ mt: 3 }}>
                    <SentenceDiff
                      diff={result.diff}
                      substitutions={result.substitutions}
                      deletions={result.deletions}
                      insertions={result.insertions}
                    />
                  </Box>

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ mt: 3, alignItems: { xs: 'stretch', sm: 'center' } }}
                  >
                    <Button
                      variant="contained"
                      startIcon={<MicIcon />}
                      onClick={handleRecordAgain}
                    >
                      Read it again
                    </Button>
                    <Button variant="outlined" onClick={() => void loadSentence()}>
                      Try a different sentence
                    </Button>
                  </Stack>
                </Paper>
              )}

              {result && result.status === 'scored' && (
                <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
                  <Typography variant="h6" component="h2">
                    {OUTCOME_TITLE[result.outcome]}
                  </Typography>

                  {source === 'self' && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      Recorded as your own word, not as a checked recording.
                    </Typography>
                  )}

                  <Box sx={{ mt: 3 }}>
                    <SentenceDiff
                      diff={result.diff}
                      substitutions={result.substitutions}
                      deletions={result.deletions}
                      insertions={result.insertions}
                    />
                  </Box>

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ mt: 3, alignItems: { xs: 'stretch', sm: 'center' } }}
                  >
                    <Button
                      variant="contained"
                      size="large"
                      onClick={() => void loadSentence()}
                    >
                      Next sentence
                    </Button>
                    {transcribeBound && (
                      <Button
                        variant="outlined"
                        startIcon={<MicIcon />}
                        onClick={handleRecordAgain}
                      >
                        Read this one again
                      </Button>
                    )}
                  </Stack>
                </Paper>
              )}
            </Box>
          </>
        )}

        <Button
          component={RouterLink}
          to={PRACTICE_PATH}
          startIcon={<ArrowBackIcon />}
          sx={{ mt: 4, ml: -1 }}
        >
          Back to Practice
        </Button>
      </Box>
    </Container>
  );
}
