/**
 * Writing practice (`/practice/writing`) — one sentence at a time, dictated.
 *
 * Issue #147, epic #59 / E10 "Reading and writing tests". The writing half of
 * the naturalization interview's English segments; the reading half is #144
 * (`ReadingPracticePage`) and is deliberately a different screen with the
 * OPPOSITE rule — there the sentence is the prompt and must be shown.
 *
 * =============================================================================
 * THE SENTENCE IS DICTATED AND NEVER SHOWN BEFORE SUBMISSION
 * =============================================================================
 *
 * `docs/specs/english-test.md` §4, in its own words: "showing the sentence
 * silently changes what is being tested, from 'can this learner write English
 * they hear' to 'can this learner copy text,' and the second skill says nothing
 * useful about readiness for the real interview." In the actual interview the
 * officer reads the sentence aloud and the applicant has never seen it written
 * down. A screen that displays it while they type measures typing accuracy
 * against a visible reference and reports the number as English writing
 * ability — so a learner who cannot hold a dictated sentence in their head
 * scores well and is told something false about their readiness.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS A DOM INVARIANT AND NOT A VISUAL ONE, AND HOW IT IS STRUCTURAL
 * -----------------------------------------------------------------------------
 *
 * `GET /api/english/next` returns `sentence.text` for BOTH segments — writing
 * included — on purpose: dictation defaults to the browser's own
 * `speechSynthesis`, which needs the string client-side, and withholding it
 * would leave server-side synthesis as the only way to hear a writing sentence,
 * which §4 forbids as the only way. So the sentence IS in this component's
 * memory from the first render. The discipline is that it never reaches the
 * DOM, and "off-screen", `visibility: hidden`, `opacity: 0`, `type="password"`
 * and a `title`/`aria-label` are all failures of it, not implementations.
 *
 * The invariant is enforced by SHAPE rather than by remembering:
 *
 *   `sentence.text` is referenced EXACTLY ONCE in this file, as the `text` prop
 *   of `<QuestionAudio>` — a component that speaks its text and never renders
 *   it. It appears in no JSX, in no attribute, and in no derived string.
 *
 *   The reveal below reads `result.text` — the server's own echo of the
 *   sentence on the scored attempt, which the API documents as "on a writing
 *   attempt, this is the reveal". `result` cannot exist before a
 *   `POST /api/english/attempts` has returned, so the revealed text is
 *   UNREACHABLE before submission rather than merely un-rendered.
 *
 * That is why a reviewer can check this rule with `grep sentence.text` instead
 * of by reading every branch, and why the test file asserts it against
 * `document.body` rather than against a screenshot.
 *
 * `vocabTags` and `wordCount` are held back for the same reason at one remove.
 * Neither is the sentence, but "MONTHS" or "six words" narrows a dictation the
 * learner is supposed to have caught by ear. The tags are shown after the
 * reveal, where they say which USCIS vocabulary this drilled; the word count is
 * not shown at all, because a length is a scaffold the real interview does not
 * provide.
 *
 * =============================================================================
 * DICTATION IS THE BROWSER'S OWN VOICE, AND `speak` IS AN UPGRADE
 * =============================================================================
 *
 * Exactly the arrangement `docs/specs/voice.md` §2 already locked for reading a
 * civics question aloud, and §4 says so explicitly: this epic is "a second
 * caller of an already-wired role, not a third role". No new role, no new
 * binding, no new degradation table — and no second player, which is why this
 * screen mounts `QuestionAudio` with overridden COPY rather than a dictation
 * component of its own.
 *
 * `premiumVoice` is passed as `!browserSpeech`, which is not an inversion of
 * the preference: with `speechSynthesis` present the browser speaks, for free,
 * with no binding, as §2 requires. The premium route is reached only when the
 * browser has no voice at all — the one case where it is not an upgrade over
 * the default but the only remaining way to hear the sentence.
 *
 * -----------------------------------------------------------------------------
 * NO DICTATION AT ALL: SAY SO, AND SEND THEM TO READING
 * -----------------------------------------------------------------------------
 *
 * No `speechSynthesis` AND `speak` unbound means the exercise cannot run. §4
 * requires that this fail VISIBLY and never degrade into a different, easier
 * exercise wearing the same name — so the screen explains itself in plain
 * language and offers reading practice, which needs no playback to work. The
 * one thing it must never do is show the sentence: that would convert writing
 * practice into copying practice silently, invisibly, and while still calling
 * itself writing practice.
 *
 * This is NOT an `AiNotReady`, and adding one would be a bug. `voice.md` §2 and
 * `VoiceUnavailableNotice`'s own header are explicit that an unbound `speak` is
 * not a degraded state and must never explain itself: the usual cause here is
 * the browser, the deployment is configured correctly, and blaming an
 * administrator for it would be false. There is deliberately no `speakUnbound`
 * in `useVoiceAvailability` for precisely this reason.
 *
 * =============================================================================
 * REPLAYS ARE FREE, COUNTED, AND NEVER SHOWN BACK AS A PENALTY
 * =============================================================================
 *
 * §4: nothing is gated on the count, no limit is enforced, and no outcome
 * changes. It is recorded because needing four repeats is itself a signal about
 * listening comprehension — one for later coaching copy, never one that grades
 * the attempt it is attached to. `VISION.md` line 389 is the rule behind that,
 * and it is the reason this screen shows no counter, no "3 replays used", and
 * no diminishing affordance: penalising replays would punish exactly the
 * honest, information-seeking behaviour (asking to hear it again rather than
 * guessing) the product should want.
 *
 * `replayCount` here is WRITING-ONLY and genuinely ours to send — a non-zero
 * one on a reading attempt is a 400, which is why `ReadingPracticePage` omits
 * the key entirely.
 *
 * WHAT IS COUNTED IS PLAYS THAT ACTUALLY PRODUCED SOUND, via `QuestionAudio`'s
 * `onPlayed`, which fires when audio starts rather than when a button is
 * pressed. A click that was swallowed by an autoplay policy or a failed
 * synthesis is not a replay the learner heard, and counting it would put a
 * claim in the evidence table that never happened. The FIRST play is the
 * dictation itself, so `replayCount = plays - 1` — a learner who heard the
 * sentence once and wrote it down reports zero replays, truthfully.
 *
 * The count belongs to the sentence, and it is reset only when a new one
 * arrives. A resubmit after a failed POST keeps it (they did not hear it
 * again), and there is deliberately no "try this sentence again" after a
 * result: the sentence has been revealed by then, so a second go at it would be
 * copying practice, which is the whole thing this screen exists to prevent.
 *
 * =============================================================================
 * THE INPUT DOES NOT LET THE PLATFORM WRITE THE ANSWER
 * =============================================================================
 *
 * `spellcheck`, `autocorrect`, `autocapitalize` and `autocomplete` are all off,
 * on the real `<textarea>` (through `slotProps.htmlInput`, which lands on the
 * element — not on the wrapper, where an assertion would pass and a browser
 * would ignore it). §4: each of the four would let the platform silently
 * correct, capitalise or suggest text the learner did not produce, and the
 * result would grade the platform's assistance. It is the "assisted evidence is
 * weaker evidence" principle `readiness-model.md` §2.2 states for civics hints,
 * applied at the affordance level instead of the scoring level — because unlike
 * a hint button, a spellchecker's correction is not a visible event that could
 * be filtered out afterwards. It has to be prevented from happening.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
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
import { READING_PRACTICE_PATH } from '../components/english/paths';
import {
  QuestionAudio,
  browserSpeechAvailable,
} from '../components/voice/QuestionAudio';
import { useIsMounted } from '../hooks/useIsMounted';
import { useVoiceAvailability } from '../hooks/useVoiceAvailability';
import { getNextEnglishSentence, recordEnglishAttempt } from '../services/api';
import type {
  EnglishAttemptScored,
  EnglishOutcome,
  EnglishSentence,
} from '../types';

/** `/practice`, spelled once. */
const PRACTICE_PATH = '/practice';

