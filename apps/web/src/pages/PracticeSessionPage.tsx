/**
 * Practice session (`/practice/sessions/:id`) — one question at a time.
 *
 * Issue #79, epic #52. The screen where a learner **produces** an answer
 * instead of recognizing one, which is the entire reason E3 exists as its own
 * step: `/learn` (E2) is `VISION.md`'s "See it → Understand it", deliberately
 * before any recall, and this is the first place recall is asked for.
 *
 * =============================================================================
 * THE ONE CONSTRAINT THIS WHOLE SCREEN IS BUILT AROUND
 * =============================================================================
 *
 * **THE ACCEPTED ANSWERS MUST NOT BE ANYWHERE ON THIS PAGE — not in the visible
 * layout, not in a hidden element, not in a collapsed panel, not in a prefetched
 * response sitting in a state variable — until the learner has submitted,
 * skipped, or asked to see them.**
 *
 * If the answer is in the page while the learner is typing, the exercise stops
 * being recall and becomes recognition: the learner reads the answer, types it,
 * and the evidence table records that they knew it. `VISION.md` puts the cost
 * plainly — recognition is not preparation — and the damage is invisible from
 * inside the product, because every screen still looks right, every test still
 * passes, and the readiness number that comes out of E6 is computed from
 * attempts that measured nothing.
 *
 * Three things keep it true, and all three have to stay:
 *
 *  1. **The API is built for it.** `nextQuestion` is a `PracticeQuestion`:
 *     `id`, `number`, `prompt`, `categoryId`, `dynamicScope`, and nothing else.
 *     `apps/api/src/practice/dto/practice-question.dto.ts` carries a
 *     compile-time proof that no answer-shaped field can be added to it.
 *  2. **This page never asks for a question detail.** There is no
 *     `getCivicsQuestion(id)` here, and there must not be one — not "to show
 *     the category", not "to prefetch the next card", not to render a hint.
 *     That call returns the resolved answers; making it is how the answers get
 *     into the browser one render before they are earned.
 *  3. **`AttemptFeedback` cannot be rendered without a graded attempt.** It
 *     takes a `PracticeAttemptResult` and nothing else, so there is no props
 *     shape in which this page could hand it answers early. The answers reach
 *     the DOM at the same moment the attempt row exists in the database.
 *
 * A reviewer asked to "just render the answer behind a `display: none` so the
 * reveal is instant" should decline and point here: the DOM is the page, and an
 * answer a learner can find with View Source or a screen reader's browse mode
 * is an answer that is on the screen.
 *
 * =============================================================================
 * THREE WAYS TO END A QUESTION, AND WHY "SHOW ME THE ANSWER" IS ONE OF THEM
 * =============================================================================
 *
 *   * **Submit** — the cold attempt. `{ responseText, durationMs }`.
 *   * **Show me the answer** — `{ responseText?, revealed: true, durationMs }`.
 *     It still submits whatever is typed, so a learner who half-knew it is
 *     still graded on their words rather than losing them.
 *   * **Skip** — `{ skipped: true }`. Recorded, never dropped: a skip is what
 *     "I have no idea" looks like, and discarding it would leave the readiness
 *     model unable to tell a question a learner keeps avoiding from one they
 *     have never been shown.
 *
 * All three write exactly one immutable `practice_attempts` row, and all three
 * come back with `acceptedAnswers`. The API returns the answers with every
 * grade on purpose — immediate feedback in one round trip — which is why
 * `revealed` is NOT set on an ordinary submit even though the answers appear a
 * moment later.
 *
 * That distinction is worth defending, because setting `revealed: true` on
 * every submit is the obvious shortcut and it would be a quiet disaster:
 * `revealed` is how E5 learns that a correct answer was produced cold rather
 * than copied, `summary.revealed` would become equal to `summary.answered` on
 * every session ever recorded, and the signal would be gone from the evidence
 * table with nothing in the schema to notice. The flag means what its DTO says
 * it means — "the learner had the accepted answer in front of them **for this
 * question**" — and on a cold submit they did not.
 *
 * The consequence is that the self-mark control appears after **Show me the
 * answer** and not after a cold submit, because that is exactly where the API
 * accepts it (a 409 otherwise). `AttemptFeedback` explains that trade-off from
 * the other side, and says the one quiet sentence that keeps the absence from
 * looking like the product refusing to listen.
 *
 * =============================================================================
 * ANSWERING OUT LOUD: HEAR IT → SAY IT → GRADE IT → CORRECT IT
 * =============================================================================
 *
 * Issue #104, epic #58 / E9, amended by issue #286, epic #280 / E12
 * (`docs/specs/voice-hands-free.md` §1). The loop above gains one input method,
 * and the shape of that method changed once, deliberately, on the record.
 *
 * **E9 shipped CONFIRM-THEN-GRADE.** The transcript arrived, the learner read
 * it in the "Your answer" field, edited anything wrong, and pressed Submit
 * themselves. That step was the only mechanism in the product keeping
 * `VISION.md` line 228's promise that a learner is never "unfairly penalized
 * for accent or speech-recognition errors": grade a raw transcript
 * automatically and a learner who KNEW the answer and was misheard has a
 * permanent `incorrect` row in the one table E5, E6, E7 and E8 all read as
 * fact.
 *
 * **E12 ships GRADE-THEN-CORRECT, and it is only safe because the guarantee
 * moved rather than went away.** `VISION.md` line 230 — "The user should feel
 * like they are speaking with a patient human coach, not operating a voice
 * command interface" — is what four deliberate actions per question (press,
 * speak, release, read-and-press-again) was failing. So the transcript is now
 * graded the instant it arrives, and the correction happens AFTER the verdict
 * instead of before it. What makes that fair is not this page: issue #285
 * added `AttemptGradingService.recomputeMasteryForQuestion`, which REPLAYS a
 * question's whole mastery history over its non-superseded attempts whenever a
 * retry is written, so a corrected attempt costs the learner exactly zero —
 * `voice-hands-free.md` §2 and its worked example in §2.1. Without that server
 * change this file's auto-submit would be precisely the harm E9 forbade.
 *
 * Six decisions follow, and each prevents a specific failure:
 *
 *  1. **Voice and text are a toggle, and switching is free.** The session, the
 *     questions already answered and the progress counter all live on the
 *     server (see the section below), so flipping the toggle changes which
 *     control renders and NOTHING else. A learner whose microphone dies
 *     mid-session, or who gets on a bus, keeps everything.
 *  2. **The question can be READ ALOUD on every deployment.** `QuestionAudio`
 *     is never gated on the `speak` role — the browser's own voice needs no
 *     model, no key and no admin (`docs/specs/voice.md` §2). It reports when
 *     audio ACTUALLY started, which is what makes `promptMode: 'heard'` a fact
 *     rather than a claim that a button was pressed.
 *  3. **Low confidence changes the WORDS, never the flow.** It reads as a
 *     stronger invitation to check what was heard; it does not decide whether
 *     grading happened, and it never did decide an outcome. The verdict is
 *     still the server's: it writes `failureCause: 'misheard'` from the
 *     confidence this page reported, after grading. THE RAW NUMBER IS NEVER
 *     SHOWN — "41% confident" is a diagnostic detail somebody studying for
 *     their naturalization interview has no way to act on, and every way to
 *     misread.
 *  4. **AN EMPTY TRANSCRIPT IS NEVER SUBMITTED, on either setting.** `text: ''`
 *     is a `status: 'ok'` success (`ai-speech.dto.ts`) — it is what silence
 *     sounds like — and auto-submitting it would record a failure at a question
 *     the learner never actually answered.
 *  5. **Any spoken attempt can be corrected, once.** Not only a misheard one:
 *     `voice-hands-free.md` §2 is explicit that a confidently-wrong transcript
 *     is exactly the case auto-submit creates and E9's `misheard` rule cannot
 *     see. The correction is a NEW attempt carrying `retryOfAttemptId`; the
 *     original stays in the table as evidence, the server excludes it from
 *     `answered` so the pair counts as one question, and `requireRetryTarget`
 *     caps the chain at two — so this page must not offer a second correction
 *     of an attempt that is already a retry. This product does not delete
 *     evidence to make a number look better.
 *  6. **The confirm step is the OPT-OUT, not a deleted screen.**
 *     `voice.autoSubmitSpoken` (default `true`, `useVoicePrefs`) governs one
 *     branch of the transcription effect. Set to `false`, E9's flow runs
 *     unchanged, byte for byte, which is the whole point of it being a
 *     preference.
 *
 * The microphone is ABSENT, not disabled, when `transcribe` is unbound —
 * `VoiceUnavailableNotice` explains that state and is mounted unconditionally
 * because it renders nothing unless the role is KNOWN to be unbound. It is not
 * the same message as the app-wide `AiNotReady`, and the two are never merged.
 *
 * =============================================================================
 * RELOADING MID-SESSION RESUMES FROM THE SERVER
 * =============================================================================
 *
 * Every fact on this screen comes from `GET /api/practice/sessions/:id` —
 * which question is next, how many are answered, how many were planned. Nothing
 * is carried through `navigate(..., { state })`, nothing is counted in the
 * browser, and no attempt is buffered locally. So a reload, a crash, a closed
 * tab or a second tab all resume at the same place with every recorded attempt
 * intact, and two tabs cannot disagree about the count. `usePracticeSession`'s
 * header has the full argument.
 *
 * =============================================================================
 * WHAT THIS PAGE IS NOT
 * =============================================================================
 *
 * It is not a settings surface, so `CLAUDE.md`'s Settings UI Pattern — the
 * registry entry in `ADMIN_SECTIONS` / `USER_SETTINGS_SECTIONS`, the
 * `SettingsHub` binding, the permission string mirrored from a controller —
 * does not apply to it, and adding a card for it would be wrong rather than
 * thorough. `/practice` is a BAR DESTINATION, already declared in
 * `config/destinations.ts` by E1 (#69); `owns('/practice', …)` covers this
 * route and its summary sibling with no new entry, which is why
 * `destinations.test.ts` keeps passing as these routes are added.
 *
 * =============================================================================
 * ACCESSIBILITY AND WIDTH
 * =============================================================================
 *
 * One `h1` (the destination), the question prompt as the `h2` under it, and the
 * feedback's "Accepted answer" label as the `h3` under that. The answer field
 * has a real `<label>` (MUI's `TextField label`), and it takes focus on every
 * new question so a keyboard or screen-reader user is never hunting for where
 * to type. The verdict lands inside a `role="status"` region that is MOUNTED
 * FROM THE FIRST RENDER and only ever has its contents changed — a live region
 * inserted at the same moment as its content is commonly missed entirely by
 * assistive technology.
 *
 * Mobile-first, and every responsive value steps at `sm` (600px), never `md`.
 * None of `CLAUDE.md`'s five coupled gates is touched here; this page only
 * agrees with them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import MicIcon from '@mui/icons-material/Mic';
import { Link as RouterLink, Navigate, useNavigate, useParams } from 'react-router-dom';

import { AttemptFeedback } from '../components/practice/AttemptFeedback';
import { AiNotReady } from '../components/ai/AiNotReady';
import { AI_KEY_SETTINGS_PATH, ExplainPanel } from '../components/ai/ExplainPanel';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { PushToTalkButton } from '../components/voice/PushToTalkButton';
import { QuestionAudio } from '../components/voice/QuestionAudio';
import { VoiceUnavailableNotice } from '../components/voice/VoiceUnavailableNotice';
import { isLowConfidence } from '../components/voice/confidence';
import { useOptionalAiStatus } from '../contexts/AiStatusContext';
import { usePracticeSession } from '../hooks/usePracticeSession';
import { useAudioCapture } from '../hooks/useAudioCapture';
import { useIsMounted } from '../hooks/useIsMounted';
import { useVoiceAvailability } from '../hooks/useVoiceAvailability';
import { useVoicePrefs } from '../hooks/useVoicePrefs';
import {
  ApiError,
  completePracticeSession,
  recordPracticeAttempt,
  selfMarkPracticeAttempt,
  transcribeAudio,
} from '../services/api';
import type {
  AiUnavailableCause,
  PracticeAttemptResult,
  PracticeProgress,
  PracticeQuestion,
  PracticeSessionDetail,
  RecordPracticeAttemptInput,
} from '../types';
import { sessionKindLabel } from '../components/practice/outcome';

/** The three ways to end a question, for disabling the right control. */
type Pending = 'answer' | 'reveal' | 'skip' | 'complete' | null;

