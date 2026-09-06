/**
 * Practice session (`/practice/sessions/:id`) — one question at a time.
 *
 * Issue #79, epic #52. The screen where a learner **produces** an answer
 * instead of recognizing one, which is the entire reason E3 exists as its own
 * step: `/learn` (E2) is `VISION.md`'s "See it → Understand it", deliberately
 * before any recall, and this is the first place recall is asked for.
 *
 * ======================================================================  /**
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
 *     mid-session, or who gets on a bus, keeps everything. Since #350 the same
 *     toggle is offered one screen earlier, on `/practice`, from the shared
 *     `AnswerModeChoice` — this page's copy is what keeps the choice
 *     REVERSIBLE, which is the half that must never move.
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
 * A RUNNING VOICE SESSION IS A DIFFERENT SCREEN (#356, epic #345)
 * =============================================================================
 *
 * This file renders TWO screens, and the branch is "a spoken session is under
 * way" — `conversation.isRunning` for E13's request/response loop, OR
 * `realtime.stage` being `connecting`/`live` for the realtime transport
 * (#381). Two drivers, two independent answers, one screen: neither knows the
 * other exists, and the gate asks both rather than picking one.
 *
 * Everything described above — the form, the correction card, the feedback
 * stack, the explain panel — is the TEXT path, unchanged. The moment either
 * spoken transport is actually driving, this component returns
 * `components/voice/VoiceSurface` instead: one viewport, no document scroll, a
 * state visual large enough to read at arm's length, exactly one live region,
 * and Stop and "Type instead" anchored outside every scrolling region.
 *
 * The reason it is a separate screen rather than a restyle is the shape of the
 * two jobs. A learner typing wants everything at once and is happy to scroll
 * for it; a learner talking is not looking at the phone, and when they do
 * glance at it they are asking exactly one question — "is it my turn?" — that
 * a 2,600-line page answered with one grey sentence somewhere in the middle of
 * roughly 1,500px of content. Restyling would have made one screen worse at
 * both jobs.
 *
 * NOTHING IS LOST BY THE SWAP, and that is structural rather than careful:
 * it is a `return` inside the same component instance, so every piece of state
 * here survives it, and the facts that matter — which questions are answered,
 * what the counter reads — were never in the browser at all. See the branch
 * itself for the full argument.
 *
 * =============================================================================
 * RELOADING MID-SESSION RESUMES FROM THE SERVER
 * =============================================================================
 *
 * Every fact on this screen comes from `GET /api/practice/sessions/:id` —
 * which question is next, how many are answered, how many were planned. Nothing
 * is counted in the browser, and no attempt is buffered locally. So a reload, a
 * crash, a closed tab or a second tab all resume at the same place with every
 * recorded attempt intact, and two tabs cannot disagree about the count.
 * `usePracticeSession`'s header has the full argument.
 *
 * ONE THING IS CARRIED THROUGH `navigate(..., { state })`, AND IT IS NOT A
 * FACT ABOUT THE SESSION (#350, epic #345): `{ handsFree: true }`, the intent
 * of the tap on `/practice` that created this session. It decides whether the
 * hands-free loop arms itself on arrival and nothing else — no question, no
 * count, no attempt — and it is consumed once and cleared, so a reload restores
 * the session from the server exactly as before and simply does not re-arm.
 * See `components/practice/handsFreeStart.ts`.
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
 * feedback's "Accepted answer" label as the `h3` under that. The voice surface
 * has its own outline of the same shape — its title as the `h1`, the question
 * as the `h2` — and only one of the two screens is ever mounted, so the
 * document has exactly one `h1` either way. The answer field
 * has a real `<label>` (MUI's `TextField label`), and it takes focus on every
 * new question so a keyboard or screen-reader user is never hunting for where
 * to type. The verdict lands inside a `role="status"` region that is MOUNTED
 * FROM THE FIRST RENDER and only ever has its contents changed — a live region
 * inserted at the same moment as its content is commonly missed entirely by
 * assistive technology.
 *
 * THAT REGION IS THE ONLY ONE IN THE TEXT PATH (#358, epic #345). Four could be
 * mounted at once before it — the hands-free loop's phase region, the voice
 * region, the verdict's, and `QuestionAudio`'s own — which is four things
 * competing to announce. The rule now:
 *
 *   * The verdict region carries BOTH outcomes of an action: a graded result
 *     and an `actionError`. They are one event from the learner's side.
 *   * Anything mounted inside it announces through it —
 *     `role="presentation"` on the alerts, no `role="status"` on the coach's
 *     reaction, `announce={false}` on the accepted answer's player.
 *   * The question's own player passes `announce={false}` too: its states are
 *     carried by the button the learner just pressed, and a second region for
 *     them would compete with the verdict's for no gain.
 *
 * The voice branch keeps its own region while it is mounted, which is the one
 * documented exception, along with `VoiceUnavailableNotice` — see
 * `PracticeSessionPage.declutter.test.tsx`, which asserts the whole rule
 * including both exceptions.
 *
 * AND AT MOST ONE `QuestionAudio` IS MOUNTED AT A TIME. The question's is
 * unmounted while a verdict is up (the answer's is the one that matters then)
 * and while the loop is driving (it reads through its own player), so three
 * text buttons and three status lines for one sentence cannot recur.
 *
 * Mobile-first, and every responsive value steps at `sm` (600px), never `md`.
 * None of `CLAUDE.md`'s five coupled gates is touched here; this page only
 * agrees with them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import MicIcon from '@mui/icons-material/Mic';
import StopIcon from '@mui/icons-material/Stop';
import {
  Link as RouterLink,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';

import { AnswerModeChoice } from '../components/practice/AnswerModeChoice';
import type { AnswerMode } from '../components/practice/AnswerModeChoice';
import { wantsHandsFreeStart } from '../components/practice/handsFreeStart';
import { AttemptFeedback } from '../components/practice/AttemptFeedback';
import { AiNotReady } from '../components/ai/AiNotReady';
import { AI_KEY_SETTINGS_PATH, ExplainPanel } from '../components/ai/ExplainPanel';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { PushToTalkButton } from '../components/voice/PushToTalkButton';
import { QuestionAudio } from '../components/voice/QuestionAudio';
import type { QuestionAudioHandle } from '../components/voice/QuestionAudio';
import { MicrophoneReadinessNotice } from '../components/voice/MicrophoneReadinessNotice';
import { VoiceSurface } from '../components/voice/VoiceSurface';
import { VoiceUnavailableNotice } from '../components/voice/VoiceUnavailableNotice';
import { spokenDoubt } from '../components/voice/confidence';
import { useOptionalAiStatus } from '../contexts/AiStatusContext';
import { usePracticeSession } from '../hooks/usePracticeSession';
import { useAudioCapture } from '../hooks/useAudioCapture';
import type { AudioCaptureProblem } from '../hooks/useAudioCapture';
import { useIsMounted } from '../hooks/useIsMounted';
import { useMediaReadiness } from '../hooks/useMediaReadiness';
import { useVoiceActivity } from '../hooks/useVoiceActivity';
import type { VoiceActivityLevelSource } from '../hooks/useVoiceActivity';
import { useVoiceAvailability } from '../hooks/useVoiceAvailability';
import {
  DEFAULT_VOICE_CONVERSATION_MODE,
  useVoicePrefs,
  writeFor,
} from '../hooks/useVoicePrefs';
import { useConversationSession } from '../hooks/useConversationSession';
import type {
  ConversationGrade,
  ConversationPhase,
  ConversationSpeechOutcome,
  ConversationSpeechPort,
  UseConversationSessionReturn,
} from '../hooks/useConversationSession';
import { useRealtimeAvailability } from '../hooks/useRealtimeAvailability';
import { useRealtimePractice } from '../hooks/useRealtimePractice';
import type {
  RealtimePracticeFallbackCode,
  RealtimePracticeMicrophonePort,
  RealtimePracticeStage,
} from '../hooks/useRealtimePractice';
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

  /**
   * Could this deployment's bound model have said, at all? (issue #348.)
   *
   * Carried BESIDE `confidence` rather than folded into it, because a `null`
   * score means two different things and only one of them is worth a word to
   * the learner — see `SpeechTranscriptionOk.confidenceAvailable` and
   * `spokenDoubt`. `false` here is what turns a silence that reads as "fine"
   * into "we cannot tell how clearly that came through, so please read it".
   */
  confidenceAvailable: boolean;
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

/**
 * What the hands-free loop is doing, in one sentence per phase.
 *
 * ON SCREEN AS WELL AS ALOUD. Conversation mode is built for a learner who is
 * not looking, which is exactly why the phase must also be readable: a learner
 * who DOES glance at the phone — or who has sound off, or is using a screen
 * reader — has otherwise no way to tell "listening" from "thinking" from
 * "stopped". The spoken cue and this line are two renderings of one fact, never
 * two facts.
 *
 * `idle` is empty rather than "stopped": the controls beside it already say so,
 * and a live region that announces "idle" every time a session ends is noise.
 */
const CONVERSATION_PHASE_TEXT: Record<ConversationPhase, string> = {
  idle: '',
  // ISSUE #349's LINE, AND THE ONE THIS TABLE EXISTS TO GET RIGHT. Between the
  // tap and the first word of the question sits the browser's permission
  // dialogue and the device round-trip, and until #349 this span rendered as
  // "Asking you the question." — a sentence that was false in the one moment a
  // learner is most likely to be looking at the screen, waiting to be told what
  // the modal in front of them is for. It names the microphone, because that is
  // what the dialogue is asking about.
  preparing: 'Opening your microphone.',
  // DELIBERATELY NOT `QuestionAudio`'s own "Reading the question aloud." — the
  // loop mounts that component, so the two lines sit on the same screen at the
  // same moment, and two live regions saying the identical sentence is one
  // announcement a screen-reader user hears twice with no way to tell which
  // control it came from.
  speakingQuestion: 'Asking you the question.',
  listening: 'Listening. Answer when you are ready.',
  processing: 'Working out how that went.',
  speakingAnswer: 'Telling you the answer.',
  advancing: 'Moving on to the next question.',
};

/**
 * Say one of the driver's own short lines with the browser's own voice.
 *
 * THE `nudge` HALF OF THE SPEECH PORT, and deliberately not `QuestionAudio`:
 * "I didn't catch that. Go ahead." is five words of the app's own scaffolding,
 * not content. Routing it through the premium path would spend the learner's
 * own key on it, put it in the deployment-wide audio cache, and give it a
 * replay button nobody wants — see `ConversationSpeechKind`.
 *
 * NEVER REJECTS. A browser with no `speechSynthesis` resolves `failed`, which
 * the driver treats as a nudge that was not heard rather than a reason to stop.
 */
function speakNudge(text: string): Promise<ConversationSpeechOutcome> {
  return new Promise<ConversationSpeechOutcome>((resolve) => {
    const synthesis = typeof window === 'undefined' ? undefined : window.speechSynthesis;
    const Utterance =
      typeof window === 'undefined' ? undefined : window.SpeechSynthesisUtterance;
    if (!synthesis || typeof Utterance !== 'function') {
      resolve('failed');
      return;
    }

    let settled = false;
    const settle = (outcome: ConversationSpeechOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const utterance = new Utterance(text);
    utterance.onend = () => settle('ended');
    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      // `cancel()` reports the utterance it interrupted as an error. That is
      // this page silencing itself — `cancelled`, not a failure — and the
      // driver's turn token has already moved on from it either way.
      const reason = event?.error;
      settle(reason === 'canceled' || reason === 'interrupted' ? 'cancelled' : 'failed');
    };
    synthesis.speak(utterance);
  });
}