/**
 * The headline for each outcome.
 *
 * A near miss inside tolerance IS a pass — §2.3's rule is compound and the
 * server has already applied it — so `correct`'s line has no "but" in it. The
 * diff below names the slip; the headline does not take the pass back.
 */
const OUTCOME_TITLE: Record<EnglishOutcome, string> = {
  correct: 'You wrote that sentence.',
  partial: 'Most of that sentence came through.',
  incorrect: 'That one did not come through.',
};

export default function WritingPracticePage() {
  const isMounted = useIsMounted();

  const [sentence, setSentence] = useState<EnglishSentence | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** What the learner typed. The only text on this screen before the reveal. */
  const [response, setResponse] = useState('');

  /**
   * How many times the sentence was ACTUALLY SPOKEN for this attempt.
   *
   * Not "how many times play was pressed" — see the file header. The first play
   * is the dictation; everything after it is a replay.
   */
  const [playCount, setPlayCount] = useState(0);

  /**
   * The scored attempt, NARROWED.
   *
   * `EnglishAttemptResult` is a union, but its `misheard` arm cannot reach this
   * screen: that arm is gated on a reading attempt with a low `asrConfidence`
   * (`isMisheardReading`, `english.service.ts`), and a writing attempt carrying
   * an `asrConfidence` at all is rejected as a 400 before scoring — a typed
   * answer has no recogniser to be unsure of. Narrowing here rather than in the
   * JSX keeps the reveal's type honest and puts the impossible case in exactly
   * one place, where it is handled rather than assumed away.
   */
  const [result, setResult] = useState<EnglishAttemptScored | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Can anything speak?
  // ---------------------------------------------------------------------------

  const browserSpeech = browserSpeechAvailable();
  // THE SINGLE READER of the role's binding state. `speakBound` is false while
  // the status is still unknown, which is the safe direction everywhere else in
  // this codebase — but here it is the difference between an exercise and an
  // apology, so `isLoading` below keeps the apology from being printed early.
  const { speakBound, isLoading: aiStatusLoading } = useVoiceAvailability();

  /** The browser can speak, or the deployment's premium voice can. */
  const canDictate = browserSpeech || speakBound;
  /**
   * We do not yet know whether anything can speak.
   *
   * Only reachable on a browser with no `speechSynthesis`, because otherwise
   * `canDictate` is already true and `speak`'s binding cannot change that.
   * Waiting matters: `speakBound` is false while the status request is in
   * flight, so rendering the unavailable screen immediately would flash "this
   * browser cannot read the sentence aloud" at a learner on a deployment where
   * it can — a message that is not merely noisy but false, the same failure
   * `useVoiceAvailability` documents for `transcribeUnbound`.
   */
  const dictationUnknown = !browserSpeech && aiStatusLoading;

  // ---------------------------------------------------------------------------
  // Loading a sentence
  // ---------------------------------------------------------------------------

  const clearAttemptState = useCallback(() => {
    setResponse('');
    setPlayCount(0);
    setResult(null);
    setSubmitError(null);
  }, []);

  const loadSentence = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const { sentence: next } = await getNextEnglishSentence('writing');
      if (!isMounted()) return;
      setSentence(next);
      clearAttemptState();
    } catch (err) {
      if (isMounted()) {
        setLoadError(
          err instanceof Error
            ? err.message
            : 'That writing sentence could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [clearAttemptState, isMounted]);

  useEffect(() => {
    // NOT ASKED FOR WHEN NOTHING COULD DICTATE IT. The response would be a
    // sentence this screen is forbidden to display and unable to speak — and
    // holding one in memory with no way to use it is the state a later "just
    // show it" patch is written from.
    if (!canDictate) return;
    void loadSentence();
  }, [canDictate, loadSentence]);

  // ---------------------------------------------------------------------------
  // Submitting
  // ---------------------------------------------------------------------------

  const trimmed = response.trim();
  const replayCount = Math.max(0, playCount - 1);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sentence || !trimmed) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const attempt = await recordEnglishAttempt({
        sentenceId: sentence.id,
        // WHAT THEY TYPED, trimmed of surrounding whitespace and nothing else.
        // No capitalisation fix, no punctuation fix, no spelling fix: the
        // scorer normalises both sides itself (§2.1) and a client that
        // "helped" first would be grading its own correction.
        responseText: trimmed,
        // OURS TO SEND, unlike on the reading screen. See the file header for
        // what is counted and why nothing is gated on it.
        replayCount,
        // `asrConfidence` is deliberately absent: nothing was transcribed, and
        // sending one on a writing attempt is a 400 — correctly, because it
        // would be a measurement of a step that never happened.
      });
      if (!isMounted()) return;

      if (attempt.status !== 'scored') {
        // STRUCTURALLY UNREACHABLE — see `result`'s own note. Handled anyway,
        // and handled as "nothing was saved", because that is what the arm
        // means: no `english_attempts` row exists. Silently dropping it would
        // leave the learner staring at a button that did nothing.
        setSubmitError(
          'That answer was not recorded. Nothing has been saved — please try again.',
        );
        return;
      }
      setResult(attempt);
    } catch (err) {
      if (isMounted()) {
        setSubmitError(
          err instanceof Error
            ? err.message
            : 'That answer could not be recorded.',
        );
      }
    } finally {
      if (isMounted()) setSubmitting(false);
    }
  };

  /**
   * The dictation button's wording.
   *
   * Memoised on the play count alone so the object identity changes only when
   * the label actually does. "Play it again" is an AFFORDANCE, not a counter:
   * it never says how many times, and it never gets discouraging — see the
   * file header on why a replay must cost nothing, visually included.
   */
  const audioCopy = useMemo(
    () => ({
      play: playCount === 0 ? 'Play the sentence' : 'Play it again',
      stop: 'Stop',
      preparing: 'Getting the voice ready…',
      speaking: 'Reading the sentence aloud.',
      // NEVER "the text is above". It is not above, and it must not be.
      unavailable:
        'The sentence could not be played just now. Try again in a moment.',
    }),
    [playCount],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const heading = (
    <>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
        Writing practice
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
        You hear a sentence and write down what you heard &mdash; the way the
        interview works, where the officer reads it out and you have never seen
        it written. The sentence stays hidden until you have answered.
      </Typography>
      <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />
    </>
  );

  // Still finding out whether anything can speak. See `dictationUnknown`.
  if (dictationUnknown) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box sx={{ py: { xs: 1, sm: 2 } }}>
          {heading}
          <Box role="status" aria-live="polite" aria-label="Getting ready">
            <LoadingSpinner />
          </Box>
        </Box>
      </Container>
    );
  }

  // -------------------------------------------------------------------------
  // Nothing can dictate. Say so; never substitute the easier exercise.
  // -------------------------------------------------------------------------
  if (!canDictate) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box sx={{ py: { xs: 1, sm: 2 } }}>
          {heading}

          {/* `info`, not `error` or `warning`: nothing is broken and nothing is
              the learner's fault. This is a designed absence stated plainly —
              the idiom `civics-content.md` §5 and `journey-shell.md` §10
              already use — and `role="status"` rather than `alert` so it is not
              announced as though something had gone wrong. */}
          <Alert severity="info" role="status">
            <AlertTitle>
              This browser cannot read the sentence out loud.
            </AlertTitle>
            <Typography variant="body2" sx={{ maxWidth: '60ch' }}>
              Writing practice is dictated: you hear the sentence and write it
              down. We will not show you the sentence instead &mdash; copying a
              sentence you can see is a different, easier task, and it would
              tell you nothing about how you will do in the interview.
            </Typography>
            <Typography variant="body2" sx={{ mt: 1.5, maxWidth: '60ch' }}>
              Reading practice works here without any sound, and it is the other
              half of the same English test.
            </Typography>
          </Alert>

          <Button
            component={RouterLink}
            to={READING_PRACTICE_PATH}
            variant="contained"
            size="large"
            startIcon={<MenuBookOutlinedIcon />}
            sx={{ mt: 3, width: { xs: '100%', sm: 'auto' } }}
          >
            Practise reading instead
          </Button>

          <Box>
            <Button
              component={RouterLink}
              to={PRACTICE_PATH}
              startIcon={<ArrowBackIcon />}
              sx={{ mt: 4, ml: -1 }}
            >
              Back to Practice
            </Button>
          </Box>
        </Box>
      </Container>
    );
  }

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

        {/* An empty bank is an honest absence, not a failure and not a 404: the
            request was valid and the answer is that no writing sentences are
            loaded here yet. */}
        {!loadError && !sentence && (
          <Alert severity="info" role="status">
            There are no writing sentences loaded yet, so there is nothing to
            practise on this screen. Nothing is wrong on your side.
          </Alert>
        )}

        {sentence && (
          <>
            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
              <Typography variant="overline" component="h2" color="text.secondary">
                Listen, then write what you heard
              </Typography>

              {/* THE ONLY REFERENCE TO `sentence.text` IN THIS FILE, and it is
                  a prop of a component that speaks its text and renders none of
                  it. See the file header: everything the learner reads after
                  submitting comes from `result.text` instead, which does not
                  exist until the server has scored the attempt. */}
              <Box sx={{ mt: 1 }}>
                <QuestionAudio
                  text={sentence.text}
                  size="large"
                  copy={audioCopy}
                  // The premium voice ONLY when the browser has none — the
                  // browser-first preference of `voice.md` §2 is preserved, and
                  // the paid route is the last way to hear it rather than the
                  // first. See the file header.
                  premiumVoice={!browserSpeech}
                  // ACTUALLY SPOKEN, not "play was pressed".
                  onPlayed={() => setPlayCount((n) => n + 1)}
                />
              </Box>

              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: '60ch' }}>
                Play it as many times as you need. Replays cost you nothing
                &mdash; they never change your result.
              </Typography>

              <Box component="form" onSubmit={handleSubmit} sx={{ mt: 3 }}>
                <TextField
                  // A REAL `<label>`: MUI's `label` prop renders one bound to
                  // the field, never a placeholder pretending to be one.
                  label="What you heard"
                  value={response}
                  onChange={(event) => setResponse(event.target.value)}
                  fullWidth
                  multiline
                  minRows={2}
                  disabled={submitting || result !== null}
                  // ALL FOUR OFF, ON THE REAL ELEMENT. `slotProps.htmlInput`
                  // lands on the `<textarea>` itself; the same names on the
                  // TextField wrapper would satisfy a careless test and be
                  // ignored by every browser. See the file header for why each
                  // one of the four is disqualifying rather than untidy.
                  slotProps={{
                    htmlInput: {
                      autoComplete: 'off',
                      autoCorrect: 'off',
                      autoCapitalize: 'off',
                      spellCheck: false,
                    },
                  }}
                  helperText="Spelling and capitalisation are not judged, so write it the way you heard it."
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
                    {submitting ? 'Checking…' : 'Check my writing'}
                  </Button>
                </Stack>
              </Box>

              {submitError && (
                <Alert severity="error" sx={{ mt: 3 }}>
                  {submitError}
                </Alert>
              )}
            </Paper>

            {/* MOUNTED FROM THE FIRST RENDER AND EMPTY UNTIL THERE IS A
                VERDICT — that ordering is what makes the announcement happen at
                all. NAMED, because `QuestionAudio` brings its own polite region
                to this page and two anonymous "status" landmarks would leave a
                screen-reader user unable to tell which one holds the result. */}
            <Box
              role="status"
              aria-live="polite"
              aria-label="Your result"
              sx={{ mt: 3 }}
            >
              {result && (
                <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
                  <Typography variant="h6" component="h2">
                    {OUTCOME_TITLE[result.outcome]}
                  </Typography>

                  {/* THE FIRST AND ONLY TIME THE SENTENCE IS ON SCREEN, and it
                      is the SERVER'S copy of it (`result.text`), which exists
                      only because an attempt was scored. `lang="en"` so a
                      screen reader set to another language reads it with
                      English pronunciation rules — on a screen whose whole
                      subject is English words, that is not cosmetic. */}
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="overline" component="p" color="text.secondary">
                      The sentence was
                    </Typography>
                    <Typography
                      lang="en"
                      sx={{
                        fontWeight: 600,
                        fontSize: '1.125rem',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {result.text}
                    </Typography>
                  </Box>

                  <Box sx={{ mt: 3 }}>
                    <SentenceDiff
                      diff={result.diff}
                      substitutions={result.substitutions}
                      deletions={result.deletions}
                      insertions={result.insertions}
                    />
                  </Box>

                  {/* AFTER THE REVEAL ONLY. Before it, a tag like "MONTHS"
                      narrows a sentence the learner is meant to catch by ear.
                      Here it says which USCIS vocabulary this drilled. */}
                  {sentence.vocabTags.length > 0 && (
                    <Stack
                      direction="row"
                      spacing={1}
                      useFlexGap
                      sx={{ flexWrap: 'wrap', mt: 3 }}
                    >
                      {sentence.vocabTags.map((tag) => (
                        <Chip key={tag} label={tag} size="small" variant="outlined" />
                      ))}
                    </Stack>
                  )}

                  {/* ONE ACTION, AND IT IS A NEW SENTENCE. There is no "try
                      this one again": the sentence is on the screen now, so a
                      second attempt at it would be copying practice — the exact
                      substitution this whole screen exists to prevent. */}
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