/**
 * Which control the learner is answering with.
 *
 * PRESENTATION ONLY. Nothing about the session — the questions already
 * answered, the progress counter, the attempt rows — lives in or below this
 * value, so flipping it can never lose any of them. What the attempt actually
 * records is `inputMode`, which is decided at submit time from whether the
 * text in the field came from the microphone; see {@link SpokenDraft}.
 */
type AnswerMode = 'text' | 'voice';

/**
 * What the microphone produced, waiting to be confirmed.
 *
 * THE TEXT IS NOT IN HERE. It goes into `response` — the same state the "Your
 * answer" field has always been bound to — so the transcript is editable
 * through a control that already has a real `<label>`, and fixing a mishearing
 * is the same gesture as fixing a typo. Two fields (one to read, one to type
 * in) would be two places to look for the same sentence, and the second is
 * where a learner's correction would go unnoticed.
 *
 * What this carries is the one fact the field cannot: how sure the recogniser
 * was. It decides how the confirmation step READS, and nothing else.
 */
interface SpokenDraft {
  /** 0..1, or NULL for "the recogniser did not say". NEVER coerce it to 0. */
  confidence: number | null;
}

/**
 * The voice fields for one attempt, assembled in ONE place.
 *
 * A MODULE-LEVEL PURE FUNCTION rather than a closure over the page's state,
 * because since #286 there are three callers and one of them runs from inside
 * an async continuation where the state has not been committed yet: the
 * auto-submit branch grades the transcript in the same tick it arrives, so
 * `response`/`spokenDraft` still hold what they held before it landed. A
 * closure would read stale values there and post `inputMode: 'typed'` with no
 * transcript for an answer the learner spoke.
 *
 * The server rejects a body whose fields contradict each other, and every one
 * of those 400s would be a refusal the learner could not have avoided or
 * understood. So the rules are mirrored here rather than left to three call
 * sites to remember:
 *
 *   * `transcript` and `asrConfidence` ride ONLY with `inputMode: 'spoken'`
 *   * a spoken attempt that was answered ALWAYS carries its `transcript`
 *   * a skip carries neither, whichever control the learner was using
 *   * `asrConfidence` is OMITTED when the recogniser reported none — ABSENT IS
 *     UNKNOWN, and a `0` would be a confident-sounding false claim that the
 *     recogniser was certain it heard nothing, which the server reads as a
 *     mishearing and stamps on a perfectly good answer
 *
 * `promptMode` is sent on every attempt including a skip: how the question
 * reached the learner is true whether or not they answered it.
 */
function voiceAttemptFields(args: {
  /** Audio ACTUALLY played, not "the button was pressed". */
  promptWasHeard: boolean;
  /**
   * The words about to be graded when they came from the microphone, or `null`
   * for a typed answer and for every skip.
   *
   * NULL IS THE `typed` SIGNAL. A learner who spoke, read the transcript,
   * cleared the box and typed something else is a TYPED attempt —
   * `record-attempt.dto.ts` uses exactly that example to explain why
   * `inputMode` is RECORDED rather than derived from "is there a transcript?".
   */
  spokenText: string | null;
  /** 0..1 or `null`. Only ever sent with `spokenText`. */
  confidence: number | null;
  /** The attempt this one supersedes, or `null`. */
  retryOf: string | null;
}): Pick<
  RecordPracticeAttemptInput,
  'inputMode' | 'promptMode' | 'transcript' | 'asrConfidence' | 'retryOfAttemptId'