/**
 * How long one closing line may hold the summary screen up.
 *
 * `speakNudge` resolves on `onend` or `onerror`, and a browser that fires
 * NEITHER — the one real hazard of `speechSynthesis` — would otherwise leave a
 * learner staring at "Finishing…" forever. Eight seconds is far longer than any
 * line in the bank takes to say and far shorter than a learner will wait before
 * deciding the app has hung.
 */
const CLOSING_TURN_LINE_TIMEOUT_MS = 8000;

/**
 * Say the session's closing turn, in order, and resolve when it is done
 * (issue #352, epic #345).
 *
 * ============================================================================
 * WHY THIS IS AWAITED BEFORE NAVIGATING, RATHER THAN FIRED AND FORGOTTEN
 * ============================================================================
 *
 * `useConversationSession`'s unmount cleanup calls `speech.stop()`, which
 * cancels whatever the page is saying. Leaving for the summary screen while the
 * coach is still speaking therefore does not overlap the two — it CUTS THE
 * COACH OFF mid-sentence, which is worse than the silence this issue exists to
 * end. So the closing line is spoken first and the navigation waits for it,
 * bounded by the timeout above.
 *
 * ============================================================================
 * WHY THE BROWSER'S OWN VOICE, NOT `QuestionAudio`'s PREMIUM PATH
 * ============================================================================
 *
 * The premium path is for CONTENT — a civics question or its accepted answer —
 * and it is what the deployment-wide audio cache
 * (`GET /api/ai/speech/audio`) is keyed for: `civics_question` and
 * `civics_answer`, and nothing else. A coach's line is neither, so a premium
 * synthesis of it would spend the learner's own key on every session ending,
 * uncached, forever. The browser's voice costs nothing, needs no key and needs
 * no `speak` binding — which also means the closing line still happens on a
 * deployment with no AI voice configured at all.
 */
async function speakClosingTurn(lines: readonly string[]): Promise<void> {
  for (const line of lines) {
    await Promise.race([
      speakNudge(line),
      new Promise<void>((resolve) => {
        setTimeout(resolve, CLOSING_TURN_LINE_TIMEOUT_MS);
      }),
    ]);
  }
}

/**
 * =============================================================================
 * TEST-ONLY SEAM — issue #314, epic #304 / E13's own test coverage
 * =============================================================================
 *
 * `useVoiceActivity`'s own `createLevelSource` option exists precisely so a
 * caller can replace the real `AnalyserNode` tap with a synthetic one
 * (`docs/specs/conversation-mode.md` §16: "What CI *can* verify: the state
 * machine, driven by synthetic levels"). Nothing in this file reached that
 * seam before this issue — this page always took the hook's own default,
 * which is why a browser end-to-end test had no way to drive the loop past
 * `speakingQuestion` without a real, audible microphone.
 *
 * `window.__oathpathTestVoiceLevelSource`, when a Playwright spec sets it with
 * `page.addInitScript` BEFORE the page's first render, is read here and
 * threaded through unchanged. Every other path — every real user, every
 * deployment, and any test that never sets the global — sees `undefined` and
 * this component behaves exactly as it did before this issue: `useVoiceActivity`
 * falls back to its own real `createAnalyserLevelSource`.
 *
 * `import.meta.env.PROD` is the identical gate `App.tsx`'s `TestLoginPage`
 * already uses for a development-only route: a production build strips this
 * branch out entirely (the `if` is dead-code-eliminated), so there is no
 * runtime check to bypass and no code path a production deployment can be
 * tricked into taking.
 */
function getTestVoiceActivityLevelSource():
  | ((stream: MediaStream) => VoiceActivityLevelSource | null)
  | undefined {
  if (import.meta.env.PROD) return undefined;
  if (typeof window === 'undefined') return undefined;
  return (
    window as unknown as {
      __oathpathTestVoiceLevelSource?: (
        stream: MediaStream,
      ) => VoiceActivityLevelSource | null;
    }
  ).__oathpathTestVoiceLevelSource;
}

/**
 * Which of the two spoken transports this session runs on, or neither.
 *
 * =============================================================================
 * THE DEGRADATION LADDER, DECIDED AT EXACTLY ONE SITE
 * =============================================================================
 *
 * `docs/specs/realtime-practice.md` §8. Six rungs, and every one of them lands
 * here rather than in a condition beside a control:
 *
 * | condition                                   | result                        |
 * |---------------------------------------------|-------------------------------|
 * | `realtime` bound                            | realtime practice             |
 * | `realtime` unbound, `transcribe` bound      | E13's request/response loop   |
 * | neither bound                               | text only, no voice control   |
 * | mint `unavailable`/`failed`                 | the request/response loop     |
 * | microphone refused                          | text, before any mint         |
 * | handshake failed, or dropped past the bound | the request/response loop, mid-session |
 *
 * A PURE FUNCTION, EXPORTED, because "one decision site" is a claim a test
 * should be able to check directly rather than by rendering six pages. The
 * picker above stays TWO-VALUED — `Text | Voice` — and which of the two voice
 * mechanisms Voice resolves to is this function's answer, never a third button
 * a learner has to understand.
 *
 * `realtime` unbound renders NOTHING, not a disabled control: `voice.md` §1's
 * hidden-not-disabled posture, reused for a third role rather than reinvented.
 *
 * THE MICROPHONE RUNG IS THE ONE THAT LOOKS WRONG AND IS NOT. A refused
 * microphone falls all the way to text rather than to the request/response
 * loop, because that loop needs the identical device: offering it would be
 * offering a second control that cannot work, to somebody who has just been
 * told the first one could not open.
 *
 * Every other realtime failure falls to the request/response loop when
 * `transcribe` is bound, and to text when it is not — and NOTHING IS LOST
 * either way, structurally: every attempt is a committed `practice_attempts`
 * row, and the question, the count and the progress bar are all re-read from
 * the server (§8's "there is no client-held state a fallback could lose").
 */
export type VoiceTransport = 'realtime' | 'request_response' | null;

export function resolveVoiceTransport(input: {
  /** A model is bound to `realtime`. False while the AI status is unknown. */
  realtimeBound: boolean;
  /** A model is bound to `transcribe`. False while the AI status is unknown. */
  transcribeBound: boolean;
  /**
   * Why the realtime transport gave up this session, or `null`.
   *
   * STICKY FOR THE SESSION on purpose: a transport that has just failed is not
   * a transport to try again automatically two renders later, which is what a
   * value derived from live connection state would do. `retry()` clears it,
   * which is the learner asking.
   */
  realtimeFallback: RealtimePracticeFallbackCode | null;
}): VoiceTransport {
  // See the header: no spoken transport works without a microphone.
  if (input.realtimeFallback === 'microphone') return null;
  if (input.realtimeBound && input.realtimeFallback === null) return 'realtime';
  if (input.transcribeBound) return 'request_response';
  return null;
}

/**
 * The one sentence about money, on the control that starts the mode.
 *
 * SAID ONCE, AND WITH NO PRICE IN IT. `realtime-practice.md` §10 requires the
 * billing sentence to appear on the control that starts the mode and forbids
 * an invented per-minute figure — this application does not know what any
 * given provider charges any given learner, and a number here would be a
 * confident guess about somebody else's bill.
 */
const REALTIME_BILLING_SENTENCE =
  'A live voice session runs on your own AI key and is billed by the minute ' +
  'for as long as the connection is open.';

/**
 * Headphones, and the honest reason for them.
 *
 * `realtime-practice.md` §11. E13's anti-echo guarantee was STRUCTURAL — the
 * recorder is not running while the app talks — and this transport gives that
 * up by design, because full duplex is the whole point: the coach must be
 * interruptible mid-sentence. What replaces it is probabilistic
 * (`echoCancellation`, requested on the page's own capture stream), and saying
 * so plainly beats implying a guarantee that is not there.
 *
 * The second sentence is not reassurance for its own sake: it is §4's fourth
 * mechanism. The attempt row is committed BEFORE the coach speaks, so a
 * mishearing of its own echo costs a spoken turn and never a wrong row.
 */
const REALTIME_ECHO_SENTENCE =
  'Headphones help: the microphone stays open while the coach speaks, so echo ' +
  'cancellation reduces feedback but cannot rule it out. Your answer is ' +
  'recorded before the coach replies, so an echo can cost a turn but never ' +
  'changes what was saved.';

/** What the spoken session is doing, in one sentence per stage. */
const REALTIME_STAGE_TEXT: Record<RealtimePracticeStage, string> = {
  idle: '',
  connecting: 'Opening your microphone and connecting.',
  live: 'Live. Talk to the coach whenever you are ready.',
  fallback: '',
  ended: '',
};

/**
 * Is the LIVE transport actually conducting a session right now? (#381)
 *
 * The realtime transport's own answer to the question `conversation.isRunning`
 * answers for E13's loop, and the second half of the voice surface's gate. Two
 * stages, and only two: `connecting` is already a session — the microphone is
 * open, the mint is on the learner's key, and the learner is waiting on a voice
 * rather than on a control — and `live` is the conversation itself.
 *
 * DELIBERATELY NOT `voiceTransport === 'realtime'` AS WELL. A live connection
 * outranks the ladder that chose it: if `realtimeBound` flipped underneath a
 * running session (an `/api/ai/status` re-read, an admin unbinding the role),
 * the ladder would move to another rung while the connection stayed open and
 * billing — and a gate that also consulted it would take the surface, and with
 * it the Stop button, off the screen at that exact moment.
 */
export function realtimeSessionIsUnderWay(stage: RealtimePracticeStage): boolean {
  return stage === 'connecting' || stage === 'live';
}

/**
 * The realtime transport's stage, as the picture the voice surface draws.
 *
 * `VoiceSurface` takes a `ConversationPhase` because E13's driver is what it
 * was written against, and the phase decides ONE thing there: which of
 * `voiceVisualState`'s four pictures is drawn. The sentence under the picture
 * is `phaseText`, which every transport passes from its OWN table — see that
 * prop's doc comment — so this mapping is never asked to produce words.
 *
 * The two stages that matter map to the phases that describe them:
 *
 *   * `connecting` → `preparing`, the phase #349 added for exactly this span —
 *     the microphone dialogue and the round trip before the first word. It
 *     draws "Thinking", which is what a learner needs from the picture while
 *     the application is busy and it is not yet their turn.
 *   * `live` → `speakingQuestion` WHILE THE COACH IS TALKING, `listening`
 *     otherwise.
 *
 * -----------------------------------------------------------------------------
 * WHY `live` IS NOT ONE PICTURE (#386)
 * -----------------------------------------------------------------------------
 *
 * This function used to collapse `live` to `listening` unconditionally, on the
 * argument that a full-duplex microphone is open for the whole session so it is
 * always the learner's turn. The argument confuses two different questions, and
 * a 77-second device recording showed what it costs: the surface read
 * "Listening" for 38 of 38 sampled frames — including the seconds the coach was
 * reading a question aloud — so a learner glancing at the phone was invited to
 * answer a question that had not finished being asked.
 *
 * THE PICTURE DESCRIBES WHAT THE COACH IS DOING. It is not a gate, a
 * permission, or a statement about the microphone: barge-in is available at
 * every moment of a `live` session, exactly as it was before, and
 * `REALTIME_STAGE_TEXT.live` ("Live. Talk to the coach whenever you are ready.")
 * is the sentence that says so. What changes is only that "Speaking" now means
 * the coach is speaking, which `useRealtimePractice` has published as
 * `isCoachSpeaking` since #355 and this screen simply ignored.
 *
 * `speakingQuestion` rather than `speakingAnswer` is arbitrary between the two:
 * `voiceVisualState` maps both to the same `speaking` picture, and on this
 * transport the coach's question and its verdict are one continuous stream with
 * no boundary this side can see.
 *
 * THE OTHER THREE ARE THE STAGES THE SURFACE MUST NOT BE SHOWING AT ALL, and
 * `realtimeSessionIsUnderWay` is what keeps it off the screen for them. They
 * map to `idle` so that the mapping is TOTAL — a `switch` with no `default`,
 * so a sixth stage is a compile error here rather than a silent picture — and
 * the value is deliberately not load-bearing: correctness for `idle`,
 * `fallback` and `ended` comes from the gate excluding them, never from what
 * this function returns for them. `idle` is the right last resort even so: it
 * draws "Paused", and none of the three is a session in progress.
 */