> {
  return {
    promptMode: args.promptWasHeard ? 'heard' : 'read',
    ...(args.spokenText
      ? {
          inputMode: 'spoken' as const,
          // The text that was GRADED, exactly as the learner left it — which
          // on the auto-submit path is the recogniser's own output (nothing
          // edited it before grading ran) and on the confirm path is whatever
          // they confirmed. `voice-hands-free.md` §3 narrows `transcript` to
          // exactly that, on every path, with no second column to say which.
          transcript: args.spokenText,
          ...(args.confidence !== null ? { asrConfidence: args.confidence } : {}),
        }
      : { inputMode: 'typed' as const }),
    ...(args.retryOf ? { retryOfAttemptId: args.retryOf } : {}),
  };
}

/** `/practice/sessions/:id/summary` for one id, spelled once. */
export function practiceSummaryPath(sessionId: string): string {
  return `/practice/sessions/${sessionId}/summary`;
}

export default function PracticeSessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const { detail, isLoading, error, refresh } = usePracticeSession(id);

  // The question on screen and the count beside it. Seeded from the server's
  // answer and then advanced from each attempt result — which carries both, so
  // the count is never incremented in the browser.
  const [question, setQuestion] = useState<PracticeQuestion | null>(null);
  const [progress, setProgress] = useState<PracticeProgress | null>(null);
  const [response, setResponse] = useState('');
  const [result, setResult] = useState<PracticeAttemptResult | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selfMarkError, setSelfMarkError] = useState<string | null>(null);
  const [selfMarking, setSelfMarking] = useState(false);

  // ---------------------------------------------------------------------------
  // Voice (issue #104, epic #58 / E9). See the file header.
  // ---------------------------------------------------------------------------

  // THE PAGE OWNS THE CAPTURE HOOK, not the button. `PushToTalkButton`'s own
  // props say why: the recording has to reach an upload this page is
  // responsible for, and a blob trapped inside a button is a blob nothing can
  // send.
  const capture = useAudioCapture();
  const { release: releaseRecording } = capture;
  // THE SINGLE READER of the voice roles' binding state. Not `useAiStatus()`
  // and not `unboundRoles` directly — `transcribeBound` is false while the
  // status is still unknown, which is what makes the microphone appear a beat
  // late rather than appear dead.
  const { transcribeBound } = useVoiceAvailability();

  // The learner's own voice preferences (#288, epic #280), read through the
  // SAME `useUserSettings` the rest of the app uses — see `useVoicePrefs`.
  // Resolved to the built-in defaults until the settings read lands, so the
  // question is readable from the first paint rather than after a round trip.
  const { voice: voicePrefs, isLoading: voicePrefsLoading } = useVoicePrefs();
  /**
   * Optional on purpose, exactly as in `ExplainPanel`: this page must not blank
   * out when the status provider is absent (a test rendering it in isolation,
   * a future embed). Used for one thing only — re-reading the status after the
   * server has just contradicted it; see the effect below.
   */
  const aiStatus = useOptionalAiStatus();

  /** Which control the learner is using RIGHT NOW. Never resets the session. */
  const [answerMode, setAnswerMode] = useState<AnswerMode>('text');
  /** The question was ACTUALLY spoken to them — `promptMode: 'heard'`. */
  const [promptWasHeard, setPromptWasHeard] = useState(false);
  /** A transcription request is in flight. */
  const [transcribing, setTranscribing] = useState(false);
  /** A transcription that was ATTEMPTED and failed, said in the learner's terms. */
  const [voiceError, setVoiceError] = useState<string | null>(null);
  /**
   * A transcription that was NEVER ATTEMPTED, and why (issue #277).
   *
   * SEPARATE FROM `voiceError` BECAUSE IT IS NOT AN ERROR. An unbound
   * `transcribe`, a master switch an administrator turned off, or a missing key
   * of the learner's own are all states in which nothing broke and nothing was
   * spent — `docs/specs/voice.md` §1 calls a deployment with no voice roles
   * bound a NORMAL installation. Folding it into `voiceError` would put it in
   * the amber "hold the button and say it again" alert, which asks a learner to
   * retry something that cannot succeed and implies their recording was at
   * fault.
   */
  const [voiceUnavailable, setVoiceUnavailable] =
    useState<AiUnavailableCause | null>(null);
  /** Set while the text in the answer field CAME FROM the microphone. */
  const [spokenDraft, setSpokenDraft] = useState<SpokenDraft | null>(null);
  /** The attempt the next submission supersedes, once a retry is taken up. */
  const [retryOf, setRetryOf] = useState<string | null>(null);
  /**
   * The learner is correcting what was heard, and this is what they have typed.
   *
   * `null` MEANS "NOT CORRECTING" — the correction card renders its invitation
   * rather than its field. A separate boolean beside the text would be a second
   * representation of the same fact, free to disagree with it.
   *
   * It is deliberately NOT `response`: after grading, the answer field above
   * still holds (disabled) the words that were graded, and binding both to one
   * state would leave two controls labelled for the same sentence with only one
   * of them editable — which is where a learner's correction goes unnoticed.
   */
  const [correction, setCorrection] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  /** When the question on screen was first shown, for an honest `durationMs`. */
  const askedAtRef = useRef<number | null>(null);

  /**
   * Forget everything that belonged to the question being left behind.
   *
   * One function rather than four call sites, because what it prevents is
   * silent: a `spokenDraft` that survived into the next question would make
   * the NEXT answer report `inputMode: 'spoken'` with a transcript of the
   * previous question's words, and nothing on screen would look wrong.
   *
   * `releaseRecording()` is in here for the reason `useAudioCapture`'s header
   * gives — that call is the line where the audio stops existing, and
   * `docs/specs/voice.md` §4 leaves no path on which it is skipped.
   */
  const clearQuestionState = useCallback(() => {
    setResult(null);
    setResponse('');
    setPromptWasHeard(false);
    setSpokenDraft(null);
    setVoiceError(null);
    setVoiceUnavailable(null);
    setTranscribing(false);
    setRetryOf(null);
    setCorrection(null);
    releaseRecording();
  }, [releaseRecording]);

  // Seeded from the server on load and on refresh. `detail`'s identity changes
  // only when a fetch resolves, so this does not fight the in-session
  // advancement below. `answerMode` is deliberately NOT reset here: which
  // control a learner is using is theirs to choose, and re-reading the session
  // (a reload, or the retry recovery below) must not silently take the
  // microphone away from somebody who is using it.
  const seededRef = useRef<PracticeSessionDetail | null>(null);

  useEffect(() => {
    // ONCE PER SERVER ANSWER, NOT ONCE PER RENDER. `detail`'s identity already
    // changes only when a fetch resolves, but this effect resets the question's
    // whole state — including releasing the recording — and one of its
    // dependencies is a callback assembled from the capture hook. A hook
    // returning an unstable `release` would turn "seed the page" into "seed the
    // page on every render", and because `release()` itself sets state, that is
    // not a slow page: it is a spin the profiler blames on React.
    if (!detail || seededRef.current === detail) return;
    seededRef.current = detail;

    setQuestion(detail.nextQuestion);
    setProgress(detail.progress);
    clearQuestionState();
  }, [clearQuestionState, detail]);

  const questionId = question?.id ?? null;

  // A new question restarts the clock and takes the focus. Both are keyed on
  // the question's id rather than on a render, so neither fires while the
  // learner is reading their feedback for the same question.
  useEffect(() => {
    askedAtRef.current = questionId ? Date.now() : null;
    if (questionId && !result) inputRef.current?.focus();
    // `result` is deliberately in the dependency list: after Next clears it,
    // the field returns and must take focus again for the next question.
  }, [questionId, result]);

  /**
   * Milliseconds from question shown to submit — or `undefined`.
   *
   * ABSENT, never `0`. `0` is a claim, and a false one: that the learner
   * answered instantly. `practice-sessions.md` §2.2 makes the same argument
   * `ai_usage_events` makes for nullable token counts.
   */
  const elapsedMs = useCallback((): number | undefined => {
    const askedAt = askedAtRef.current;
    if (askedAt === null) return undefined;
    const elapsed = Date.now() - askedAt;
    return elapsed > 0 ? elapsed : undefined;
  }, []);

  // ---------------------------------------------------------------------------
  // Audio in, text out. NOTHING HERE GRADES ANYTHING.
  // ---------------------------------------------------------------------------

  /**
   * The recording this page has already sent.
   *
   * The effect below keys on the blob's own identity rather than on a boolean,
   * so a re-render — or a development double-mount — cannot upload the same
   * recording twice and spend the learner's own key on it twice.
   */
  const uploadedRef = useRef<Blob | null>(null);

  /**
   * Grade a transcript the moment it lands — or `null` while that is not what
   * the learner asked for.
   *
   * A REF RATHER THAN A DEPENDENCY, for two reasons that are both about
   * *when* the values are read:
   *
   *  1. The transcription effect's async continuation resolves a network round
   *     trip after it was created, and it closes over whatever `promptWasHeard`,
   *     `retryOf` and the voice preferences were when the RECORDING started.
   *     `voice.autoSubmitSpoken` in particular arrives from
   *     `GET /api/user-settings`, so a learner who has opted OUT and speaks
   *     before that read lands would have their transcript graded against their
   *     wish. Reading through a ref that a commit-time effect keeps current
   *     means the branch is decided by what is true when the words arrive.
   *  2. `submitAttempt` is defined below this effect, so naming it in a
   *     dependency array here would be a temporal-dead-zone `ReferenceError` on
   *     the first render — the array is evaluated during render, not after it.
   *
   * `null` covers BOTH "the learner turned auto-submit off" and "we do not know
   * yet", and the fallback for both is E9's confirm step, which cannot grade
   * anything without the learner pressing a button. Failing towards the flow
   * that asks first is the only safe direction for this particular unknown.
   */
  const autoSubmitRef = useRef<
    ((heard: string, confidence: number | null) => void) | null
  >(null);

  const recording = capture.recording;

  useEffect(() => {
    if (!recording || uploadedRef.current === recording) return;
    uploadedRef.current = recording;

    setTranscribing(true);
    setVoiceError(null);
    setVoiceUnavailable(null);

    void (async () => {
      try {
        const result = await transcribeAudio(recording);
        if (!isMounted()) return;

        // THREE ENDINGS, AND ONLY ONE OF THEM IS AN ERROR (issue #277). All
        // three arrive as HTTP 200 — `docs/specs/voice.md` §9 — so this switch
        // is the only thing that tells them apart. Reading `text` off the
        // response without it is what put `TypeError: Cannot read properties
        // of undefined (reading 'trim')` in front of a learner, in the amber
        // alert, about a deployment where nothing at all had gone wrong.
        switch (result.status) {
          case 'ok': {
            const heard = result.text.trim();
            if (!heard) {
              // An empty transcript is not an error the API reports — it is
              // what silence sounds like, and it is what a tap instead of a
              // hold produces. Saying so is better than dropping the learner
              // into a confirmation step over an empty box, which reads as the
              // product having lost their answer.
              setVoiceError('Nothing was picked up in that recording.');
              return;
            }

            setResponse(heard);
            // CONFIDENCE STRAIGHT THROUGH, `null` INCLUDED. Not `?? 0`:
            // unknown is not low, and coercing it would greet every learner on
            // a provider that reports no score with "that may not be what you
            // said" about a transcript nothing was uncertain about.
            // `confidence.ts` has the whole argument.
            setSpokenDraft({ confidence: result.confidence });

            // HANDS-FREE (issue #286, epic #280 / E12). Both `setResponse` and
            // `setSpokenDraft` above still run on this path, and neither is
            // redundant: the answer field is what keeps the graded words VISIBLE
            // after the verdict, and the draft is what tells `isSpokenAnswer`
            // that they came from a microphone.
            //
            // Reached only AFTER the empty-transcript return above — silence is
            // never graded, on either setting.
            autoSubmitRef.current?.(heard, result.confidence);
            return;
          }

          case 'unavailable':
            // NOT AN ERROR AND NOT A RETRY. Nothing was attempted, so there is
            // nothing to attempt again — see `voiceUnavailable`'s own comment
            // for why this may not share the amber alert.
            setVoiceUnavailable(result.cause);
            return;

          case 'failed':
            // ATTEMPTED, AND IT DID NOT WORK. This one IS worth another go,
            // which is what the amber alert offers.
            //
            // `errorCode` AND `error` GO TO THE CONSOLE AND NOWHERE ELSE.
            // `error` is a redacted provider sentence meant for diagnosis;
            // somebody studying for their naturalization interview cannot act
            // on it, and reading it would tell them their recording, their
            // microphone or their key was at fault when the union already says
            // otherwise.
            console.warn(
              '[voice] transcription failed',
              result.errorCode,
              result.error,
            );
            setVoiceError('That recording could not be turned into text.');
            return;
        }
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
        // `useAudioCapture`'s `release()` is that line (`voice.md` §4), and
        // there is deliberately no branch that skips it — a recording kept
        // "just in case the upload is retried" is a recording of somebody's
        // voice this product has no use for.
        releaseRecording();
      }
    })();
  }, [isMounted, recording, releaseRecording]);

  /**
   * The server has just told us something the cached AI status disagrees with.
   *
   * Re-read it. `transcribeBound` — and therefore the microphone, the
   * Type/Speak toggle, and the page-level `VoiceUnavailableNotice` — all render
   * from that cache, so without this the learner is left holding a control that
   * has already been proven not to work, and the shared notice explaining why
   * never appears. This is the same move `ExplainPanel` makes on its own
   * `unavailable` frame, for the same reason and with the same shape: it fires
   * once per cause, never in a loop, because `refresh` does not change
   * `voiceUnavailable`.
   *
   * `no_user_key` is excluded because it is not a fact about the deployment at
   * all — the roles are bound, the switch is on, and re-reading the status
   * would change nothing. That cause is answered on screen instead.
   */
  const refreshAiStatus = aiStatus?.refresh;
  useEffect(() => {
    if (voiceUnavailable && voiceUnavailable !== 'no_user_key') {
      void refreshAiStatus?.();
    }
  }, [voiceUnavailable, refreshAiStatus]);

  // The transcript takes the focus the moment it lands, so a learner reading
  // it with a screen reader — or one who just wants to fix a word — is already
  // in the field they need to edit rather than hunting for it.
  useEffect(() => {
    if (spokenDraft) inputRef.current?.focus();
  }, [spokenDraft]);

  const submitAttempt = useCallback(
    async (
      input: Omit<RecordPracticeAttemptInput, 'questionId'>,
      mode: Pending,
    ) => {
      if (!id || !question) return;
      setPending(mode);
      setActionError(null);
      setSelfMarkError(null);
      try {
        const graded = await recordPracticeAttempt(id, {
          questionId: question.id,
          ...input,
        });
        if (isMounted()) setResult(graded);
      } catch (err) {
        if (isMounted()) {
          setActionError(describeAttemptError(err, Boolean(input.retryOfAttemptId)));

          // A REFUSED RETRY IS RECOVERABLE, AND THE RECOVERY IS THE SERVER'S
          // OWN ANSWER. A 409 means the attempt being retried is already
          // superseded (or is itself a retry); a 404 means the id names
          // nothing this learner owns in this session at this question. Either
          // way THIS PAGE'S IDEA OF WHERE THE SESSION IS HAS GONE STALE, and
          // leaving the learner on a question whose every button now refuses
          // them is a dead end with no way out but the browser's Back. So the
          // session is re-read: they land on whatever question the server says
          // is next, with the message above still on screen to explain the
          // jump. `clearQuestionState` does not touch `actionError`, which is
          // what keeps that explanation from vanishing in the same frame.
          if (
            input.retryOfAttemptId &&
            err instanceof ApiError &&
            (err.status === 404 || err.status === 409)
          ) {
            setRetryOf(null);
            void refresh();
          }
        }
      } finally {
        if (isMounted()) setPending(null);
      }
    },
    [id, isMounted, question, refresh],
  );

  // KEPT CURRENT AT EVERY COMMIT, deliberately with no dependency array: the
  // transcription effect reads this on a continuation that outlives the render
  // it was created in, so what it needs is the LATEST answer to "should this
  // grade itself, and against which question state?" — not the one that was
  // true when the learner pressed the microphone. See `autoSubmitRef`.
  useEffect(() => {
    autoSubmitRef.current =
      voicePrefsLoading || !voicePrefs.autoSubmitSpoken
        ? null
        : (heard, confidence) => {
            void submitAttempt(
              {
                responseText: heard,
                durationMs: elapsedMs(),
                ...voiceAttemptFields({
                  promptWasHeard,
                  spokenText: heard,
                  confidence,
                  retryOf,
                }),
              },
              'answer',
            );
          };
  });

  const trimmed = response.trim();

  /**
   * Is the text about to be submitted the learner's SPOKEN answer?
   *
   * `spokenDraft !== null` alone is not enough. A learner who spoke, read the
   * transcript, cleared the box and typed something else is a TYPED attempt
   * with a recognition behind it — `record-attempt.dto.ts` uses exactly that
   * example to explain why `inputMode` is RECORDED rather than derived from
   * "is there a transcript?". Emptying the field is the only signal this page
   * has for it, so it is the one used, and the two explicit exits from a
   * transcript ("Record again", "Type it instead") both go through it.
   */
  const isSpokenAnswer = spokenDraft !== null && trimmed.length > 0;

  /** NULL MEANS UNKNOWN. Read out once, never coalesced to a number. */
  const draftConfidence = spokenDraft?.confidence ?? null;
  const lowConfidence = isLowConfidence(draftConfidence);

  /**
   * The voice fields for the attempt the LEARNER is about to submit by hand —
   * the manual Submit, the reveal, and the skip.
   *
   * A thin binding of the page's current state onto `voiceAttemptFields` above,
   * which is the one place the server's mutually-exclusive-field rules live.
   *
   * A SKIP IS NEVER `spoken`. It produced no answer at all, so calling it
   * spoken would claim a recognition step that never ran — and the server would
   * reject the transcript that claim implies.
   */
  const voiceFields = (
    kind: 'answered' | 'skipped',
  ): Pick<
    RecordPracticeAttemptInput,
    'inputMode' | 'promptMode' | 'transcript' | 'asrConfidence' | 'retryOfAttemptId'
  > =>
    voiceAttemptFields({
      promptWasHeard,
      // The CONFIRMED text, which is whatever is in the field now — edits
      // included.
      spokenText: kind === 'answered' && isSpokenAnswer ? trimmed : null,
      confidence: draftConfidence,
      retryOf,
    });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) return;
    void submitAttempt(
      {
        responseText: trimmed,
        durationMs: elapsedMs(),
        ...voiceFields('answered'),
      },
      'answer',
    );
  };

  const handleReveal = () => {
    // Whatever is typed still goes with it. A learner who wrote half the answer
    // and gave up is graded on their words, not on the blank they would have
    // submitted — and the matcher may well accept them.
    void submitAttempt(
      {
        responseText: trimmed || undefined,
        revealed: true,
        durationMs: elapsedMs(),
        ...voiceFields('answered'),
      },
      'reveal',
    );
  };

  const handleSkip = () => {
    // NO `responseText`, ever: a skip carrying text is a 400 server-side, and
    // rightly — storing text against `outcome: 'skipped'` would record a
    // response nobody submitted. The same is true of a transcript, which is
    // why `voiceFields('skipped')` sends neither.
    void submitAttempt(
      { skipped: true, durationMs: elapsedMs(), ...voiceFields('skipped') },
      'skip',
    );
  };

  const handleNext = () => {
    if (!result) return;
    setQuestion(result.nextQuestion);
    setProgress(result.progress);
    clearQuestionState();
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
    setVoiceUnavailable(null);
    releaseRecording();
  };

  /** Throw it away and type instead — the same clearing, plus the toggle. */
  const handleTypeInstead = () => {
    setSpokenDraft(null);
    setResponse('');
    setVoiceError(null);
    setVoiceUnavailable(null);
    releaseRecording();
    setAnswerMode('text');
    inputRef.current?.focus();
  };

  /**
   * Another go at a question whose spoken answer is not what the learner said.
   *
   * WIDENED BY #286 FROM "misheard" TO "any spoken attempt", which is the
   * `voice.md` §3.3 amendment `voice-hands-free.md` §2 states outright. The old
   * condition read `failureCause === 'misheard'` — the server's own verdict —
   * and that was right for E9, where the ONLY attempt that could ever be
   * superseded was one the learner had already confirmed, so a wrong-but-
   * confirmed answer was theirs by construction. Auto-submit breaks that:
   * **accented speech very often transcribes CONFIDENTLY and WRONGLY**, so the
   * exact case that most needs correcting is the one `misheard` cannot see
   * (`isMisheardAttempt` requires a confidence below 0.6). Offering a
   * correction only where the recogniser admitted doubt would leave the
   * learners this product is most for with no way to fix it.
   *
   * Three conditions, and each closes a specific hole:
   *
   *   * **`inputMode === 'spoken'`.** A typed answer was not misheard by
   *     anything; a second go at every typed miss is the grinding loophole the
   *     one-attempt rule exists to close, and nothing about E12 reopens it.
   *   * **not already a retry.** `requireRetryTarget` allows a chain of exactly
   *     two and 409s a third, so a second offer would be a button that cannot
   *     work.
   *   * **not `revealed`.** A learner who asked to see the accepted answer has
   *     it on screen; "correcting" a transcript to match it afterwards would
   *     turn a reveal into a free `correct`, and unlike the two above the
   *     server does not refuse it — `requireRetryTarget` has no opinion on
   *     `revealed`, so this gate is the only one there is.
   */
  const canAnswerAgain =
    result !== null &&
    result.attempt.inputMode === 'spoken' &&
    result.attempt.retryOfAttemptId === null &&
    !result.attempt.revealed;

  /** What was graded, as it will be pre-filled into the correction field. */
  const gradedTranscript =
    result?.attempt.transcript ?? result?.attempt.responseText ?? '';
  /** The doubt the RECOGNISER reported about the graded words. Copy only. */
  const gradedLowConfidence = isLowConfidence(result?.attempt.asrConfidence);

  const handleAnswerAgain = () => {
    if (!result) return;
    // The question STAYS: `question` is untouched, and `progress` is
    // deliberately not advanced to `result.progress`. The server excludes a
    // superseded attempt from `answered`, so the counter beside the question
    // must not move for an attempt that is about to be replaced — moving it
    // and moving it back is a flicker that reads as a lost answer.
    setRetryOf(result.attempt.id);
    setResult(null);
    setResponse('');
    setSpokenDraft(null);
    setCorrection(null);
    setVoiceError(null);
    setVoiceUnavailable(null);
    setActionError(null);
    if (transcribeBound) setAnswerMode('voice');
  };

  /**
   * Type the correction instead of recording it again.
   *
   * The field opens PRE-FILLED with what was graded, so fixing one misheard
   * word is one keystroke rather than retyping a sentence the learner already
   * said correctly.
   */
  const handleStartCorrection = () => {
    setCorrection(gradedTranscript);
    setActionError(null);
  };

  /**
   * Submit the correction as a NEW attempt superseding the graded one.
   *
   * `retryOfAttemptId` is read from the RESULT rather than from `retryOf`,
   * because `retryOf` is the state the *next* recording would carry and the
   * attempt being corrected is on screen right now. It is also written into
   * `retryOf` so that a 404/409 refusal takes `submitAttempt`'s existing
   * stale-session recovery, which keys on the submitted body rather than on
   * this state — the state is what keeps the banner above the field honest if
   * the learner records instead.
   *
   * THE TYPED TEXT IS NOT CLEARED HERE. A refusal leaves the correction card
   * on screen, and clearing it optimistically would throw away the sentence
   * the learner just fixed at the exact moment they have to send it again. On
   * success the card unmounts anyway — the graded attempt is superseded, so
   * `canAnswerAgain` is false — and `clearQuestionState` resets it at Next.
   *
   * The fields are `voiceAttemptFields`' own, exactly as an edited transcript
   * has always sent them under the confirm flow: `inputMode: 'spoken'`, the
   * corrected words as both `responseText` and `transcript`, and the ORIGINAL
   * recogniser confidence — the measurement belongs to the recording, and the
   * client never sends a verdict about it either way.
   */
  const handleSubmitCorrection = (event: React.FormEvent) => {
    event.preventDefault();
    if (!result) return;
    const corrected = (correction ?? '').trim();
    if (!corrected) return;

    const supersedes = result.attempt.id;
    setRetryOf(supersedes);
    void submitAttempt(
      {
        responseText: corrected,
        durationMs: elapsedMs(),
        ...voiceAttemptFields({
          promptWasHeard,
          spokenText: corrected,
          confidence: result.attempt.asrConfidence,
          retryOf: supersedes,
        }),
      },
      'answer',
    );
  };

  const handleSelfMark = async () => {
    if (!id || !result) return;
    setSelfMarking(true);
    setSelfMarkError(null);
    try {
      const updated = await selfMarkPracticeAttempt(id, result.attempt.id);
      // The SERVER'S attempt replaces ours. The verdict on screen then reads
      // `correct` / `self` because that is what was written, not because this
      // component decided the claim was granted.
      if (isMounted()) setResult({ ...result, attempt: updated });
    } catch (err) {
      if (isMounted()) {
        setSelfMarkError(
          err instanceof Error
            ? err.message
            : 'That could not be marked correct.',
        );
      }
    } finally {
      if (isMounted()) setSelfMarking(false);
    }
  };

  const handleFinish = async () => {
    if (!id) return;
    setPending('complete');
    setActionError(null);
    try {
      await completePracticeSession(id);
      if (isMounted()) navigate(practiceSummaryPath(id), { replace: true });
    } catch (err) {
      if (isMounted()) {
        setActionError(
          err instanceof Error
            ? err.message
            : 'This session could not be finished.',
        );
        setPending(null);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // The states that are not a question
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box role="status" aria-live="polite" aria-label="Loading your session">
          <LoadingSpinner />
        </Box>
      </Container>
    );
  }

  if (error || !detail) {
    return (
      <Container maxWidth="md" disableGutters>
        <Box sx={{ py: { xs: 1, sm: 2 } }}>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
            Practice
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
            {error ?? 'That practice session could not be loaded.'}
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

  const { session } = detail;

  // A session that is no longer in progress has no question to ask and cannot
  // be completed (an abandoned one is a 409). Its summary is the honest screen
  // for it, and `replace` keeps the dead URL out of the history stack so Back
  // does not bounce straight through here again.
  if (session.status !== 'in_progress') {
    return <Navigate to={practiceSummaryPath(session.id)} replace />;
  }

  const planned = progress?.planned ?? session.plannedCount;
  const answered = result ? result.progress.answered : (progress?.answered ?? 0);
  // While a question is open it is the NEXT one; once it is graded, the count
  // is what the server just reported. Both come from persisted rows.
  const position = result ? answered : Math.min(answered + 1, planned);
  const isLastQuestion = result ? result.nextQuestion === null : false;
  const finished = !question && !result;

  return (
    <Container maxWidth="md" disableGutters>
      <Box sx={{ py: { xs: 1, sm: 2 } }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Practice
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {sessionKindLabel(session.kind)}
        </Typography>

        <Divider aria-hidden sx={{ mt: 2, mb: 3 }} />

        {/* Progress as TEXT first. The bar under it is decorative and
            `aria-hidden`: a progress bar with no number is unreadable to a
            screen reader, and one with a number announces the same fact
            twice. */}
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {finished
            ? `${answered} of ${planned} answered`
            : `Question ${position} of ${planned}`}
        </Typography>
        <LinearProgress
          aria-hidden
          variant="determinate"
          value={planned > 0 ? Math.min(100, (answered / planned) * 100) : 0}
          sx={{ mt: 1, mb: 3, borderRadius: 1 }}
        />

        {actionError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {actionError}
          </Alert>
        )}

        {question && (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography
              variant="overline"
              component="p"
              color="text.secondary"
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            >
              Question {question.number}
            </Typography>
            <Typography variant="h5" component="h2" sx={{ fontWeight: 600 }}>
              {question.prompt}
            </Typography>

            {/* NEVER GATED ON `speakBound`. The browser's own voice reads the
                question on every deployment — no model, no key, no admin, no
                per-call cost (`voice.md` §2) — so hiding this behind a premium
                binding would take listening practice away from every
                installation that has not bought one. */}
            <Box sx={{ mt: 1, ml: -1 }}>
              <QuestionAudio
                text={question.prompt}
                // THE LEARNER'S STORED PREFERENCE (#288), not the hard-coded
                // `false` this used to pass. It is still only a WISH: the
                // premium path is taken when this is true AND an admin has
                // bound `speak`, and the browser's own voice reads the
                // question in every other case.
                premiumVoice={voicePrefs.preferPremiumVoice}
                voice={voicePrefs.preferredVoice}
                rate={voicePrefs.speechRate}
                // FIRED WHEN AUDIO ACTUALLY STARTS, not when the button is
                // pressed: a play that produced no sound (a failed synthesis,
                // an autoplay block) is a question that was READ, and
                // recording it as `heard` would put a claim in the evidence
                // table that never happened.
                onPlayed={() => setPromptWasHeard(true)}
              />
            </Box>

            {/* MOUNTED UNCONDITIONALLY. It renders null unless `transcribe` is
                KNOWN to be unbound, which is why it can sit here rather than
                behind a condition this page would have to get right — and it
                is NOT the app-wide `AiNotReady` for `systemReady === false`,
                which is a different problem with a different remedy. The two
                are never merged. */}
            <VoiceUnavailableNotice />

            {/* The toggle appears only where speaking is actually possible.
                Offering "Speak" on a deployment with no `transcribe` model
                bound would be a dead affordance beside a notice explaining
                that it is dead. */}
            {transcribeBound && (
              <ToggleButtonGroup
                exclusive
                size="small"
                value={answerMode}
                // The two buttons say what they DO; this says what they are
                // choosing between, which is what a screen-reader user needs
                // before either label means anything.
                aria-label="How you want to answer"
                onChange={(_event, next: AnswerMode | null) => {
                  // MUI reports `null` when the already-active button is
                  // pressed again. Ignored: there is no third state, and
                  // clearing the choice would leave a learner with neither
                  // control on screen.
                  if (next) setAnswerMode(next);
                }}
                sx={{ mt: 2 }}
              >
                <ToggleButton value="text">
                  <KeyboardIcon fontSize="small" sx={{ mr: 0.5 }} />
                  Type
                </ToggleButton>
                <ToggleButton value="voice">
                  <MicIcon fontSize="small" sx={{ mr: 0.5 }} />
                  Speak
                </ToggleButton>
              </ToggleButtonGroup>
            )}

            {/* The form is a real `<form>` so Enter submits, which is what a
                learner typing an answer expects. */}
            <Box component="form" onSubmit={handleSubmit} sx={{ mt: 3 }}>
              {retryOf && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Answering again. This replaces your last answer to this
                  question — your first try stays on the record, and it is not
                  counted twice.
                </Typography>
              )}

              {answerMode === 'voice' && transcribeBound && (
                <Box sx={{ mb: 2 }}>
                  <PushToTalkButton
                    capture={capture}
                    onUseText={() => setAnswerMode('text')}
                    disabled={transcribing || pending !== null || result !== null}
                  />

                  {/* MOUNTED WITH VOICE MODE AND EMPTY UNTIL THERE IS
                      SOMETHING TO SAY — a live region inserted at the same
                      moment as its content is commonly never announced at
                      all. It lives INSIDE the voice branch rather than at the
                      top of the page so that a text-only session still has
                      exactly one status region: the verdict's. */}
                  <Box role="status" aria-live="polite" sx={{ mt: 1 }}>
                    {transcribing && (
                      <Typography variant="body2" color="text.secondary">
                        Writing down what you said…
                      </Typography>
                    )}

                    {/* NOT AN ERROR, SO NOT THE AMBER ALERT (issue #277).
                        Nothing was attempted and nothing was spent, so this
                        renders the SHARED `AiNotReady` — never a message
                        written here, per `CLAUDE.md` and `voice.md`: the one
                        sentence that component exists for, "this is not a
                        problem with your key", is the first thing a rewrite
                        drops, and this is the surface where a learner is most
                        likely to conclude the opposite.

                        EXACTLY ONE NOTICE AT A TIME. The page-level
                        `VoiceUnavailableNotice` covers "unbound when the page
                        loaded"; this covers "the call itself came back
                        unavailable". They cannot both render, structurally:
                        this block only exists while `transcribeBound` is true,
                        and that notice only renders while it is false. The
                        effect above re-reads the status precisely so the page
                        moves from the second state to the first when the
                        server has just told us the role is gone.

                        `no_user_key` is answered separately below — see
                        `ExplainPanel`'s header for why the shared component
                        must not be the thing that says it.

                        `alertRole="presentation"` for the same reason every
                        other child of this Box carries it: the announcement is
                        the region's job, and an `<Alert>`'s default
                        `role="alert"` nested inside it is read twice. Note it
                        is NOT the `role` prop beside it — that one names the AI
                        model role. */}
                    {!transcribing &&
                      voiceUnavailable &&
                      voiceUnavailable !== 'no_user_key' && (
                        <AiNotReady role="transcribe" alertRole="presentation" />
                      )}

                    {!transcribing && voiceUnavailable === 'no_user_key' && (
                      // The one cause that IS the learner's to fix, so it gets
                      // the one message that offers them something to do.
                      // `info`, not `warning`: their session is unaffected and
                      // typing below works exactly as it always did.
                      <Alert severity="info" role="presentation">
                        <AlertTitle>
                          Add your AI key to answer out loud
                        </AlertTitle>
                        <Typography variant="body2" sx={{ mb: 1 }}>
                          Speech is transcribed on your own AI key, and there
                          isn&rsquo;t one saved on your account yet. You can
                          still type your answer below.
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

                    {!transcribing && voiceError && (
                      <Alert
                        severity="warning"
                        // NOT MUI's DEFAULT `role="alert"`. This sits inside
                        // the polite live region above, and a live region
                        // nested in a live region is how a screen-reader user
                        // is read the same sentence twice — once as the alert,
                        // once as the change to the region containing it. The
                        // announcement is the outer region's job; this is the
                        // alert's LOOK, which is all that is wanted here.
                        role="presentation"
                      >
                        <AlertTitle>{voiceError}</AlertTitle>
                        <Typography variant="body2">
                          Hold the button and say it again, or type your answer
                          below — typing always works.
                        </Typography>
                      </Alert>
                    )}

                    {/* THE CONFIRMATION STEP — E9's flow, kept as the OPT-OUT
                        (`voice.autoSubmitSpoken: false`, issue #286). Nothing
                        has been graded at this point and nothing will be until
                        the learner presses the button themselves.

                        `pending === null` IS PART OF THE CONDITION, not
                        housekeeping. On the auto-submit default this block's
                        state (`response`, `spokenDraft`) is set in the same
                        commit that starts the grading request, so without it
                        the sentence "nothing is graded until you choose Use
                        this answer" would render — briefly, and untruthfully —
                        over an attempt already in flight.

                        The confidence decides the WORDS here and nothing else,
                        and the number itself is never rendered: "41%
                        confident" is a diagnostic detail somebody studying for
                        their naturalization interview has no way to act on. */}
                    {!transcribing &&
                      !voiceError &&
                      spokenDraft &&
                      !result &&
                      pending === null && (
                        <Alert
                          severity="info"
                          icon={false}
                          // Announced by the region above, not by itself — see
                          // the warning alert's note.
                          role="presentation"
                        >
                          <AlertTitle>
                            {lowConfidence
                              ? 'That may not be what you said.'
                              : 'Is this what you said?'}
                          </AlertTitle>
                          <Typography variant="body2" sx={{ mb: 1.5 }}>
                            {lowConfidence
                              ? 'Your recording was hard to make out, so this is more likely our mistake than yours. Read it below, change anything that is wrong, or record it again — nothing has been graded yet.'
                              : 'Read it below and change anything that is wrong. Nothing is graded until you choose Use this answer.'}
                          </Typography>
                          <Stack
                            direction={{ xs: 'column', sm: 'row' }}
                            spacing={1}
                            sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
                          >
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<MicIcon />}
                              onClick={handleRecordAgain}
                              disabled={pending !== null}
                            >
                              Record again
                            </Button>
                            <Button
                              size="small"
                              onClick={handleTypeInstead}
                              disabled={pending !== null}
                            >
                              Type it instead
                            </Button>
                          </Stack>
                        </Alert>
                      )}
                  </Box>
                </Box>
              )}

              <TextField
                // A REAL `<label>` — MUI's `label` prop renders one bound to
                // the input, so this is never a placeholder pretending.
                label="Your answer"
                value={response}
                onChange={(event) => setResponse(event.target.value)}
                inputRef={inputRef}
                fullWidth
                autoComplete="off"
                // Off, deliberately: the browser's spell-check and
                // autocorrect on a civics answer offer a different word than
                // the learner meant, and the matcher is comparing text.
                spellCheck={false}
                // Also disabled while a transcription is in flight: the box is
                // about to be filled with what the learner just said, and
                // typing into it in the meantime would have their words
                // overwritten without warning.
                disabled={pending !== null || result !== null || transcribing}
                helperText={
                  isSpokenAnswer && result
                    ? // ALREADY GRADED (#286): the field is disabled and these
                      // are the words the verdict below is about. Telling the
                      // learner to "change anything that is wrong" here would
                      // point them at a control that cannot accept the change —
                      // the correction card under the verdict is where it goes.
                      'This is what we heard, and what was graded.'
                    : isSpokenAnswer
                      ? 'This is what we heard. Change anything that is wrong — it is graded exactly as it reads here.'
                      : 'Type it the way you would say it. Spelling and capitalisation are not judged.'
                }
              />

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                sx={{
                  mt: 2,
                  alignItems: { xs: 'stretch', sm: 'center' },
                }}
              >
                <Button
                  type="submit"
                  variant="contained"
                  size="large"
                  disabled={!trimmed || pending !== null || result !== null}
                >
                  {pending === 'answer'
                    ? 'Checking…'
                    : isSpokenAnswer
                      ? 'Use this answer'
                      : 'Submit'}
                </Button>
                <Button
                  variant="outlined"
                  onClick={handleReveal}
                  disabled={pending !== null || result !== null}
                >
                  {pending === 'reveal' ? 'Showing…' : 'Show me the answer'}
                </Button>
                <Button
                  variant="text"
                  color="inherit"
                  onClick={handleSkip}
                  disabled={pending !== null || result !== null}
                >
                  {pending === 'skip' ? 'Skipping…' : 'Skip'}
                </Button>
              </Stack>
            </Box>
          </Paper>
        )}

        {/* MOUNTED FROM THE FIRST RENDER AND EMPTY UNTIL THERE IS A VERDICT.
            That ordering is what makes the announcement happen at all — see the
            file header — and it is also, structurally, where the accepted
            answers appear for the first time. Nothing renders into this region
            except a graded `PracticeAttemptResult`. */}
        <Box role="status" aria-live="polite" sx={{ mt: 3 }}>
          {result && (
            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
              <AttemptFeedback
                result={result}
                onNext={isLastQuestion ? () => void handleFinish() : handleNext}
                nextLabel={
                  pending === 'complete'
                    ? 'Finishing…'
                    : isLastQuestion
                      ? 'See your summary'
                      : 'Next question'
                }
                onSelfMark={() => void handleSelfMark()}
                selfMarking={selfMarking}
                selfMarkError={selfMarkError}
              />
            </Paper>
          )}
        </Box>

        {/* THE CORRECTION, AFTER THE VERDICT (issue #286, epic #280 / E12).

            This is E9's confirmation step, moved. It used to sit before grading
            and ask "is this what you said?"; auto-submit means the answer to
            that question arrives with a grade attached, so the same words, the
            same editable text and the same "record it again" now sit BESIDE the
            verdict instead of in front of it. What it protects is unchanged —
            a learner is never left with a recorded miss they did not make.

            THE TRANSCRIPT IS VISIBLE HERE FOR EVERY SPOKEN ATTEMPT, not only a
            doubted one: the transcript a learner most needs to see is the
            confidently-wrong one, which is exactly the one nothing flags.
            `gradedLowConfidence` chooses the WORDS and nothing else, and the
            confidence number itself is never rendered (`voice.md` §3.1).

            Outside the `role="status"` region above for the same reason the
            explain action below is: a control appended to a live region is
            re-announced as part of the verdict every time that region changes.
            `role="presentation"` for the same reason — the `<Alert>` is wanted
            for its LOOK, and a second `role="alert"` firing beside the
            verdict's own announcement reads as two unrelated interruptions.

            Either route posts a NEW attempt carrying `retryOfAttemptId`. The
            original is not edited and not deleted — it is the evidence of what
            happened — the server leaves it out of `answered` so the pair counts
            as one question, and `recomputeMasteryForQuestion` (#285) replays the
            question's mastery without it, so the correction costs nothing. */}
        {canAnswerAgain && (
          <Box sx={{ mt: 3 }}>
            <Alert severity="info" icon={false} role="presentation">
              <AlertTitle>
                {gradedLowConfidence
                  ? 'That may not be what you said.'
                  : 'This is what we heard.'}
              </AlertTitle>
              <Typography variant="body2" sx={{ mb: 1, fontStyle: 'italic' }}>
                &ldquo;{gradedTranscript}&rdquo;
              </Typography>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                {gradedLowConfidence
                  ? 'Your recording was hard to make out, so anything wrong above is more likely our mistake than yours. Please check it — putting it right replaces this attempt and costs you nothing.'
                  : 'Those are the words that were graded. If they are not what you said, put it right — that replaces this attempt, does not count as a second question, and costs you nothing.'}
              </Typography>

              {correction === null ? (
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
                >
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={handleStartCorrection}
                    disabled={pending !== null}
                  >
                    That&rsquo;s not what I said
                  </Button>
                  <Button
                    size="small"
                    startIcon={<MicIcon />}
                    onClick={handleAnswerAgain}
                    disabled={pending !== null}
                  >
                    Record it again
                  </Button>
                </Stack>
              ) : (
                <Box component="form" onSubmit={handleSubmitCorrection}>
                  <TextField
                    // ITS OWN REAL `<label>`, and its own text. The "Your
                    // answer" field above still holds the graded words and is
                    // disabled; two controls bound to one string, one of them
                    // dead, is where a correction goes unnoticed.
                    label="What you actually said"
                    value={correction}
                    onChange={(event) => setCorrection(event.target.value)}
                    fullWidth
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending !== null}
                    helperText="Change only what is wrong. It is graded exactly as it reads here."
                  />
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ mt: 1.5, alignItems: { xs: 'stretch', sm: 'center' } }}
                  >
                    <Button
                      type="submit"
                      size="small"
                      variant="contained"
                      disabled={!correction.trim() || pending !== null}
                    >
                      {pending === 'answer' ? 'Checking…' : 'Use this instead'}
                    </Button>
                    <Button
                      size="small"
                      onClick={() => setCorrection(null)}
                      disabled={pending !== null}
                    >
                      Keep what we heard
                    </Button>
                  </Stack>
                </Box>
              )}
            </Alert>
          </Box>
        )}

        {/* THE EXPLAIN ACTION, AFTER THE VERDICT AND OUTSIDE THE LIVE REGION
            ABOVE. Both halves of that placement are deliberate.

            After the verdict, because the answers only exist on this page once
            an attempt has been recorded — asking "why is that the answer?"
            before there is an answer on screen would be a request for the one
            thing this page must not hand over early (see the file header).

            Outside the `role="status"` region, because the explanation streams
            into a polite live region of its own. Nesting one live region inside
            another is how a screen-reader user is read the same paragraph twice
            — once as the explanation arrives, and again as a change to the
            verdict region that contains it. `StateRequiredNotice` documents the
            same hazard from the other side.

            The practice loop does not depend on it: `ExplainPanel` renders a
            disabled control and the shared `AiNotReady` when AI is not set up,
            and every control above it keeps working exactly as it did in E3. */}
        {result && (
          <ExplainPanel
            questionId={result.attempt.questionId}
            headingComponent="h3"
            label="Why is that the answer?"
          />
        )}

        {finished && (
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" component="h2">
              That&rsquo;s everything in this session.
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 1 }}>
              Finish it to see how it went, question by question.
            </Typography>
            <Button
              variant="contained"
              size="large"
              onClick={() => void handleFinish()}
              disabled={pending === 'complete'}
              sx={{ mt: 3 }}
            >
              {pending === 'complete' ? 'Finishing…' : 'Finish and see your summary'}
            </Button>
          </Paper>
        )}

        <Button
          component={RouterLink}
          to="/practice"
          startIcon={<ArrowBackIcon />}
          sx={{ mt: 4, ml: -1 }}
        >
          Back to Practice
        </Button>
      </Box>
    </Container>
  );
}

/**
 * What went wrong recording that attempt, in words a learner can act on.
 *
 * The generic branch is the pre-E9 behaviour, unchanged: the API's own message
 * is the best sentence available, and inventing one over the top of it loses
 * detail the server took care to send.
 *
 * The RETRY branch exists because the two refusals a retry can meet are the
 * two whose raw messages explain nothing to the person reading them. A 409
 * ("has already been retried" / "is itself a retry") and a 404 ("not found")
 * are both accurate and both unanswerable from the learner's side of the
 * screen — they name a row id and a rule about chains. What a learner needs
 * to know is that nothing was lost, which is true: the first attempt is
 * recorded, the question will come back through the scheduler, and the page
 * moves them on rather than stranding them on a question every button now
 * refuses.
 */
function describeAttemptError(err: unknown, wasRetry: boolean): string {
  if (
    wasRetry &&
    err instanceof ApiError &&
    (err.status === 404 || err.status === 409)
  ) {
    return 'Your first answer to that question is already recorded, so it could not be replaced. Nothing was lost — the question will come round again in a later session.';
  }

  return err instanceof Error
    ? err.message
    : 'That answer could not be recorded.';
}