export function realtimeStageAsPhase(
  stage: RealtimePracticeStage,
  isCoachSpeaking: boolean,
): ConversationPhase {
  switch (stage) {
    case 'connecting':
      return 'preparing';
    case 'live':
      return isCoachSpeaking ? 'speakingQuestion' : 'listening';
    case 'idle':
    case 'fallback':
    case 'ended':
      return 'idle';
  }
}

/** `/practice/sessions/:id/summary` for one id, spelled once. */
export function practiceSummaryPath(sessionId: string): string {
  return `/practice/sessions/${sessionId}/summary`;
}

export default function PracticeSessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isMounted = useIsMounted();
  /**
   * Did the tap that created this session ask for the hands-free loop? (#350)
   *
   * The one tap, carried across one navigation — see
   * `components/practice/handsFreeStart.ts` for why this is the router's state
   * and not the stored preference. It is CONSUMED once, below, so a reload of
   * this URL (which restores `history.state`) is a resumed session rather than
   * a second tap.
   */
  const handsFreeRequested = wantsHandsFreeStart(location.state);
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

  // ---------------------------------------------------------------------------
  // Conversation mode (issue #313, epic #304 / E13). See `docs/specs/conversation-mode.md`.
  // ---------------------------------------------------------------------------
  //
  // A SECOND CAPTURE HOOK, NOT A SECOND MODE ON THE FIRST ONE. The hand-driven
  // flow above wants a stream that lives for exactly one hold (E9's behaviour,
  // and the microphone light going out with the learner's last word); the
  // hands-free loop wants one that outlives every answer in the session, so it
  // can hear a barge-in over a question it is still reading
  // (`conversation-mode.md` §2). Those are different lifetimes, and one hook
  // whose `persistent` flag flipped underneath it would be a stream whose
  // teardown rules changed mid-session.
  //
  // Two instances cost nothing until one of them opens a device: this one asks
  // for the microphone only when `start()` is tapped, and `PushToTalkButton` is
  // unmounted for as long as the loop is running, so exactly one of the two is
  // ever holding the device.
  const conversationCapture = useAudioCapture({ persistent: true });

  /**
   * The driver, readable from the detector's callback below.
   *
   * The two hooks are SIBLINGS — `useVoiceActivity`'s events go into
   * `useConversationSession`, and the driver arms and disarms the detector —
   * so one of the two references has to be late. This is it: the detector only
   * ever reads it from a poll, never during render.
   */
  const conversationRef = useRef<UseConversationSessionReturn | null>(null);

  const voiceActivity = useVoiceActivity({
    // `null` until the loop opens the microphone, and inert until then: `arm()`
    // on a null stream reports `unavailable` and starts no timer, which is
    // exactly right for a page sitting in Text mode.
    stream: conversationCapture.stream,
    onEvent: (event) => conversationRef.current?.onVoiceActivityEvent(event),
    // TEST-ONLY, and `undefined` everywhere it is not explicitly set by a
    // Playwright spec — see `getTestVoiceActivityLevelSource`'s own header.
    createLevelSource: getTestVoiceActivityLevelSource(),
  });
  // THE SINGLE READER of the voice roles' binding state. Not `useAiStatus()`
  // and not `unboundRoles` directly — `transcribeBound` is false while the
  // status is still unknown, which is what makes the microphone appear a beat
  // late rather than appear dead.
  const { transcribeBound, isLoading: voiceAvailabilityLoading } =
    useVoiceAvailability();
  /**
   * THE SECOND READER of a role binding, and deliberately a separate hook
   * (#159's own header says why): `transcribe` decides whether a CONTROL
   * appears on a screen that works without it, while `realtime` decides which
   * TRANSPORT the Voice option resolves to. Both are false while the status is
   * unknown, which is what keeps a control from appearing dead rather than
   * appearing a beat late.
   */
  const { realtimeBound, isLoading: realtimeAvailabilityLoading } =
    useRealtimeAvailability();

  // The learner's own voice preferences (#288, epic #280), read through the
  // SAME `useUserSettings` the rest of the app uses — see `useVoicePrefs`.
  // Resolved to the built-in defaults until the settings read lands, so the
  // question is readable from the first paint rather than after a round trip.
  const {
    voice: voicePrefs,
    isLoading: voicePrefsLoading,
    saveVoice,
  } = useVoicePrefs();
  /**
   * Optional on purpose, exactly as in `ExplainPanel`: this page must not blank
   * out when the status provider is absent (a test rendering it in isolation,
   * a future embed). Used for one thing only — re-reading the status after the
   * server has just contradicted it; see the effect below.
   */
  const aiStatus = useOptionalAiStatus();

  /** Which control the learner is using RIGHT NOW. Never resets the session. */
  const [answerMode, setAnswerMode] = useState<AnswerMode>('text');
  /**
   * The stored `voice.conversationMode` has been applied to `answerMode`.
   *
   * ONCE PER MOUNT, and never again: after the first application the mode is
   * the learner's to change on this screen, and a settings read landing later
   * (or a re-read after a preference is written) must not take the microphone
   * away from somebody who has just switched to typing — the same reason
   * `answerMode` is deliberately not reset when the session is re-read.
   */
  const modeSeededRef = useRef(false);
  /**
   * Is the hands-free loop driving right now?
   *
   * A REF because the page's own transcription effect has to read it (see
   * below) and that effect must not re-run when the phase changes. Assigned
   * during render, once the driver exists.
   */
  const conversationRunningRef = useRef(false);
  /**
   * The attempt the loop's NEXT submission supersedes, or `null`.
   *
   * The driver has no attempt id — it hands over a transcript and is told
   * whether it landed — so supersession is this page's business
   * (`useConversationSession`'s `submit` port says so outright). Set from the
   * graded attempt when the loop is about to offer its one retry, and cleared
   * with the rest of the question's state.
   */
  const conversationRetryOfRef = useRef<string | null>(null);
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

  /**
   * Can this deployment's transcription model report a confidence at all?
   * (issue #348, epic #345.)
   *
   * A PROPERTY OF THE DEPLOYMENT, so it is NOT cleared by
   * `clearQuestionState`: it is learned from the first transcription of the
   * session and stays true for every one after it. The post-verdict correction
   * panel needs it after the draft that carried it has been cleared, which is
   * why it does not live on `SpokenDraft` alone.
   *
   * `null` until the first transcription lands, and `spokenDoubt` reads a
   * missing value as today's behaviour — the quieter copy — so a page that has
   * not heard anything yet never apologises for a recording it has not made.
   */
  const [confidenceMeasurable, setConfidenceMeasurable] = useState<
    boolean | null
  >(null);
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
  /**
   * Has this session had a real user gesture yet? (#287)
   *
   * ARMS THE AUTOPLAY OF BOTH PLAYERS — the question's (#311) and the
   * answer's. Browsers refuse sound until the document has been interacted
   * with, so each player is told whether one has happened rather than left to
   * guess. It is set in `submitAttempt` because that funnel is reached from a
   * click or a form submit and from nowhere else — the gesture that produced
   * the verdict IS the gesture that permits reading it out. A blocked play is
   * silent either way; this only keeps the page from asking for sound it knows
   * will be refused.
   */
  const [hasUserGesture, setHasUserGesture] = useState(false);

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
    conversationRetryOfRef.current = null;
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
    // THE HANDS-FREE LOOP OWNS ITS OWN AUDIO. While the driver is running it
    // holds a different capture hook, transcribes that hook's blob itself, and
    // calls `release()` on it in its own `finally` — so this effect must not
    // claim a recording as well. The two hooks are separate instances, which
    // already makes a collision impossible in a browser; the guard is what
    // keeps it impossible in a test that fakes `useAudioCapture` with one
    // shared recorder, and it is cheaper to state than to rediscover as two
    // transcriptions billed to one learner for one answer.
    if (conversationRunningRef.current) return;
    if (!recording || uploadedRef.current === recording) return;
    uploadedRef.current = recording;

    setTranscribing(true);
    setVoiceError(null);
    setVoiceUnavailable(null);

    void (async () => {
      try {
        // THE QUESTION ID, AND ONLY THE ID (issue #348, epic #345). The server
        // turns it into a biasing glossary from its own rows; this page has the
        // question text on screen and still must not send it — see
        // `transcribeAudio`.
        // `?? undefined`, NOT `?? ''`: an absent hint must be an ABSENT form
        // field, and an empty one is a 400 from the id's shape check.
        const result = await transcribeAudio(recording, {
          questionId: questionId ?? undefined,
        });
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
            setSpokenDraft({
              confidence: result.confidence,
              confidenceAvailable: result.confidenceAvailable,
            });
            // REMEMBERED PAST THE DRAFT (issue #348). The post-verdict
            // correction panel reads the confidence off the RECORDED ATTEMPT,
            // by which time the draft has been cleared — but whether a
            // confidence was measurable at all is a property of the deployment,
            // not of the draft, so it outlives it.
            setConfidenceMeasurable(result.confidenceAvailable);

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
    // `questionId` IS A DEPENDENCY EVEN THOUGH IT ONLY DECIDES A HINT: the
    // effect must send the id of the question that is on screen NOW, not the
    // one that was when it last ran. Re-running is free — `uploadedRef` returns
    // early for a recording already sent, so a question change never
    // re-uploads and never re-bills.
  }, [isMounted, questionId, recording, releaseRecording]);

  /**
   * The server has just told us something the cached AI status disagrees with.
   *
   * Re-read it. `transcribeBound` and `realtimeBound` — and therefore which
   * spoken transport the ladder resolves to, the microphone, the Text/Voice
   * picker, and the page-level `VoiceUnavailableNotice` — all render from that
   * one cache, so without this the learner is left holding a control that has
   * already been proven not to work, and the shared notice explaining why never
   * appears. This is the same move `ExplainPanel` makes on its own
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

  /**
   * "Type instead" asked for the answer field, whenever it next exists.
   *
   * Deliberately an effect with NO dependency array: what it waits for is a
   * COMMIT IN WHICH `inputRef.current` is non-null, and that is not any one
   * value it could depend on — it is the render in which the voice surface
   * came down and this page's own form went up.
   *
   * THE REQUEST OUTLIVES A REMOUNT, and that is why the flag is not cleared by
   * the first successful `focus()`. Leaving the surface settles over more than
   * one commit — the loop stops, the other transport is told to stop, the form
   * goes up — and a `<TextField>` that is REMOUNTED rather than re-rendered
   * brings a fresh DOM node with it. jsdom and browsers alike then reset
   * `activeElement` to `<body>` with NO `focusout` event to react to, so a
   * one-shot request focuses a node that is about to be thrown away and the
   * learner is left on `<body>` with nothing coming.
   *
   * So the flag clears only once the node that HAS focus is the same node this
   * effect focused on the previous commit — i.e. it survived a commit. Until
   * then every commit re-applies it. If no further commit arrives, the field is
   * focused anyway and the stale flag costs one `===` per commit.
   */
  const focusAnswerFieldRef = useRef(false);
  const lastFocusedAnswerFieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!focusAnswerFieldRef.current) return;
    const field = inputRef.current;
    if (!field) return;
    if (document.activeElement === field && lastFocusedAnswerFieldRef.current === field) {
      focusAnswerFieldRef.current = false;
      return;
    }
    lastFocusedAnswerFieldRef.current = field;
    field.focus();
  });

  /**
   * Record one attempt, and HAND BACK WHAT WAS GRADED.
   *
   * The return value is #313's one addition: every hand-driven caller ignores
   * it and reads `result` from state exactly as before, but the hands-free
   * loop cannot — `useConversationSession.submit` is a promise of a verdict,
   * because the driver has to decide from it whether to read an answer aloud,
   * offer its one retry, or move on, and it decides that inside an async
   * continuation where this page's `result` state has not been committed yet.
   * `null` means no attempt was recorded.
   */
  const submitAttempt = useCallback(
    async (
      input: Omit<RecordPracticeAttemptInput, 'questionId'>,
      mode: Pending,
    ): Promise<PracticeAttemptResult | null> => {
      if (!id || !question) return null;
      // Reached only from a click or a form submit — see `hasUserGesture`.
      setHasUserGesture(true);
      setPending(mode);
      setActionError(null);
      setSelfMarkError(null);
      try {
        const graded = await recordPracticeAttempt(id, {
          questionId: question.id,
          ...input,
        });
        if (isMounted()) setResult(graded);
        return graded;
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
        return null;
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
  /**
   * Three states, not two (issue #348): measured-and-low, measured-and-fine,
   * and NOT MEASURABLE AT ALL on this deployment. The third is the ordinary
   * case on the recommended model and used to be indistinguishable from the
   * second — see `spokenDoubt`.
   */
  const draftDoubt = spokenDoubt(
    draftConfidence,
    spokenDraft?.confidenceAvailable,
  );

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

  /**
   * Throw it away and type instead — the same clearing, plus the toggle.
   *
   * REACHABLE FROM EVERY PHASE OF THE HANDS-FREE LOOP (#313,
   * `conversation-mode.md` §7's third preserved constraint). `stop('typing')`
   * is the driver's SILENT exit: the learner just asked for this, and being
   * told what you did is not information. Nothing about the session goes with
   * it — the questions already answered, the attempt rows and the progress
   * counter all live on the server, so this changes which control renders and
   * nothing else.
   *
   * It deliberately does NOT write `voice.conversationMode`. Typing for one
   * question on a noisy bus is not a statement about how this learner wants to
   * start their next session; only the mode control itself is.
   */
  const realtimeStopRef = useRef<(() => void) | null>(null);
  const handleTypeInstead = () => {
    conversationRef.current?.stop('typing');
    // The other transport's stop, through a ref for the same reason
    // `conversationRef` is one: this handler is declared above the hook that
    // owns it, and a live voice connection must end from every control that
    // says it will — not only from the ones that happen to sit below it.
    realtimeStopRef.current?.();
    setSpokenDraft(null);
    setResponse('');
    setVoiceError(null);
    setVoiceUnavailable(null);
    releaseRecording();
    setAnswerMode('text');
    // A REQUEST, NOT A CALL (#356). Pressed from the voice surface, the answer
    // field is not in the tree yet — the surface IS the page for as long as the
    // loop runs — so `inputRef.current` is null and a direct `focus()` here
    // would silently do nothing, leaving a keyboard user on a detached node.
    // The effect below performs it on the commit that actually mounts the
    // field. Pressed from the panel, where the field is already mounted, the
    // same effect runs on the very next commit, so nothing about the old
    // behaviour changed.
    focusAnswerFieldRef.current = true;
  };

  // ---------------------------------------------------------------------------
  // The hands-free loop's four ports (#313). The driver is mounted below them.
  // ---------------------------------------------------------------------------

  /**
   * What the loop is having read aloud right now, or `null`.
   *
   * ONE `QuestionAudio` PER UTTERANCE, keyed by `id`. That component autoplays
   * once per `text`, so two identical sentences in a row — an accepted answer
   * repeated after a retry — would be one play and a driver waiting forever on
   * the second. A monotonic key makes every `speak()` a fresh mount and
   * therefore a fresh play, and it costs a remount of a button.
   */
  const [speechRequest, setSpeechRequest] = useState<{
    id: number;
    text: string;
    kind: 'question' | 'answer';
  } | null>(null);
  const speechIdRef = useRef(0);
  /** The pending `speak()`, resolved by `onFinished` or by our own `stop()`. */
  const speechResolveRef = useRef<((outcome: ConversationSpeechOutcome) => void) | null>(
    null,
  );
  const speechPlayerRef = useRef<QuestionAudioHandle | null>(null);

  const settleSpeech = useCallback((outcome: ConversationSpeechOutcome) => {
    const resolve = speechResolveRef.current;
    speechResolveRef.current = null;
    resolve?.(outcome);
  }, []);

  /**
   * The voice, as the driver's port.
   *
   * `question` and `answer` go through `QuestionAudio` — the premium voice, the
   * learner's own rate, the deployment-wide audio cache and a replay button all
   * come with it — and resolve `ended`/`failed` from its `onFinished` (#311).
   * A `cancelled` can only ever come from OUR OWN `stop()`: that component
   * deliberately reports nothing for a cancel, which is exactly what a barge-in
   * needs (the playback it cut off must not later announce itself as finished
   * and move the machine on), so this is where the honest `cancelled` is
   * produced.
   */
  const conversationSpeech = useMemo<ConversationSpeechPort>(
    () => ({
      speak: (text, kind) => {
        // Whatever was speaking is superseded, and its promise settled — a
        // `speak` that never resolves is a loop that never moves.
        settleSpeech('cancelled');
        if (kind === 'nudge') return speakNudge(text);
        return new Promise<ConversationSpeechOutcome>((resolve) => {
          speechResolveRef.current = resolve;
          speechIdRef.current += 1;
          setSpeechRequest({ id: speechIdRef.current, text, kind });
        });
      },
      stop: () => {
        speechPlayerRef.current?.stop();
        // The nudge path has no component to stop — it is a bare utterance on
        // the shared engine, so this is what silences one.
        if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
        settleSpeech('cancelled');
      },
    }),
    [settleSpeech],
  );

  /**
   * Grade one spoken answer for the loop, and answer its three questions.
   *
   * THE SAME `POST /api/practice/sessions/{id}/attempts` E12's auto-submit
   * already sends, with the same `voiceAttemptFields` — there is no second
   * submit path, and epic #304's locked decision 6 (no API change) is kept by
   * this function being a binding rather than a request.
   *
   * `retryOfAttemptId` is supplied HERE because the driver has no attempt id.
   * It is armed only for an attempt that the server would actually accept a
   * retry of — not already a retry, not revealed — which mirrors
   * `canAnswerAgain`'s own conditions rather than discovering them as a 409 a
   * walking learner cannot act on.
   */
  const conversationSubmit = useCallback(
    async (
      transcript: string,
      confidence: number | null,
    ): Promise<ConversationGrade | null> => {
      const graded = await submitAttempt(
        {
          responseText: transcript,
          durationMs: elapsedMs(),
          ...voiceAttemptFields({
            promptWasHeard,
            spokenText: transcript,
            confidence,
            retryOf: conversationRetryOfRef.current,
          }),
        },
        'answer',
      );
      if (!graded) return null;

      const { attempt } = graded;
      conversationRetryOfRef.current =
        attempt.retryOfAttemptId === null && !attempt.revealed ? attempt.id : null;

      return {
        outcome: attempt.outcome,
        // THE SERVER'S OWN COMPOSED TURN, PASSED THROUGH VERBATIM (#375).
        // Never re-derived from `outcome` or `acceptedAnswers` — the previous
        // line here read `graded.acceptedAnswers[0]?.text ?? null`, which is
        // the exact line `apps/api/src/practice/spoken-turn.ts`'s own header
        // names as the defect: a right answer and a wrong one produced
        // byte-identical audio, because the bare accepted answer is the one
        // string that says nothing about which had happened. `VoiceSurface`
        // renders these same two fields, so screen and voice cannot disagree.
        spokenTurn: attempt.spokenTurn,
        retryBoundary: attempt.retryBoundary,
        // The server's own verdict about the recogniser, never this page's.
        misheard: attempt.failureCause === 'misheard',
      };
    },
    [elapsedMs, promptWasHeard, submitAttempt],
  );

  /**
   * `transcribeAudio`, bound to the question on screen (issue #348).
   *
   * A `useCallback` rather than an inline arrow because
   * `useConversationSession` holds this function across a turn: a new identity
   * on every render would be a new function handed to a driver mid-recording.
   * It changes exactly when `questionId` does, which is exactly when the hint
   * should change.
   */
  const conversationTranscribe = useCallback(
    (blob: Blob) => transcribeAudio(blob, { questionId: questionId ?? undefined }),
    [questionId],
  );

  const conversation = useConversationSession({
    capture: conversationCapture,
    voiceActivity,
    speech: conversationSpeech,
    // The identical call the hand-driven transcription effect makes, INCLUDING
    // the question hint (#348). The driver has no idea a hint exists — it hands
    // over a blob and reads a transcript — so binding the id here keeps the two
    // paths from quietly diverging into a hands-free session that transcribes
    // less accurately than the hand-driven one beside it.
    transcribe: conversationTranscribe,
    submit: conversationSubmit,
    // The host's own Next, unchanged. The driver does not wait on it — it
    // waits for `questionId` to change, which is the only signal that means
    // the screen actually moved.
    advance: handleNext,
    questionId,
    questionText: question?.prompt ?? null,
  });

  conversationRef.current = conversation;
  conversationRunningRef.current = conversation.isRunning;

  // ---------------------------------------------------------------------------
  // Realtime practice (issue #355, epic #345 / E15). See `useRealtimePractice`.
  // ---------------------------------------------------------------------------
  //
  // THE SAME MICROPHONE, HANDED OVER — never a second `getUserMedia`. The
  // hands-free loop above and the realtime transport below are two ways of
  // conducting one session, chosen at runtime, so two hooks each opening their
  // own device would mean two live streams on one page: a recorder possibly
  // running on one while the other transmits, and on mobile Safari a second
  // `getUserMedia` that steals the device or fails outright.
  //
  // `conversationCapture` is that one owner. It already asks for
  // `echoCancellation` (`useAudioCapture`'s "THE APP MUST NOT HEAR ITSELF"),
  // which is exactly what `realtime-practice.md` §11 requires on this path, and
  // it is the ONLY thing on this page that stops a microphone track.
  //
  // ONE HONEST COST OF SHARING IT, named rather than left to be discovered:
  // that hook's preflight refuses a browser with no `MediaRecorder`, which a
  // realtime session does not actually need (it streams over WebRTC and records
  // no blob). The refusal is still the right landing: a browser that cannot
  // record also cannot run the request/response loop this transport falls back
  // to, so the ladder's next rung for it is typing either way — and a second
  // acquisition path written to avoid the check would be the second live stream
  // this whole arrangement exists to prevent.
  const realtimeMicrophone = useMemo<RealtimePracticeMicrophonePort>(
    () => ({
      acquire: () => conversationCapture.acquireStream(),
      release: () => conversationCapture.releaseStream(),
      // The six named problems and their six named remedies, unchanged. The
      // two that no amount of trying again can fix are the two the realtime
      // path must not offer a retry for.
      problem:
        conversationCapture.state.status === 'failed'
          ? {
              message: conversationCapture.state.problem.message,
              remedy: conversationCapture.state.problem.remedy,
              retryable:
                conversationCapture.state.problem.code !== 'insecure_origin' &&
                conversationCapture.state.problem.code !== 'unsupported',
            }
          : null,
    }),
    [conversationCapture],
  );

  /**
   * The spoken transport's own voice for its own sentences.
   *
   * `speakNudge`, not `QuestionAudio`: these are five-word pieces of the app's
   * own scaffolding — "the connection stopped" — not content, so they take the
   * browser's free engine rather than the learner's key and the deployment-wide
   * audio cache. The coach's actual words are spoken by the coach, over the
   * live connection, and never pass through here.
   */
  const speakRealtimeLine = useCallback((text: string) => {
    void speakNudge(text);
  }, []);

  const realtime = useRealtimePractice({
    sessionId: id ?? null,
    microphone: realtimeMicrophone,
    speak: speakRealtimeLine,
    // NEVER MINT FOR A SESSION WITH NOTHING LEFT TO ASK (§10). `question` is
    // the server's own answer to that, re-read on every refresh.
    hasQuestion: question !== null,
  });

  realtimeStopRef.current = realtime.stop;

  /**
   * WHICH SPOKEN TRANSPORT, DECIDED ONCE. See `resolveVoiceTransport`.
   *
   * Everything below reads this — the picker's visibility, which panel mounts,
   * and what happens when the realtime transport gives up mid-session. No
   * control anywhere on this page re-derives the answer from `realtimeBound`
   * or `transcribeBound` on its own.
   */
  const voiceTransport = resolveVoiceTransport({
    realtimeBound,
    transcribeBound,
    realtimeFallback: realtime.fallback?.code ?? null,
  });

  /**
   * Attach the coach's voice.
   *
   * `srcObject` rather than a URL: the remote track is a live `MediaStream` and
   * there is no file to point at. Guarded because a test's audio element and
   * some older engines have no `srcObject` setter, and a screen that threw here
   * would take the practice session down over the audio element rather than
   * over the audio. A blocked autoplay is swallowed: the tap on Start normally
   * satisfies the gesture requirement, and an alert about an autoplay policy is
   * not something a learner can act on.
   *
   * A CALLBACK REF HELD IN STATE, NOT A `useRef` (#381). The element moves
   * between two trees now: while the live session is under way it is the voice
   * surface's hidden `children`, and at every other stage it is the inline
   * panel's. Those are two different returns of this component, so the node is
   * unmounted and a new one mounted on the swap — and a `useRef` would leave
   * this effect with no reason to re-run, because `realtime.remoteStream` did
   * not change. The result would be a fresh `<audio>` with no `srcObject`: a
   * coach that is connected, billing, and silent. Storing the node in state
   * makes its identity a dependency, so attaching the stream happens on
   * whichever element is currently mounted.
   */
  const [realtimeAudioElement, setRealtimeAudioElement] =
    useState<HTMLAudioElement | null>(null);
  const realtimeStream = realtime.remoteStream;
  useEffect(() => {
    const element = realtimeAudioElement;
    if (!element) return;
    try {
      element.srcObject = realtimeStream;
    } catch {
      return;
    }
    if (realtimeStream) void element.play?.().catch(() => undefined);
  }, [realtimeAudioElement, realtimeStream]);

  /**
   * The conversation moved, so re-read the session from the server.
   *
   * THE PAGE COUNTS NOTHING, HERE LEAST OF ALL. A realtime attempt is recorded
   * by the engine, inside the tool-call route, and the browser is told only
   * which question is outstanding now — a join key. So a change in it is the
   * signal to ask the server what the truth is, exactly as a reload would;
   * `answered`, `planned` and the next question all come back from
   * `GET /api/practice/sessions/:id` and from nowhere else.
   */
  const realtimeQuestionId = realtime.questionId;
  const realtimeStage = realtime.stage;
  useEffect(() => {
    // A finished or abandoned spoken session is the other moment the server
    // knows something this screen does not — the last answer it recorded, and
    // whether anything is left to ask. Re-reading here is what makes the
    // handover to typing (or to E13's loop) land on the real state rather than
    // on whatever was on screen when the conversation started.
    const settled = realtimeStage === 'ended' || realtimeStage === 'fallback';
    if (!realtimeQuestionId && !settled) return;
    void refresh();
  }, [realtimeQuestionId, realtimeStage, refresh]);

  /**
   * When E13's request/response loop started, for the surface's cost clock.
   *
   * ISSUE #387. The realtime transport publishes its own `startedAt`; this is
   * the same fact for the other spoken transport, and it is held here rather
   * than inside `useConversationSession` because it is the PAGE that decides
   * which transport the surface is rendering for and therefore which start it
   * shows. `null` while nothing is running, so a stopped-and-restarted loop
   * gets a new clock rather than resuming the old one.
   */
  const conversationIsRunning = conversation.isRunning;
  const [conversationStartedAt, setConversationStartedAt] = useState<number | null>(
    null,
  );
  useEffect(() => {
    setConversationStartedAt((current) =>
      conversationIsRunning ? (current ?? Date.now()) : null,
    );
  }, [conversationIsRunning]);

  /**
   * Land on the mode the learner asked for, once.
   *
   * TWO SOURCES, AND THE TAP OUTRANKS THE PREFERENCE (#350, epic #345):
   *
   *  1. **The hand-off**, when this session was started from `/practice` with
   *     Voice chosen. It does NOT wait on the settings read: the `PATCH` that
   *     stored that choice may still be in flight, so `voice.conversationMode`
   *     can honestly answer with the document as it was a moment ago. The tap
   *     is both newer and already here — see `handsFreeStart.ts`.
   *  2. **The stored preference**, for every other arrival — a resumed
   *     session, a reload, a link. That one DOES wait for both reads to
   *     settle: `voice.conversationMode` says what the learner wants and the
   *     role bindings say whether this deployment can offer it, and seeding
   *     before either lands would put a learner who chose Voice on Text (or,
   *     worse, on a Voice mode this deployment cannot record in) and then move
   *     the control under them.
   *
   * THE LADDER IS READ HERE, NOT RE-DERIVED (#355, epic #345 / E15). The
   * question this effect asks is "can this deployment conduct a spoken session
   * at all", and `voiceTransport` is the one place that is decided — for
   * `realtime` and `transcribe` together. Gating on `transcribeBound` alone
   * would leave a deployment that has bound `realtime` and not `transcribe`
   * putting a learner who asked for hands-free practice on Text, beside a
   * Voice button that would have worked. That is why the hand-off below waits
   * on the availability reads even though it does not wait on the settings
   * read: the tap says what the learner wants, and only the ladder knows
   * whether this deployment can honour it.
   */
  useEffect(() => {
    if (modeSeededRef.current) return;
    if (voiceAvailabilityLoading || realtimeAvailabilityLoading) return;
    if (handsFreeRequested && voiceTransport !== null) {
      modeSeededRef.current = true;
      setAnswerMode('voice');
      return;
    }
    if (voicePrefsLoading) return;
    modeSeededRef.current = true;
    if (voicePrefs.conversationMode && voiceTransport !== null) setAnswerMode('voice');
  }, [
    handsFreeRequested,
    realtimeAvailabilityLoading,
    voiceAvailabilityLoading,
    voicePrefs.conversationMode,
    voicePrefsLoading,
    voiceTransport,
  ]);

  /**
   * The learner chose how to answer — for this session AND for the next one.
   *
   * TWO THINGS HAPPEN HERE, and both are the point of #313:
   *
   *  1. **The gesture is recorded.** `hasUserGesture` used to be set in
   *     `submitAttempt` and nowhere else, so nothing had armed autoplay before
   *     the FIRST answer of a session — a learner who turned
   *     `voice.readQuestionsAloud` on got silence on question 1, which is the
   *     one question they most clearly asked to hear. A tap on this control is
   *     a real interaction with the document, which is all a browser wants.
   *  2. **The choice is stored**, through the same `PATCH /api/user-settings`
   *     every other preference uses, and with the same `writeFor` null-delete:
   *     returning to the built-in default sends `null`, never today's value.
   *     So the mode survives a reload, which is what makes "one tap" true on
   *     the second session as well as the first.
   */
  const chooseAnswerMode = (next: AnswerMode) => {
    setHasUserGesture(true);
    if (next === answerMode) return;
    setAnswerMode(next);
    // Leaving Voice ends whichever transport is running — silently, because
    // the learner just asked for it. Both are named rather than only the one
    // `voiceTransport` currently resolves to: a mid-session fallback changes
    // that value underneath this handler, and the loop that is actually live
    // at the moment of the tap is the one that has to stop.
    if (next !== 'voice') {
      conversationRef.current?.stop('typing');
      realtime.stop();
    }
    void saveVoice({
      conversationMode: writeFor(next === 'voice', DEFAULT_VOICE_CONVERSATION_MODE),
    });
  };

  /**
   * The loop's last word, when there is no question left to render it beside.
   *
   * `null` unless Voice is the mode and there is something to say — see the
   * panel itself for why the notice outlives the question.
   */
  const conversationNotice =
    answerMode === 'voice' && voiceTransport === 'request_response'
      ? conversation.notice
      : null;

  /**
   * The realtime transport's last word, which OUTLIVES its own panel.
   *
   * A mid-session fallback unmounts the realtime panel by definition — that is
   * what falling back means — so a notice rendered inside it would vanish at
   * the exact moment it was needed. It is rendered above both panels instead,
   * beside the picker, which is where the learner is now looking.
   */
  const realtimeNotice = answerMode === 'voice' ? realtime.notice : null;

  /**
   * The device preflight (issue #349, epic #345).
   *
   * Mounted unconditionally — the hook observes and never prompts (see its
   * header), so there is no cost to having it running on a screen whose learner
   * never chooses Voice, and no `getUserMedia` is reachable from it. What is
   * RENDERED from it is gated on the voice panel below, because a deployment
   * with `transcribe` unbound has no spoken session for a microphone problem to
   * be about.
   */
  const mediaReadiness = useMediaReadiness();

  /**
   * The problem the loop's own panel shows, or `null`.
   *
   * Held as state rather than read straight off `mediaReadiness.problem` so the
   * pre-Start re-check has somewhere to put a verdict that the rendered state
   * has not caught up with yet: `recheck()` is synchronous by design and its
   * asynchronous half settles a tick later, so a Start refused on a permission
   * that was revoked one second ago must not render nothing while it waits.
   */
  const [startBlockedBy, setStartBlockedBy] = useState<AudioCaptureProblem | null>(
    null,
  );

  /**
   * The observed preflight caught up and says everything is fine.
   *
   * Without this, a refusal recorded by `recheck()` would OUTLIVE the problem
   * it described: a learner told "your browser is blocking the microphone",
   * who allows it in another tab, gets `PermissionStatus`'s `change` — which
   * clears `mediaReadiness.problem` — and would still be reading the refused
   * message, because `startBlockedBy` takes precedence over it. That is the
   * "still blocked after I fixed it" failure `useMediaReadiness`'s own header
   * calls out, reintroduced one layer up.
   */
  const observedProblem = mediaReadiness.problem;
  useEffect(() => {
    if (!observedProblem) setStartBlockedBy(null);
  }, [observedProblem]);

  /**
   * One tap: the gesture that arms audio, and the loop.
   *
   * THE FAST RE-CHECK (#349). Permission can be revoked between the picker and
   * this tap — in another tab, or from the browser's own site-settings panel —
   * so the preflight is re-read here rather than trusted from whenever the page
   * mounted. It is deliberately SYNCHRONOUS: this tap is the user gesture that
   * lets the page play audio at all, and awaiting a device enumeration before
   * `conversation.start()` would spend it on a promise. See
   * `useMediaReadiness`'s header.
   *
   * A blocked microphone stops here, with `describeCaptureProblem`'s own copy,
   * and typing is one control away on the same screen — nothing about the
   * session is lost.
   */
  const handleStartConversation = () => {
    const problem = mediaReadiness.recheck();
    setStartBlockedBy(problem);
    if (problem) return;
    setHasUserGesture(true);
    conversation.start();
  };

  /**
   * One tap: the gesture that arms audio, and the live voice session.
   *
   * THE SAME FAST RE-CHECK (#349) the hands-free loop does, for the same
   * reason: permission can be revoked between the picker and this tap, in
   * another tab or from the browser's own site-settings panel. It is
   * deliberately synchronous — this tap is the user gesture that lets the page
   * play the coach's audio at all, and awaiting a device enumeration would
   * spend it.
   *
   * A BLOCKED MICROPHONE STOPS HERE, before any mint. `realtime-practice.md`
   * §10: a mint on the learner's own key, for a session they have no
   * microphone to speak into, spends their money on nothing — and the hook
   * itself makes the same check again from its own side, because a permission
   * can also disappear between this tap and the `getUserMedia` it leads to.
   */
  const handleStartRealtime = () => {
    const problem = mediaReadiness.recheck();
    setStartBlockedBy(problem);
    if (problem) return;
    setHasUserGesture(true);
    realtime.start();
  };

  /**
   * The other half of the one tap (#350, epic #345).
   *
   * The learner tapped "Start a Quick 5" on `/practice` with Voice chosen. That
   * tap created the session and brought them here; it also has to arm the loop,
   * or "one tap" is two — choose Voice, then find Start again on a screen they
   * did not ask to stop on.
   *
   * IT GOES THROUGH THE SAME HANDLERS A TAP DOES, never `conversation.start()`
   * or `realtime.start()` directly, so the automatic path and the manual one
   * are the same path: the same synchronous device re-check (#349), the same
   * refusal copy in the same place, the same `hasUserGesture`. A blocked
   * microphone therefore stops here exactly as it stops a tap, with the loop
   * unarmed, the explicit Start control on screen and typing one control away.
   *
   * WHICH HANDLER IS THE LADDER'S DECISION, NOT THIS EFFECT'S (#355). It reads
   * `voiceTransport`, the single decision site, rather than asking about
   * bindings itself — otherwise a deployment with `realtime` bound and
   * `transcribe` unbound would arm nothing at all for a learner who asked for
   * hands-free practice.
   *
   * IT WAITS FOR THE QUESTION. `conversation.start()` returns silently with no
   * `questionText`, so arming before the session's first read lands would be a
   * start that never happened and a learner waiting for a voice.
   *
   * IT ALSO WAITS FOR THE PREFLIGHT (`isChecking`). `recheck()` is synchronous
   * because a TAP must not be spent on a promise, and it reads a live
   * `PermissionStatus` that does not exist until the first probe resolves — so
   * an automatic arm firing the instant the question lands could pass a check
   * that had nothing to check yet, and open the microphone on a device that had
   * already refused. One tick of latency is not a cost here: nobody is waiting
   * on a control they just pressed, and the tap that authorised sound happened
   * on the previous screen and stays authorised.
   *
   * IT RUNS ONCE, AND THEN THE HAND-OFF IS CLEARED. `history.state` survives a
   * reload, and a reload is not a tap: a learner who comes back to a session
   * mid-way is RESUMING, which `#350` keeps the explicit arm control for. The
   * `replace` navigation is what makes the difference visible to the next
   * mount.
   */
  const handsFreeConsumedRef = useRef(false);
  useEffect(() => {
    if (!handsFreeRequested || handsFreeConsumedRef.current) return;
    if (!question || voiceTransport === null || answerMode !== 'voice') return;
    if (mediaReadiness.isChecking || conversation.isRunning || realtime.stage !== 'idle') {
      return;
    }
    handsFreeConsumedRef.current = true;
    navigate(location.pathname, { replace: true, state: null });
    if (voiceTransport === 'realtime') handleStartRealtime();
    else handleStartConversation();
    // The two handlers are re-created every render and deliberately not
    // dependencies: this effect fires once, guarded by its own ref, and adding
    // them would only re-run a body that returns immediately.
  }, [
    answerMode,
    conversation.isRunning,
    handsFreeRequested,
    location.pathname,
    mediaReadiness.isChecking,
    navigate,
    question,
    realtime.stage,
    voiceTransport,
  ]);

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
  const gradedDoubt = spokenDoubt(
    result?.attempt.asrConfidence,
    confidenceMeasurable,
  );

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
    if (voiceTransport !== null) setAnswerMode('voice');
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
      const completed = await completePracticeSession(id);

      // THE CLOSING TURN (#352, epic #345), IN VOICE MODE ONLY.
      //
      // The server composed it — `spokenTurn` on the session, from the same
      // `coachReaction` the summary screen is about to render, so the line
      // heard here and the line read there are the same string by
      // construction. This page picks nothing and rewrites nothing.
      //
      // `[]` is the ordinary answer for a learner who has turned
      // `coach.reactions` off, and speaking an empty array is silence. THERE
      // IS NO SUPPRESSION BRANCH HERE and there must not be one: the
      // preference became `null` once, server-side, in `toCoachReaction`.
      //
      // The loop is stopped with `'learner'` first — the silent reason — so
      // the driver does not narrate an exit over the top of the coach.
      if (answerMode === 'voice' && completed.spokenTurn.length > 0) {
        conversationRef.current?.stop('learner');
        await speakClosingTurn(completed.spokenTurn);
      }

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

  // THE SPINNER IS FOR THE FIRST READ ONLY (#387).
  //
  // `usePracticeSession.refresh` sets `isLoading` on EVERY re-read, and this
  // page re-reads on every question — after a typed attempt, and on every
  // change of `realtime.questionId`. A bare `if (isLoading)` therefore replaced
  // the whole page with a spinner once per question, which unmounted whatever
  // was on screen and mounted a fresh copy when the request returned: on the
  // voice surface that meant a full-screen flash mid-session and, because that
  // component's elapsed clock started at MOUNT, a cost timer that restarted on
  // every question (measured at 0:09, then 0:04, then 0:11 across a 68-second
  // session). `detail` is what the page renders from, so once there is one, a
  // refresh is a background read and the screen keeps rendering the session it
  // already has.
  if (isLoading && !detail) {
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

  /**
   * =============================================================================
   * THE VOICE SURFACE (#356, epic #345)
   * =============================================================================
   *
   * ENTERED WHEN A VOICE SESSION IS RUNNING, LEFT WHEN IT STOPS. It is a
   * DIFFERENT SCREEN, not this one restyled: everything below this branch —
   * the answer field, the correction card, the feedback stack, the explain
   * panel — belongs to the text path and stays exactly as it was for it.
   *
   * NOTHING IS LOST BY THE SWAP, and that is structural rather than careful.
   * This is a `return` inside the same component instance, so every piece of
   * state on this page (`result`, `progress`, `question`, `promptWasHeard`,
   * `hasUserGesture`, the retry refs) survives untouched; and the facts that
   * matter — which questions are answered and what the counter reads — were
   * never in the browser to begin with, they are the server's
   * (`GET /api/practice/sessions/:id`). Leaving voice mode therefore returns
   * to the identical page, mid-session, with the identical counter.
   *
   * THE GATE IS "A SPOKEN SESSION IS UNDER WAY", NOT `answerMode`. A learner
   * sitting in Voice with nothing armed is on the ordinary page, with the Start
   * control, the preflight notice and the microphone all where #313, #349 and
   * #350 put them — the surface is for a session that is actually under way,
   * which is the only state in which a learner is not looking at the screen.
   *
   * AND "UNDER WAY" IS TWO TRANSPORTS, NOT ONE (#381). `conversation.isRunning`
   * belongs to E13's request/response driver and is `false` for the entire life
   * of a realtime session, which reports through `realtime.stage` instead. So
   * on any deployment with a `realtime` model bound — where
   * `resolveVoiceTransport` returns `'realtime'`, which is the FIRST rung of
   * the ladder and therefore the common case — this branch could never be
   * taken: a learner who asked to talk got the typing layout, the "Your answer"
   * field and the keyboard, with a status line above it. Worse, this surface is
   * the only renderer of `heard` and of #351's composed turn, so the coach's
   * verdict was invisible on the transport that has no feedback stack of its
   * own. `realtimeSessionIsUnderWay` is that transport's own answer to the same
   * question, and the two are ORed rather than merged: neither driver knows the
   * other exists, and neither should.
   *
   * WHICH ONE IS DRIVING DECIDES FOUR PROPS, and E13 wins a tie. The two
   * transports cannot both be running — they share one microphone and the
   * ladder mounts one panel at a time — but the branch is written to be total
   * rather than to rely on that, and taking E13 first is what keeps this path
   * byte-identical for it.
   *
   * The running transport's player goes in as `children` (hidden — see
   * `VoiceSurface`'s own header) and, for E13, the wake-lock nudge as
   * `footnote`: both are the host's, and neither is the surface's business to
   * know about. The realtime transport has no wake lock of its own, so it
   * passes nothing rather than borrowing a caption about a hook it never calls.
   */
  const realtimeUnderWay = realtimeSessionIsUnderWay(realtime.stage);
  /**
   * Which transport the surface is rendering for.
   *
   * `false` means E13's loop — including the impossible case of both being
   * live, where E13's existing behaviour is what survives.
   */
  const surfaceIsRealtime = !conversation.isRunning && realtimeUnderWay;

  /**
   * The coach's voice, declared once and mounted in exactly one of two places.
   *
   * While the live session is under way it belongs to the surface (as hidden
   * `children`); at every other stage it belongs to the inline panel below.
   * It is the same element in both, so a learner who stops and starts again is
   * not depending on two copies staying in step. See
   * `realtimeAudioElement`'s effect for what re-attaches the stream across the
   * remount that the move costs.
   */
  const realtimeCoachAudio = (
    <audio
      ref={setRealtimeAudioElement}
      autoPlay
      hidden
      data-testid="realtime-coach-audio"
    />
  );

  if (conversation.isRunning || realtimeUnderWay) {
    return (
      <VoiceSurface
        phase={
          surfaceIsRealtime
            ? realtimeStageAsPhase(realtime.stage, realtime.isCoachSpeaking)
            : conversation.phase
        }
        // THE RUNNING TRANSPORT'S OWN SESSION START (#387), never the mount.
        // The surface measures one continuous span — the session a learner is
        // paying for by the minute — and it is remounted by anything that
        // briefly takes it off the screen, so mount time is not that span. See
        // `VoiceSurface`'s own `startedAt` comment.
        startedAt={surfaceIsRealtime ? realtime.startedAt : conversationStartedAt}
        // THE SAME TABLE THE RUNNING DRIVER SPEAKS FROM — its own, never the
        // other's. Two renderings of one fact, per transport: that is why this
        // is a prop rather than a lookup inside `VoiceSurface` (its own doc
        // comment says so), and `REALTIME_STAGE_TEXT` is what the realtime
        // panel's status region already renders below.
        phaseText={
          surfaceIsRealtime
            ? REALTIME_STAGE_TEXT[realtime.stage]
            : CONVERSATION_PHASE_TEXT[conversation.phase]
        }
        notice={
          surfaceIsRealtime
            ? (realtime.notice?.message ?? null)
            : (conversation.notice?.message ?? null)
        }
        questionNumber={question?.number ?? null}
        questionPrompt={question?.prompt ?? null}
        position={position}
        planned={planned}
        // #347's RMS publisher, finally consumed. See `VoiceStateVisual`.
        getLevel={voiceActivity.getLevel}
        // What was actually graded, and only for an answer that was SPOKEN: a
        // typed attempt was not "heard" by anything, and saying it was would
        // be this screen inventing a recognition step that never ran.
        //
        // THE RUNNING TRANSPORT'S OWN, because the two do not write the same
        // field (#381). E13's loop submits through this page, so `result` is
        // where its transcript lands; a realtime attempt is recorded by the
        // engine inside the tool-call route and never sets `result` at all —
        // `realtime.heard` is the provider's own transcript, and it is what
        // the inline panel renders as "Heard: …" today. Reading `result` on
        // that transport would render nothing, every time.
        heard={
          surfaceIsRealtime
            ? realtime.heard
            : result && result.attempt.inputMode === 'spoken'
              ? (result.attempt.transcript ?? result.attempt.responseText)
              : null
        }
        // #351's composed turn, rendered rather than re-derived — see
        // `VoiceSurface`'s header for why a second description of one verdict
        // is worse than none.
        //
        // E13'S, AND EMPTY ON THE REALTIME TRANSPORT — where it is `result`
        // that is empty, because that transport's coach SAYS its own verdict
        // over the live connection and the engine records the row without this
        // page ever holding one. There is no realtime field to read here, and
        // inventing a second wording for a verdict the learner is currently
        // being spoken is the exact thing #351 removed.
        spokenTurn={result?.attempt.spokenTurn ?? []}
        retryBoundary={result?.attempt.retryBoundary ?? null}
        // STOP THE TRANSPORT THAT IS ACTUALLY RUNNING. Stopping E13's driver
        // while a live session is up would return a learner to the ordinary
        // page with the connection still open and still billing by the minute
        // — the one failure `REALTIME_BILLING_SENTENCE` promises against.
        onStop={surfaceIsRealtime ? realtime.stop : () => conversation.stop()}
        // Unchanged, and already correct for both: it stops BOTH transports
        // by name, for the reason its own comment gives.
        onTypeInstead={handleTypeInstead}
        footnote={
          !surfaceIsRealtime && !conversation.wakeLock.isSupported ? (
            <Typography
              variant="caption"
              color="text.secondary"
              component="p"
              sx={{ mt: 1, textAlign: 'center' }}
            >
              This browser can&rsquo;t keep the screen awake, so keep the page
              open while you practise.
            </Typography>
          ) : null
        }
      >
        {surfaceIsRealtime
          ? realtimeCoachAudio
          : speechRequest && (
              <QuestionAudio
                key={speechRequest.id}
                ref={speechPlayerRef}
                text={speechRequest.text}
                autoPlay
                premiumVoice={voicePrefs.preferPremiumVoice}
                voice={voicePrefs.preferredVoice}
                rate={voicePrefs.speechRate}
                onPlayed={() => {
                  if (speechRequest.kind === 'question') setPromptWasHeard(true);
                }}
                onFinished={(event) =>
                  settleSpeech(event.reason === 'ended' ? 'ended' : 'failed')
                }
              />
            )}
      </VoiceSurface>
    );
  }

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

        {/* `actionError` USED TO RENDER HERE, and it moved into the page's one
            live region below (#358, epic #345). It was a `role="alert"` of its
            own — a second live region mounted beside the verdict's, competing
            to announce — and it is about the button the learner just pressed,
            which is what that region is for. Below the question card it also
            lands beside the control that produced it instead of above the
            progress bar, two screens away on a phone. */}

        {(question || conversationNotice || realtimeNotice) && (
          // `&:empty` — this wrapper's children (the unbound-transcribe
          // notice, the Text/Voice choice, the hands-free panel, the live
          // voice panel) can all render null at once while the AI status is
          // still loading, and an empty `div` with a 24px margin is 24px of
          // nothing at the top of a screen #358 is trying to shorten. `:empty`
          // matches only an element with no children at all, which is exactly
          // that case.
          <Box sx={{ mb: 3, '&:empty': { display: 'none', mb: 0 } }}>
            {/* MOUNTED UNCONDITIONALLY. It renders null unless `transcribe` is
                KNOWN to be unbound, which is why it can sit here rather than
                behind a condition this page would have to get right — and it
                is NOT the app-wide `AiNotReady` for `systemReady === false`,
                which is a different problem with a different remedy. The two
                are never merged.

                IT SITS BESIDE THE MODE CONTROL (#313) because it is the
                explanation for the missing option: with `transcribe` unbound
                there is no Voice to choose, and "why not" belongs where the
                choice would have been rather than further down the page. */}
            {question && <VoiceUnavailableNotice />}

            {/* THE LIVE VOICE TRANSPORT'S LAST WORD, ABOVE BOTH PANELS.

                It is rendered here rather than inside the realtime panel
                because the event it most often describes — a mid-session
                fallback — unmounts that panel by definition. The sentence is
                the one that was SPOKEN, rendered verbatim rather than
                rewritten: two renderings of one fact, never two facts.

                `role="status"`, not `role="alert"`: the connection stopping is
                not an error a learner has to act on. Their answers are already
                recorded, and the control they need is the one right below
                this. */}
            {realtimeNotice && (
              <Alert
                severity="info"
                role="status"
                onClose={realtime.dismissNotice}
                sx={{ mb: 2 }}
              >
                {realtimeNotice.message}
              </Alert>
            )}

            {/* THE SESSION-WIDE PICKER (#313, epic #304 / E13).

                ABOVE THE QUESTION, not beside the answer field, because it is
                no longer a per-question choice about which control to type
                into: it decides how this whole session is conducted, and
                `docs/specs/conversation-mode.md` §7 amends `voice.md` §5 —
                formally, on the record — to allow exactly that. `Decisions
                locked` #6 there locks OPTIONALITY, not the granularity of the
                picker: this is still a choice, still reversible at every phase,
                and still not the only way to answer.

                THE VOICE OPTION IS ABSENT, NOT DISABLED, when no `transcribe`
                model is bound (`conversation-mode.md` §10's own row, and
                `voice.md` §1's "hidden, not disabled" rule reused unchanged).
                Caught here, at the moment the mode is chosen — never mid-walk,
                which is the failure locked decision 4 exists to prevent. With
                nothing to choose between, the whole group goes: a one-button
                picker is a control that cannot be operated, and the notice
                above has already said why.

                THE SAME CONTROL `/practice` RENDERS (#350, epic #345), not a
                second one built here: the choice is now made before a session
                exists, and this is where it stays REVERSIBLE. One component,
                so the two screens cannot drift in what they offer or in how
                they are announced.

                GATED ON `voiceTransport`, NOT ON `transcribeBound` (#355): the
                ladder is decided in one place, so a deployment with `realtime`
                bound and `transcribe` unbound still offers Voice here. */}
            {question && voiceTransport !== null && (
              <AnswerModeChoice value={answerMode} onChange={chooseAnswerMode} />
            )}

            {/* THE LOOP'S OWN CONTROLS AND ITS ONE STATUS REGION.

                EVERYTHING IT SAYS IS ALSO WRITTEN DOWN. The driver speaks
                every phase change and every involuntary exit, because a
                walking learner is not reading the screen — but a learner who
                glances at it, has sound off, or is using a screen reader has
                otherwise no way to tell listening from thinking from stopped.
                One `role="status"` region, mounted from the first render of
                this branch and empty until there is something to say. */}
            {answerMode === 'voice' && voiceTransport === 'request_response' && (
              <Paper variant="outlined" sx={{ mt: 2, p: { xs: 2, sm: 2.5 } }}>
                {/* THE CONTROLS NEED A QUESTION; THE NOTICE DOES NOT. The loop
                    stopping BECAUSE the session ran out of questions is exactly
                    the case where `question` is already null, and a panel that
                    unmounted with it would take the one sentence explaining
                    what just happened off the screen at the moment it was
                    said. */}
                {question && (
                  <>
                  <Typography variant="body2" color="text.secondary">
                    Hands-free practice reads each question aloud, listens for
                    your answer, and moves on by itself. You can stop, or go back
                    to typing, at any moment.
                  </Typography>

                  {/* THE PREFLIGHT, BESIDE THE CONTROL IT IS ABOUT (#349,
                      epic #345). Two things reach it, and they are the same
                      shape by design: whatever the observed preflight already
                      knows, and whatever the Start tap's own re-check found a
                      moment ago. The re-check wins when it has an answer,
                      because it is the newer read of the two.

                      IT IS UNCONDITIONAL SINCE #356. It used to be gated on
                      `!conversation.isRunning`, because a stale warning over a
                      live microphone would contradict the phase line right
                      underneath it. That state no longer exists: a running
                      loop is on the voice surface, which this whole panel is
                      unreachable from. A device lost MID-session still arrives
                      as a capture failure and exits the loop with the same
                      copy — see `useConversationSession`'s own failure
                      effect. */}
                  <MicrophoneReadinessNotice
                    problem={startBlockedBy ?? mediaReadiness.problem}
                    audioSuspended={mediaReadiness.isAudioOutputSuspended}
                    sx={{ mt: 2 }}
                  />

                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    sx={{ mt: 2, alignItems: { xs: 'stretch', sm: 'center' } }}
                  >
                    {/* START ONLY. Stop lives on the voice surface (#356),
                        which is the whole screen for as long as the loop is
                        running — this branch is unreachable then, and a second
                        Stop here would be a control the learner can never see
                        beside a state it can never describe. */}
                    <Button
                      variant="contained"
                      startIcon={<MicIcon />}
                      onClick={handleStartConversation}
                      disabled={pending !== null}
                    >
                      Start hands-free
                    </Button>
                    {/* REACHABLE AT EVERY PHASE. This copy covers `idle` —
                        Voice chosen, loop unarmed — which is the phase the
                        control is easiest to lose, because it belongs to no
                        state of the driver. The other six are on the voice
                        surface, where the same control is anchored outside
                        every scrolling region (#356). */}
                    <Button variant="text" onClick={handleTypeInstead}>
                      Type instead
                    </Button>
                  </Stack>
                  </>
                )}

                {/* THE PHASE SENTENCE IS NOT HERE ANY MORE (#356). Every
                    phase but `idle` is on the voice surface, and
                    `CONVERSATION_PHASE_TEXT.idle` is the empty string by
                    design — so this region's only content was, and now
                    visibly is, the loop's last word. */}
                <Box role="status" aria-live="polite" sx={{ mt: 1 }}>
                  {conversation.notice && (
                    <Typography variant="body2" color="text.secondary">
                      {conversation.notice.message}
                    </Typography>
                  )}
                </Box>

                {conversation.notice && (
                  <Button
                    size="small"
                    variant="text"
                    onClick={conversation.dismissNotice}
                  >
                    Dismiss
                  </Button>
                )}

              </Paper>
            )}

            {/* THE LIVE VOICE PANEL (#355, epic #345 / E15).

                MOUNTED ONLY WHEN THE LADDER SAYS `realtime`, and unmounted the
                moment it says anything else — which is what a mid-session
                fallback IS. Nothing in here is a second copy of the loop above:
                the two panels are two transports for one session, and only one
                of them can be on screen at a time.

                THERE IS NO PUSH-TO-TALK CONTROL HERE AND THERE MUST NEVER BE
                ONE. The microphone is open for the whole session so the coach
                can be interrupted mid-sentence; a hold-to-talk button would be
                a half-duplex gate on a full-duplex transport
                (`services/realtimeConnection.ts`'s own header). */}
            {answerMode === 'voice' && voiceTransport === 'realtime' && (
              <Paper variant="outlined" sx={{ mt: 2, p: { xs: 2, sm: 2.5 } }}>
                <Typography variant="body2" color="text.secondary">
                  Live voice practice is a conversation: the coach asks, you
                  answer out loud, and you can interrupt at any time. You can
                  stop, or go back to typing, whenever you like.
                </Typography>

                {/* THE PREFLIGHT, BESIDE THE CONTROL IT IS ABOUT (#349). Not
                    rendered once the session is live: a live session has a live
                    microphone by definition, and a stale warning above it would
                    contradict the line right underneath. */}
                {realtime.stage !== 'live' && (
                  <MicrophoneReadinessNotice
                    problem={startBlockedBy ?? mediaReadiness.problem}
                    audioSuspended={mediaReadiness.isAudioOutputSuspended}
                    sx={{ mt: 2 }}
                  />
                )}

                {/* THE BILLING SENTENCE, ONCE, ON THE CONTROL THAT STARTS THE
                    MODE — and the honest sentence about echo beside it. See
                    `REALTIME_BILLING_SENTENCE` and `REALTIME_ECHO_SENTENCE`. */}
                {realtime.stage !== 'live' && (
                  <>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mt: 2 }}
                    >
                      {REALTIME_BILLING_SENTENCE}
                    </Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ mt: 1 }}
                    >
                      {REALTIME_ECHO_SENTENCE}
                    </Typography>
                  </>
                )}

                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  spacing={1}
                  sx={{ mt: 2, alignItems: { xs: 'stretch', sm: 'center' } }}
                >
                  {realtime.stage === 'live' || realtime.stage === 'connecting' ? (
                    <Button
                      variant="outlined"
                      startIcon={<StopIcon />}
                      onClick={realtime.stop}
                    >
                      Stop
                    </Button>
                  ) : (
                    <Button
                      variant="contained"
                      startIcon={<MicIcon />}
                      onClick={handleStartRealtime}
                      disabled={pending !== null || question === null}
                    >
                      Start live voice
                    </Button>
                  )}
                  {/* REACHABLE AT EVERY STAGE, exactly as it is in the loop
                      above: there is no moment in this transport where the way
                      back to typing is missing. */}
                  <Button variant="text" onClick={handleTypeInstead}>
                    Type instead
                  </Button>
                </Stack>

                {/* ONE STATUS REGION, MOUNTED FROM THE FIRST RENDER of this
                    branch and empty until there is something to say. Everything
                    the transport says out loud is also written down here — a
                    learner who glances at the screen, has sound off, or is
                    using a screen reader has otherwise no way to tell connected
                    from connecting from stopped. */}
                <Box role="status" aria-live="polite" sx={{ mt: 1 }}>
                  {REALTIME_STAGE_TEXT[realtime.stage] && (
                    <Typography variant="body2" color="text.secondary">
                      {REALTIME_STAGE_TEXT[realtime.stage]}
                    </Typography>
                  )}
                  {realtime.heard && (
                    <Typography variant="body2" color="text.secondary">
                      Heard: {realtime.heard}
                    </Typography>
                  )}
                </Box>

                {/* THE COACH'S VOICE. `hidden` because there is no control to
                    offer — pausing a conversation is not a thing this transport
                    does, and the control that matters is Stop, above.

                    THE SAME ELEMENT THE SURFACE MOUNTS (#381), declared once
                    above the branch. This copy is the one on screen at `idle`,
                    `fallback` and `ended`; the surface holds it for
                    `connecting` and `live`, and only ever one of the two is in
                    the tree. */}
                {realtimeCoachAudio}
              </Paper>
            )}
          </Box>
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
                installation that has not bought one.

                MOUNTED ONLY WHILE THIS QUESTION IS STILL OPEN (#358, epic
                #345). Two conditions, and each removes a player that is
                redundant at that moment rather than one a learner might want:

                  * `result === null` — once a verdict is up, the thing worth
                    hearing is the ANSWER, and `AttemptFeedback` mounts a
                    player for it. Both at once is two text buttons and two
                    status lines for one sentence anybody would play. The
                    question's player comes straight back on Next, and on a
                    correction (which clears `result`).
                  * `!conversation.isRunning` — the loop reads the question
                    through its own player, whose end it is waiting on. A
                    second control for the same sentence, beside a driver that
                    is already speaking it, is the one press that makes the
                    loop hear an end it did not cause.

                Unmounting also STOPS whatever it was reading: `QuestionAudio`
                cancels on unmount, which is what keeps a question from being
                read over the answer that just replaced it. */}
            {result === null && !conversation.isRunning && (
            <Box sx={{ mt: 1, ml: -1 }}>
              <QuestionAudio
                text={question.prompt}
                // THE PAGE OWNS THE ONE LIVE REGION (#358). This player's
                // states are already carried by the control the learner just
                // operated — the button's own accessible name is "Read the
                // question aloud" / "Preparing the voice…" / "Stop reading" —
                // and its one failure message points at the prompt rendered
                // directly above it. A second region competing with the
                // verdict's for the same announcement is worse for a
                // screen-reader user than one region that says the right
                // thing.
                announce={false}
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
                // ONLY FOR A LEARNER WHO ASKED, and only once the document has
                // had a gesture — the same two halves, in the same order, that
                // `AttemptFeedback` gates the ANSWER's mount on, because the
                // browser refuses sound until it has been interacted with
                // either way. Until #311 this mount passed no `autoPlay` at
                // all, so `voice.readQuestionsAloud` was a switch on
                // `/settings/voice` that did nothing and explained nothing.
                //
                // QUESTION 1 NOW SPEAKS (#313). `hasUserGesture` is no longer
                // set only in `submitAttempt` — the Text/Voice tap and the
                // hands-free Start both arm it, which is how the first question
                // of a session gets the gesture a browser insists on before any
                // sound at all.
                //
                // THE LAST TWO CLAUSES CLOSE THE TRANSIENT #311 LEFT BEHIND.
                // `hasUserGesture` still flips false → true inside
                // `submitAttempt` for a learner who never touches the mode
                // control, and this prop's effect keys on its own value: that
                // flip alone would re-read the question at the exact moment the
                // verdict appeared. `setPending` is committed in the same batch
                // as the gesture, so from the first submit onwards this is
                // false for the rest of the question and the re-read cannot
                // happen. It re-arms when Next clears both.
                //
                // AND NOT WHILE THE LOOP IS DRIVING, or the same sentence plays
                // twice: conversation mode reads the question through its own
                // player (`speechRequest`), which is the one whose end it is
                // waiting on.
                autoPlay={
                  voicePrefs.readQuestionsAloud &&
                  hasUserGesture &&
                  pending === null &&
                  result === null &&
                  !conversation.isRunning
                }
              />
            </Box>
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

              {/* THE HAND-DRIVEN MICROPHONE, and NOT while the loop is
                  driving: two controls holding two microphones over one answer
                  is one recording too many, and the "hold to talk" invitation
                  is wrong for a learner who has just been told to answer when
                  they are ready. Voice mode without the loop running is
                  E9/E12's per-question flow, unchanged in every particular —
                  `conversation-mode.md` §10's own degradation row keeps it as
                  the behaviour of Voice mode when the loop is not armed. */}
              {answerMode === 'voice' &&
                voiceTransport === 'request_response' &&
                !conversation.isRunning && (
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
                        this block only exists while the ladder has resolved
                        Voice to the request/response transport — which it can
                        only do while `transcribeBound` is true — and that
                        notice only renders while it is false. The
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
                            {draftDoubt === 'low'
                              ? 'That may not be what you said.'
                              : 'Is this what you said?'}
                          </AlertTitle>
                          {/* THREE STATES SINCE #348, and the third is not a
                              worse version of the second. `unmeasured` means
                              this deployment's model reports no confidence at
                              all, so nothing checked this transcript and
                              saying nothing would imply something did.
                              `low` still means we measured and doubted it,
                              which is a stronger and rarer claim. */}
                          <Typography variant="body2" sx={{ mb: 1.5 }}>
                            {draftDoubt === 'low'
                              ? 'Your recording was hard to make out, so this is more likely our mistake than yours. Read it below, change anything that is wrong, or record it again — nothing has been graded yet.'
                              : draftDoubt === 'unmeasured'
                                ? 'We cannot tell how clearly that came through, so please read it before it is graded. Change anything that is wrong, or record it again — nothing is graded until you choose Use this answer.'
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

              {/* GONE ONCE A VERDICT IS UP (#358, epic #345). All three are
                  `disabled` while `result !== null` — they were three dead
                  controls between the learner's answer and the verdict about
                  it, on the phone screen this issue is trying to shorten, and
                  three more stops for anybody tabbing to the next action. What
                  replaces them is `AttemptFeedback`'s own primary action,
                  which is the only thing any of them could have done next.

                  A WRAPPING ROW, NOT A COLUMN ON `xs`: full-width stacking
                  turned three buttons into three rows. */}
              {result === null && (
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  mt: 2,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  rowGap: 1,
                }}
              >
                {/* INERT WHILE THE LOOP IS DRIVING, all three of them. The
                    driver is about to submit this question itself, and a hand
                    on Submit, Show me the answer or Skip in the middle of that
                    is two attempts at one question — the second of which the
                    server would refuse as a retry of a retry. The escape is
                    "Type instead", which is on screen at every phase and ends
                    the loop before handing the question back. In Text mode, and
                    in Voice mode with the loop idle, `isRunning` is false and
                    nothing about these three has changed. */}
                <Button
                  type="submit"
                  variant="contained"
                  size="large"
                  disabled={
                    !trimmed ||
                    pending !== null ||
                    result !== null ||
                    conversation.isRunning
                  }
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
                  disabled={pending !== null || result !== null || conversation.isRunning}
                >
                  {pending === 'reveal' ? 'Showing…' : 'Show me the answer'}
                </Button>
                <Button
                  variant="text"
                  color="inherit"
                  onClick={handleSkip}
                  disabled={pending !== null || result !== null || conversation.isRunning}
                >
                  {pending === 'skip' ? 'Skipping…' : 'Skip'}
                </Button>
              </Stack>
              )}
            </Box>
          </Paper>
        )}

        {/* THE PAGE'S ONE LIVE REGION — "what just happened to the thing you
            last pressed" (#358, epic #345).

            MOUNTED FROM THE FIRST RENDER AND EMPTY UNTIL THERE IS SOMETHING TO
            SAY. That ordering is what makes the announcement happen at all — a
            live region inserted at the same moment as its content is commonly
            missed entirely — and it is the justification for the one
            always-mounted empty element this screen keeps.

            IT CARRIES BOTH OUTCOMES OF AN ACTION, AND THAT IS THE POINT.
            `actionError` (a submit, skip, reveal or finish that failed) used to
            be its own `role="alert"` above the progress bar: a second live
            region, mounted beside this one, competing to announce, and two
            screens from the button that produced it on a phone. A verdict and a
            failure are the same event from the learner's side — "I pressed
            something; here is what came of it" — so they share the region and
            never both need reading.

            EVERYTHING NESTED INSIDE IS `role="presentation"` OR HAS NO REGION
            OF ITS OWN: the self-mark error, the coach's reaction line, the
            accepted answer's player. A live region inside a live region is how
            the same sentence is read twice. */}
        <Box role="status" aria-live="polite" sx={{ mt: 2 }}>
          {actionError && (
            <Alert
              severity="error"
              role="presentation"
              sx={{ mb: result ? 2 : 0 }}
            >
              {actionError}
            </Alert>
          )}

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
                // THE SAME STORED PREFERENCES the question's player above
                // reads (#288), pointed at the answer (#287). `readAnswersAloud`
                // is its own switch, not `readQuestionsAloud`: wanting the
                // question read is not the same wish as wanting the answer
                // read back.
                readAnswersAloud={voicePrefs.readAnswersAloud}
                hasUserGesture={hasUserGesture}
                premiumVoice={voicePrefs.preferPremiumVoice}
                preferredVoice={voicePrefs.preferredVoice}
                speechRate={voicePrefs.speechRate}
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
            `gradedDoubt` chooses the WORDS and nothing else, and the
            confidence number itself is never rendered (`voice.md` §3.1). Since
            #348 it has three values rather than two: on a deployment whose
            model reports no confidence — the recommended one — `voice.md` §3's
            misheard protection cannot fire at all, and this panel IS the
            protection that replaces it, so the copy says so instead of
            implying a check that never ran.

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
                {gradedDoubt === 'low'
                  ? 'That may not be what you said.'
                  : 'This is what we heard.'}
              </AlertTitle>
              <Typography variant="body2" sx={{ mb: 1, fontStyle: 'italic' }}>
                &ldquo;{gradedTranscript}&rdquo;
              </Typography>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                {gradedDoubt === 'low'
                  ? 'Your recording was hard to make out, so anything wrong above is more likely our mistake than yours. Please check it — putting it right replaces this attempt and costs you nothing.'
                  : gradedDoubt === 'unmeasured'
                    ? 'We have no way to tell how clearly that came through, so please check it yourself. If those are not your words, put it right — that replaces this attempt, does not count as a second question, and costs you nothing.'
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
