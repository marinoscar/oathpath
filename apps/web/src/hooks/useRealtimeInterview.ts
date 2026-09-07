/**
 * One realtime (spoken) mock interview, as React state — issue #159,
 * epic #60 / E11.
 *
 * The single owner of everything the realtime screen renders, and the only
 * place the relay loop lives. `RealtimeInterviewPage` reads; it never grades,
 * never counts, never chooses a question, and never decides a phase is over.
 *
 * Shaped after `useMockInterview` (#140) — the same `isMounted` discipline, the
 * same "an error is a string the page renders, never a thrown exception"
 * contract, the same server-is-the-truth posture — over a transport that stays
 * open instead of one request per turn.
 *
 * =============================================================================
 * THE BROWSER IS A RELAY. IT DECIDES NOTHING.
 * =============================================================================
 *
 * `docs/specs/realtime-interview.md` §4, and issue #155's statement of the risk
 * the whole epic is organised around: "a speech-to-speech model asked to
 * conduct a civics interview will happily invent a civics question from memory
 * and declare an answer correct."
 *
 * Three tools arrive over the data channel. Each one is posted, unexamined, to
 * `POST /api/interviews/:id/realtime/tool-calls`, and whatever comes back is
 * handed to the model VERBATIM. Nothing in this file reads a `civics_questions`
 * row, compares an answer to anything, counts a correct answer, or looks at a
 * pass mark — there is no such value here to look at.
 *
 * A REFUSAL IS A NORMAL RESULT, NOT AN ERROR. The route answers a rejected
 * tool call with HTTP 200 and an `instruction` field, and relaying that
 * instruction is what gets the interview moving again. Treating it as a
 * failure would leave the officer holding a tool call that never resolves —
 * a live conversation that has silently stopped, with nothing on screen to say
 * so, which is the worst failure mode this screen has.
 *
 * =============================================================================
 * THE TWO EXCEPTIONS, AND NEITHER IS A SECOND OPINION (issue #400)
 * =============================================================================
 *
 * A `grade_answer` is refused here, and never posted, in exactly two cases: the
 * microphone produced no applicant speech at all since the question was asked,
 * and the transcript the model reports is the officer's own last utterance
 * coming back through the loudspeaker. Both are questions about PROVENANCE —
 * did these words come from the applicant? — and neither reads a transcript for
 * meaning, compares anything to an accepted answer, or forms a verdict of any
 * kind. The section above is untouched by them: this file still holds no
 * civics row, no answer, no tally and no pass mark to decide anything with.
 *
 * WHAT THEY BUY IS THAT AN ANSWER NOBODY GAVE CANNOT BE RECORDED, and on this
 * transport that is a larger claim than on practice's. An honoured
 * `grade_answer` here writes a `practice_attempts` row with
 * `source: mock_interview`, moves `mock_interviews.civics_asked` and
 * `civics_correct` — the inputs to the stop rule and to `passedCivics` — adds a
 * `mock_interview_turns` row, and feeds the readiness recompute at completion.
 * The evidence that the room was silent, or that the room was only this
 * application's own loudspeaker, exists in this process and nowhere else, so
 * the engine cannot make either check for itself.
 *
 * Both are ported from `useRealtimePractice.ts` (issues #399 and #403), which
 * closed the identical hole on the practice transport: `heardThisTurnRef` is
 * the first, `speechEvidenceSeenRef` is why absence alone is never enough to
 * refuse on, and `lib/coachEcho.ts` — reused, never forked — is the second.
 *
 * AND THE FIRST OF THE TWO MEASURES A FASTER CLOCK (issue #403), which is
 * ported here in the same change rather than left for later. Asked on
 * `conversation.item.input_audio_transcription.*` alone, "has the applicant
 * said anything this turn?" is answered by a SEPARATE, SLOWER pipeline than the
 * speech-to-speech model's own hearing — and the model does not wait for it. So
 * a `grade_answer` for a real answer can be decided while the guard's answer is
 * still "not yet", and the guard refuses it. That is #403's own 17-27s
 * signature, and on this transport it lands worse than it did on practice's:
 * practice's refusal has the coach read the question out again, while this
 * one's is deliberately silent (see {@link NOTHING_HEARD_INSTRUCTION}), so the
 * officer simply waits, the applicant is told nothing, and the rehearsal stalls
 * with nothing on screen — the failure this file's own header calls the worst
 * one this screen has. The turn detector's `speech_started`/`speech_stopped`
 * edges now count as the same evidence and arrive in time to be useful; see
 * `voiceActivity`.
 *
 * THE ECHO GUARD IS DISARMED FOR THE READING PHASE, AND ONLY THERE. The officer
 * SAYS the reading sentence aloud — `interviews.service.ts` composes that turn
 * as intro + `OFFICER_TURN_SEPARATOR` + `english_sentences.text` and pushes it
 * to `spoken`, and `realtime-interview.md` §5 says the same thing ("the
 * officer's tool-mediated turn presents one `english_sentences` row verbatim,
 * the learner reads it aloud") — and the applicant is then required to say
 * those exact words back. A provenance test has no discriminating power there
 * BY CONSTRUCTION: a correct reading attempt IS the officer's last utterance,
 * word for word, so an armed guard would refuse precisely the right answers,
 * which is the worst false positive available. The nothing-heard guard stays
 * armed throughout reading — the applicant does speak.
 *
 * =============================================================================
 * THE WRITING SENTENCE NEVER REACHES THE DOM. TWICE OVER.
 * =============================================================================
 *
 * `english-test.md` §4: the writing test is a DICTATION, so a screen that
 * printed the sentence would not be showing the learner the question — it would
 * be showing them the answer. On this transport the sentence necessarily passes
 * THROUGH the browser (it is the relay between the engine and the model), so
 * the rule is a DOM invariant enforced here, exactly as `CLAUDE.md` already
 * states it for the request/response transport.
 *
 * Two separate leaks are closed, and they are separate:
 *
 *  1. **The tool result.** `next_question` returns `speakOnly: true` for a
 *     writing sentence. {@link toTranscriptEntry} stores `text: null` for such
 *     a turn — the raw string goes to `connection.sendToolResult` and nowhere
 *     else, and there is no branch in this file that puts a `speakOnly` result's
 *     `text` into state.
 *  2. **The officer's own spoken transcript.** The provider transcribes the
 *     officer's audio, and that audio IS the dictated sentence. A live
 *     transcript that rendered it would leak the sentence by the back door
 *     while the tool result was being scrupulously withheld at the front.
 *     {@link UseRealtimeInterviewReturn.transcript} therefore withholds every
 *     officer utterance for as long as a `speakOnly` item is outstanding.
 *
 * A test asserts the sentence appears nowhere in `document.body`.
 *
 * =============================================================================
 * EVERY FAILURE ENDS AT THE TEXT INTERVIEW, WITH THE SAME INTERVIEW ID
 * =============================================================================
 *
 * §12's third locked decision: "The text interview never goes away." An unbound
 * `realtime` role, a refused microphone, a handshake that never completes and a
 * secret that expires mid-conversation all resolve to the same place, because
 * the engine's state — which question is next, how many have been asked, whether
 * the stop rule has fired — is server-side and untouched by which transport is
 * driving it. Falling back is a TRANSPORT CHANGE, not a restart, and nothing a
 * learner has already answered is asked again.
 *
 * A dropped connection is re-minted first, up to {@link MAX_RECONNECTS} times
 * (§3): the secret is short-lived by design, and a fresh mint resolves the
 * interview's CURRENT engine state, so the officer resumes at whatever question
 * comes next rather than at the first one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isLikelyCoachEcho } from '../lib/coachEcho';
import {
  completeInterview,
  createRealtimeSession,
  getInterview,
  sendRealtimeToolCall,
} from '../services/api';
import {
  isRealtimeToolName,
  openRealtimeConnection,
  type RealtimeConnection,
  type RealtimeProviderError,
  type RealtimeSpeechEvent,
  type RealtimeToolCallEvent,
  type RealtimeVoiceActivityEvent,
} from '../services/realtimeConnection';
import {
  classifyGetUserMediaError,
  describeCaptureProblem,
  type AudioCaptureProblem,
} from './useAudioCapture';
import { useIsMounted } from './useIsMounted';
import type {
  AiUnavailableCause,
  Interview,
  InterviewDebrief,
  InterviewPhase,
  InterviewProgress,
  RealtimeToolCallInput,
  RealtimeToolCallResponse,
} from '../types';

/**
 * How many times a dropped connection is re-minted before falling back.
 *
 * BOUNDED, and the bound is small on purpose. Each attempt is a mint on the
 * learner's own key and a handshake they are sitting in silence through; a
 * loop that kept trying would spend their money to keep them waiting, and §7
 * says a failed connection "falls back to text after a bounded number of retry
 * attempts" rather than persisting.
 */
export const MAX_RECONNECTS = 2;

/** Why the spoken interview cannot continue. A closed set, each with a remedy. */
export type RealtimeFallbackCode =
  /** No mint was attempted: `realtime` unbound, AI off, or no key stored. */
  | 'ai_unavailable'
  /** There is no live microphone, so no mint was attempted either (§7). */
  | 'microphone'
  /** The mint was attempted and did not produce a usable session. */
  | 'mint_failed'
  /** The handshake never completed. */
  | 'connection_failed'
  /** It dropped mid-interview and could not be re-established. */
  | 'connection_lost';

export interface RealtimeFallback {
  code: RealtimeFallbackCode;
  /** What happened, one sentence, in the learner's terms. Never generic. */
  message: string;
  /** What they can do about it, or null when there is genuinely nothing. */
  remedy: string | null;
  /**
   * Set only for `ai_unavailable` — WHICH of the four causes.
   *
   * `no_user_key` is the learner's own to fix and gets its own copy; the other
   * three are an administrator's, and the screen renders the shared
   * `AiNotReady` naming the `realtime` role for those. Collapsing them would
   * tell somebody with no key stored that their administrator has not finished
   * setting something up.
   */
  cause: AiUnavailableCause | null;
  /** Whether pressing "try again" could plausibly help. */
  retryable: boolean;
}

/**
 * One line of the live conversation.
 *
 * `text: null` is NOT "they said nothing" — it is WITHHELD, and the only thing
 * that is ever withheld is the writing test's dictated sentence. See the file
 * header. A renderer must say what is happening rather than render an empty
 * bubble.
 */
export interface RealtimeTranscriptEntry {
  id: string;
  role: 'officer' | 'applicant';
  phase: InterviewPhase;
  /** What was said, or `null` when it must not be shown. */
  text: string | null;
  /** True once this utterance is finished. Drives `aria-busy`. */
  final: boolean;
}

/** What the officer is currently waiting on, when it is the learner's typing. */
export interface RealtimeWritingPrompt {
  /** The `english_sentences` id a `grade_answer` must name. */
  itemId: string;
}

/** Where the spoken interview has got to. */
export type RealtimeStage =
  /** Nothing has been attempted yet. */
  | 'idle'
  /** Microphone, mint, handshake — in that order. */
  | 'connecting'
  /** The conversation is live. */
  | 'live'
  /** It cannot continue by voice. See {@link UseRealtimeInterviewReturn.fallback}. */
  | 'fallback'
  /** The learner ended it, or the officer finished. */
  | 'ended';

export interface UseRealtimeInterviewReturn {
  interview: Interview | null;
  isLoading: boolean;
  loadError: string | null;

  stage: RealtimeStage;
  /** Set exactly when `stage === 'fallback'`. */
  fallback: RealtimeFallback | null;

  /**
   * The live conversation, for the screen to render.
   *
   * DISPLAY, AND STILL ONLY DISPLAY. What reaches the engine is the transcript
   * the MODEL reports on its own `grade_answer` call; nothing in this array is
   * ever sent anywhere, and nothing here is compared to an accepted answer.
   *
   * Since #400 an applicant speech event ALSO sets a provenance flag on its way
   * past — that SOME speech arrived this turn, never what it said — and the
   * officer's completed utterances are kept in a ref for the echo check.
   * Neither of those reads these entries, and neither is a second opinion about
   * a verdict; see the file header.
   */
  transcript: RealtimeTranscriptEntry[];
  /** True while the officer's words are still arriving. */
  isOfficerSpeaking: boolean;

  /**
   * One sentence about a provider error, or `null` (#385).
   *
   * NOT A FALLBACK AND NOT AN ENDING. The provider reports errors that end a
   * single TURN as well as ones that end a session, and the two are not
   * distinguishable from the payload — so the interview is left running and
   * the applicant is told, once, that the officer may have missed something.
   * Silence with nothing on screen is what #385 measured, and it is the one
   * outcome that is definitely wrong.
   *
   * Code-owned copy. The provider's own code and prose go to the console, for
   * a developer; an applicant cannot act on either.
   */
  providerNotice: string | null;

  phase: InterviewPhase | null;
  progress: InterviewProgress | null;
  awaitingCompletion: boolean;

  /**
   * Set while the writing test is waiting on typing, and `null` otherwise.
   *
   * The sentence itself is NOT on this shape and never will be — see the file
   * header. All a screen needs to render the dictation is that one is
   * outstanding.
   */
  writingPrompt: RealtimeWritingPrompt | null;

  /** The officer's voice. Attach it to an audio element. */
  remoteStream: MediaStream | null;

  /** Begin: microphone, then mint, then handshake. Never throws. */
  start: () => void;
  /** Try the whole of `start` again after a retryable fallback. */
  retry: () => void;

  /** Send the learner's typed answer to the writing test. Never throws. */
  submitWriting: (text: string) => void;
  isSubmittingWriting: boolean;

  isCompleting: boolean;
  completeError: string | null;
  /**
   * End the session and finish the interview.
   *
   * Closes the connection and stops every media track BEFORE the request, then
   * completes. Resolves to the debrief, or null when the call failed.
   */
  end: () => Promise<InterviewDebrief | null>;
}

/**
 * The fallback a session that was already live ends at.
 *
 * ONE OBJECT FOR BOTH WAYS OF GETTING HERE — a channel that closed, and a
 * re-mint that failed — because from the learner's side they are the same
 * event: the officer stopped talking and is not coming back. §3 treats them
 * the same way too ("if re-minting itself fails... the interview falls back to
 * the text transport with progress intact"), and a screen that told them their
 * AI provider had refused a mint would be explaining the wrong layer.
 */
/** Rendered when the provider reports an error mid-interview (#385). */
export const REALTIME_INTERVIEW_PROVIDER_ERROR_LINE =
  'The voice connection hit a snag. If the officer goes quiet, say “could you ' +
  'repeat that” — or end the interview and carry on in text.';

const CONNECTION_LOST: RealtimeFallback = {
  code: 'connection_lost',
  message: 'The voice connection dropped and could not be re-established.',
  remedy:
    'You can carry on in text — the interview picks up exactly where it left off.',
  cause: null,
  retryable: false,
};

/**
 * The instruction this hook sends when it refuses a `grade_answer` (#400).
 *
 * WORDED FROM THE ENGINE'S OWN VOCABULARY, not invented here. Both sentences
 * are `interviews/realtime/realtime-tool-calls.ts`'s: the first is its
 * `answer_outstanding` rejection, which covers the neighbouring situation
 * exactly ("the applicant has not yet answered the question you last asked")
 * and asks for precisely the move that is wanted here; the second is the tail
 * of its `CONTINUE_INSTRUCTION`, which every refusal on that route already ends
 * with. That file's own reason for having one constant applies to having this
 * one match it: a model handed two slightly different phrasings for the same
 * situation is a model choosing between them.
 *
 * NOTHING IS ASKED FOR OUT LOUD, and that is the interview-specific half of the
 * decision. Practice's equivalent has the coach call `repeat_question`; there
 * is no such tool in this contract, and a real officer does not re-ask because
 * the room was noisy — `mock-interview.md`'s realism argument. So the applicant
 * hears nothing at all: no verdict is stated or implied, no acknowledgement is
 * spoken, and `OFFICER_VERDICT_PROHIBITION` is untouched by either refusal.
 */
const NOTHING_HEARD_INSTRUCTION =
  'Wait for the applicant to answer, then call grade_answer with what you ' +
  'heard. Do not tell the applicant anything happened.';

/**
 * The same refusal, for a `grade_answer` that reported the officer's own words.
 *
 * ONE SENTENCE MORE THAN {@link NOTHING_HEARD_INSTRUCTION}, naming what
 * happened, because it is something the model can act on: an echo means the
 * question reached the room, and what has not happened yet is a reply to it.
 * The recovery is identical, and deliberately the same string, so the two
 * refusals cannot drift apart.
 */
const ECHOED_QUESTION_INSTRUCTION =
  'That was your own voice coming back, not the applicant. ' +
  NOTHING_HEARD_INSTRUCTION;

export function useRealtimeInterview(
  id: string | null | undefined,
): UseRealtimeInterviewReturn {
  const [interview, setInterview] = useState<Interview | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(id));
  const [loadError, setLoadError] = useState<string | null>(null);

  const [stage, setStage] = useState<RealtimeStage>('idle');
  const [fallback, setFallback] = useState<RealtimeFallback | null>(null);

  const [transcript, setTranscript] = useState<RealtimeTranscriptEntry[]>([]);
  const [isOfficerSpeaking, setIsOfficerSpeaking] = useState(false);
  const [providerNotice, setProviderNotice] = useState<string | null>(null);

  const [phase, setPhase] = useState<InterviewPhase | null>(null);
  const [progress, setProgress] = useState<InterviewProgress | null>(null);
  const [awaitingCompletion, setAwaitingCompletion] = useState(false);
  const [writingPrompt, setWritingPrompt] =
    useState<RealtimeWritingPrompt | null>(null);
  const [isSubmittingWriting, setIsSubmittingWriting] = useState(false);

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);

  const [isCompleting, setIsCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const connectionRef = useRef<RealtimeConnection | null>(null);
  const startingRef = useRef(false);
  const reconnectsRef = useRef(0);

  /**
   * The officer's next line, held across a reconnect.
   *
   * On the FIRST connection this is the opening turn, which
   * `POST /api/interviews` already returned and which the tool-call route
   * therefore never serves — #158 flagged this explicitly, and without it the
   * interview opens in silence while the model waits for a `next_question`
   * result the engine has no reason to produce.
   *
   * On a RECONNECT it is whatever the officer last said, so the resumed session
   * repeats the outstanding question instead of starting the conversation over.
   * That includes a writing sentence, which is the one line the browser cannot
   * re-read from the transcript route — the API deliberately never stores it
   * (`interviews.service.ts`: "the writing sentence is never written into the
   * transcript"), so holding it here is what makes a resumed dictation possible
   * at all.
   */
  const pendingLineRef = useRef<string | null>(null);

  /**
   * True while an officer utterance must not be rendered.
   *
   * Set by a `speakOnly` tool result and cleared when that item is graded. The
   * officer's spoken audio during a dictation IS the sentence, so a live
   * transcript without this flag would print the answer the tool result was so
   * carefully withholding. See the file header.
   */
  const withholdOfficerRef = useRef(false);

  // ---------------------------------------------------------------------------
  // DID THE MICROPHONE HEAR THE APPLICANT THIS TURN? (issue #400)
  // ---------------------------------------------------------------------------
  //
  // The two checks on this transport that are not a relay, ported from
  // `useRealtimePractice.ts` (#399), which closed the identical hole for spoken
  // practice. They live here rather than server-side because the evidence lives
  // only here: the provider's transcription of the APPLICANT'S INPUT AUDIO
  // arrives on the browser's own data channel and reaches no other process.
  // Until #400 it was folded into the rendered transcript and otherwise
  // discarded, so what the model CLAIMED to have heard was never set against
  // what the microphone actually picked up — and the officer's own question,
  // returning through the phone's speaker, was believed all the way into a
  // `practice_attempts` row about an answer nobody gave.
  //
  // THEY DECIDE NOTHING ABOUT CORRECTNESS. Neither reads a transcript for
  // meaning, neither has an accepted answer to read, and neither can express a
  // verdict: one is a boolean about whether any speech arrived, the other a
  // boolean about where a string came from. The grading ladder is still the
  // engine's, and still the only one.

  /**
   * Has the provider transcribed any applicant speech since the officer's last
   * question?
   *
   * RESET WHEN A QUESTION IS ASKED, never on a timer: a turn is bounded by the
   * question it belongs to, and a clock would decide that an applicant who
   * thought for eleven seconds had not spoken. The reset happens in `relay`, on
   * an honoured `next_question` — which is the only thing that opens a turn on
   * this transport. Practice has a second reset condition and this deliberately
   * does not; see that call site.
   */
  const heardThisTurnRef = useRef(false);

  /**
   * Has this hook EVER seen the provider report applicant speech, BY ANY MEANS?
   *
   * THE DIFFERENCE BETWEEN "HEARD NOTHING" AND "DOES NOT REPORT HEARING", and
   * without it the guard above is a brick rather than a safeguard. A realtime
   * session transcribes its input only when the mint asked it to, and turn
   * detection is a session setting in exactly the same way; a deployment where
   * NEITHER reaches the provider — an older API behind a cached bundle, a model
   * that ignores the fields — would produce no applicant-speech events of any
   * kind. Enforcing on absence there would refuse EVERY answer of every
   * interview, which is a far worse failure than the one being fixed: an
   * applicant whose whole rehearsal records nothing, days before the
   * appointment it exists to prepare them for.
   *
   * BY ANY MEANS is what #403 widened it to, and the wording is load-bearing:
   * both the transcription events and the turn detector's edges set it, through
   * the one writer below, so a deployment that reports speech by either route
   * arms the guard and one that reports it by neither leaves it open.
   *
   * So the guard arms itself only once the provider has PROVEN it reports
   * applicant speech: fail OPEN until then, closed ever after. Monotonic, and
   * never reset — including across a re-mint, because it describes the
   * deployment rather than the connection.
   */
  const speechEvidenceSeenRef = useRef(false);

  /**
   * The last thing the officer finished saying, as the provider transcribed its
   * OWN output.
   *
   * HELD FOR ONE PURPOSE ONLY (#400): so a `grade_answer` reporting those exact
   * words can be recognised as the loudspeaker rather than the applicant. See
   * `lib/coachEcho.ts`, which is where the comparison lives and where its
   * bluntness is argued — reused here, never forked.
   *
   * ONLY THE LAST COMPLETED UTTERANCE, not a history. An echo is of what was
   * just played, and keeping the officer's whole side of the conversation would
   * be keeping every question asked to compare answers against — a much larger
   * surface, for a case that does not happen.
   *
   * NOT `withholdOfficerRef`, AND NOT AN EXCEPTION TO IT — the two must not be
   * conflated, which is why this says so rather than leaving it to be noticed.
   * The withholding rule is a DOM invariant (this file's own header section):
   * the writing test's dictated sentence must never be RENDERED. What is kept
   * here is never rendered, never put in state and never sent anywhere; it is
   * read by one pure function, and both refusal payloads that function can lead
   * to are code-owned constants carrying no transcript. So nothing leaks by
   * keeping it during a dictation — and it MUST be kept there: `writing` is the
   * one phase where the officer's spoken words ARE the answer, so an echoed
   * `grade_answer` would score as a perfect one.
   *
   * A genuine writing answer is out of reach of both guards by construction: it
   * is TYPED, and `submitWriting` relays it with `relay(..., null)` without
   * passing through `handleToolCall` at all. A model-originated `grade_answer`
   * during the dictation is caught by the nothing-heard guard too — the
   * applicant said nothing, because they were writing.
   */
  const officerUtteranceRef = useRef<string | null>(null);

  /**
   * May the echo check refuse a `grade_answer` in the phase now running?
   *
   * FALSE FOR `reading`, AND ONLY FOR `reading`. The officer says the reading
   * sentence aloud and the applicant is required to say those exact words back,
   * so a correct reading attempt IS the officer's last utterance, word for
   * word. `isLikelyCoachEcho` therefore has no discriminating power there by
   * construction, and an armed guard would refuse precisely the right answers —
   * the worst false positive available. The file header carries the full
   * argument and the two sources that establish it.
   *
   * ARMED BY DEFAULT, so a phase this hook has not yet been told about is
   * guarded rather than exempt. Set from the ENGINE's own `phase` on each
   * honoured `next_question`, beside the turn reset, so the arming and the turn
   * can never be describing different questions.
   */
  const echoGuardArmedRef = useRef(true);

  /** Start a fresh turn: nothing has been heard for the question just asked. */
  const beginTurn = useCallback(() => {
    heardThisTurnRef.current = false;
  }, []);

  /**
   * Record that the microphone produced applicant speech in this turn.
   *
   * ONE WRITER FOR BOTH EVIDENCE SOURCES (#403), so the two flags can never be
   * set by one and not the other — {@link speechEvidenceSeenRef} is what makes
   * the guard fail open on a deployment that reports neither, and it would be
   * useless if a source could set `heardThisTurnRef` without it.
   */
  const noteApplicantSpeech = useCallback(() => {
    speechEvidenceSeenRef.current = true;
    heardThisTurnRef.current = true;
  }, []);

  /**
   * May a `grade_answer` be relayed at all?
   *
   * `true` when the microphone produced speech this turn — and also when this
   * hook has never been observed reporting applicant speech by any means at
   * all, for the reason {@link speechEvidenceSeenRef} states.
   */
  const heardSomethingThisTurn = useCallback(
    () => heardThisTurnRef.current || !speechEvidenceSeenRef.current,
    [],
  );

  // ---------------------------------------------------------------------------
  // Reading the interview
  // ---------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!id) {
      if (isMounted()) {
        setInterview(null);
        setIsLoading(false);
        setLoadError('That interview could not be found.');
      }
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      const detail = await getInterview(id);
      if (!isMounted()) return;

      setInterview(detail.interview);
      setProgress(detail.progress);
      setAwaitingCompletion(detail.awaitingCompletion);
      setPhase(detail.turns[detail.turns.length - 1]?.phase ?? 'smalltalk');

      // The opening line — or, resuming an interview that was being conducted
      // in text a moment ago, the outstanding question. Either way it is the
      // officer's own last words, read from the server rather than remembered.
      const lastOfficer = [...detail.turns]
        .reverse()
        .find((turn) => turn.role === 'officer');
      pendingLineRef.current = lastOfficer?.text ?? null;
    } catch (err) {
      if (isMounted()) {
        setInterview(null);
        setLoadError(
          err instanceof Error
            ? err.message
            : 'That interview could not be loaded.',
        );
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [id, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---------------------------------------------------------------------------
  // The relay
  // ---------------------------------------------------------------------------

  /** Apply the "where is the interview now" fields every honoured result carries. */
  const applyTurnStatus = useCallback((result: RealtimeToolCallResponse) => {
    if (result.status !== 'ok') return;
    if (result.tool === 'end_phase') {
      setPhase(result.nextPhase);
      setAwaitingCompletion(result.awaitingCompletion);
      return;
    }
    setPhase(result.phase);
    setProgress(result.progress);
    setAwaitingCompletion(result.awaitingCompletion);
  }, []);

  /**
   * Post one tool call and hand the answer back to the model.
   *
   * `callId` is `null` for a call this SCREEN originated rather than the model
   * — the typed writing answer, which the model never heard and so could never
   * have reported. There is no tool result to return in that case; the officer
   * is told to speak the acknowledgement instead, which is also what prompts it
   * to ask for the next question.
   */
  const relay = useCallback(
    async (
      call: RealtimeToolCallInput,
      callId: string | null,
    ): Promise<RealtimeToolCallResponse | null> => {
      if (!id) return null;

      let result: RealtimeToolCallResponse;
      try {
        result = await sendRealtimeToolCall(id, call);
      } catch (err) {
        // A transport failure on the RELAY, not on the interview. The model is
        // still waiting on a tool result, and leaving it waiting is how a live
        // conversation goes silent — so it is told, in the same shape a
        // server-side refusal takes, to carry on.
        if (callId !== null) {
          connectionRef.current?.sendToolResult(callId, {
            tool: call.tool,
            status: 'rejected',
            reason: 'relay_failed',
            error:
              err instanceof Error
                ? err.message
                : 'That could not be sent to the application.',
            instruction: 'call next_question and continue the interview',
          });
        }
        return null;
      }

      // VERBATIM, INCLUDING A REJECTION. The `instruction` on a refused call is
      // the field that gets the interview moving again (§4.2).
      if (callId !== null) connectionRef.current?.sendToolResult(callId, result);

      if (!isMounted()) return result;

      applyTurnStatus(result);

      if (result.status === 'ok' && result.tool === 'next_question') {
        // A NEW TURN BEGINS WHEN A QUESTION IS ASKED (#400), and on this
        // transport an honoured `next_question` is the ONLY thing that begins
        // one. Practice resets on a second condition as well — an honoured
        // result whose `questionId` moved on — and has a `repeat_question` tool
        // that counts as a third; neither exists here, because this contract's
        // results carry no question id at all and there is no tool that
        // re-reads a question. Never on a timer, for the reason
        // `heardThisTurnRef` gives.
        beginTurn();

        // AND THE ECHO GUARD IS ARMED FOR EVERY PHASE BUT READING. The phase is
        // the engine's own, read off the same honoured result that begins the
        // turn, so the arming and the turn can never describe different
        // questions. See `echoGuardArmedRef` and the file header.
        echoGuardArmedRef.current = result.phase !== 'reading';

        // Held for a reconnect, and — for a dictation — this is the ONLY copy.
        pendingLineRef.current = result.text;
        withholdOfficerRef.current = result.speakOnly;

        setTranscript((current) => [
          ...current,
          toTranscriptEntry(result, current.length),
        ]);

        setWritingPrompt(
          result.speakOnly && result.itemId
            ? { itemId: result.itemId }
            : null,
        );
      }

      if (result.status === 'ok' && result.tool === 'grade_answer') {
        // The item is answered, so the officer's words are renderable again.
        // `recorded` is deliberately not surfaced: it is a statement about the
        // RECORD (a reading transcript the recogniser did not trust writes no
        // row and the officer asks again), never about whether the learner was
        // right, and this screen shows no verdict of any kind before the
        // debrief.
        withholdOfficerRef.current = false;
        setWritingPrompt(null);
      }

      return result;
    },
    [applyTurnStatus, beginTurn, id, isMounted],
  );

  /** Turn one tool call from the model into an HTTP relay. */
  const handleToolCall = useCallback(
    (event: RealtimeToolCallEvent) => {
      if (!isRealtimeToolName(event.name)) {
        // A tool nobody declared. Refused here rather than posted and refused
        // as a 400 — same outcome for the model, one fewer round trip, and no
        // unexplained validation error in the API's logs.
        connectionRef.current?.sendToolResult(event.callId, {
          tool: event.name,
          status: 'rejected',
          reason: 'unknown_tool',
          error: `${event.name} is not a tool in this interview.`,
          instruction: 'call next_question and continue the interview',
        });
        return;
      }

      const call = toToolCallInput(event);
      if (!call) {
        connectionRef.current?.sendToolResult(event.callId, {
          tool: event.name,
          status: 'rejected',
          reason: 'malformed_arguments',
          error: 'Those arguments were not the ones that tool takes.',
          instruction: 'call next_question and continue the interview',
        });
        return;
      }

      // ---- THE ONE CALL THAT IS NOT RELAYED UNCONDITIONALLY (#400) --------
      //
      // A `grade_answer` for a turn in which the microphone produced no
      // applicant speech at all is refused HERE, and never reaches
      // `POST /api/interviews/:id/realtime/tool-calls` — so no
      // `practice_attempts` row is written for it, `civics_asked` and
      // `civics_correct` do not move, no `mock_interview_turns` row is added,
      // and nothing enters the readiness recompute, whatever the acoustics in
      // the room. The engine cannot make this check for itself: the evidence is
      // the provider's transcription of the applicant's input audio, which
      // arrives on this data channel and nowhere else.
      //
      // ARMED IN EVERY PHASE, reading and writing included. In reading the
      // applicant does speak, so silence is still evidence of no answer; in
      // writing they type, and a `grade_answer` the model originated there has
      // no spoken answer behind it by definition — the real one arrives through
      // `submitWriting`, which never passes through this function.
      //
      // NOT A FALLBACK, NOT A TEARDOWN AND NOTHING ON SCREEN. The interview is
      // working; one call was not honoured. The model is handed the same
      // refusal shape every other locally-refused call gets, and the applicant
      // hears nothing at all — see {@link NOTHING_HEARD_INSTRUCTION}.
      if (call.tool === 'grade_answer' && !heardSomethingThisTurn()) {
        connectionRef.current?.sendToolResult(event.callId, {
          tool: 'grade_answer',
          status: 'rejected',
          reason: 'nothing_heard',
          error:
            'The microphone picked up no speech since that question was asked.',
          instruction: NOTHING_HEARD_INSTRUCTION,
        });
        return;
      }

      // ---- AND THE SAME REFUSAL FOR THE OFFICER'S OWN VOICE (#400) ---------
      //
      // NOT REDUNDANT ALONGSIDE THE CHECK ABOVE, and it is worth saying why
      // rather than leaving it to look like belt and braces. That check catches
      // a `grade_answer` with no applicant audio behind it at all. An ACOUSTIC
      // echo is the opposite case: the officer's voice really does arrive at
      // the microphone, the provider really does transcribe it as applicant
      // input, and the turn therefore reads as heard. The two guards cover the
      // two ways a fabricated attempt reaches the engine, and neither covers
      // the other's.
      //
      // DISARMED IN THE READING PHASE, where a right answer and an echo are the
      // same words by design — `echoGuardArmedRef` and the file header carry
      // that argument in full.
      //
      // A PROVENANCE TEST, NOT A GRADING ONE — `lib/coachEcho.ts` holds the
      // rule and the argument for how blunt it is, and is reused rather than
      // reimplemented for this transport.
      if (
        call.tool === 'grade_answer' &&
        echoGuardArmedRef.current &&
        isLikelyCoachEcho(call.transcript, officerUtteranceRef.current)
      ) {
        connectionRef.current?.sendToolResult(event.callId, {
          tool: 'grade_answer',
          status: 'rejected',
          reason: 'echoed_question',
          error:
            'That was the question coming back through the microphone, not an answer.',
          instruction: ECHOED_QUESTION_INSTRUCTION,
        });
        return;
      }

      void relay(call, event.callId);
    },
    [heardSomethingThisTurn, relay],
  );

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  /** Stop the connection and every track it holds. Idempotent. */
  const teardown = useCallback(() => {
    const connection = connectionRef.current;
    connectionRef.current = null;
    connection?.close();
  }, []);

  // Unmount ends the session. A learner who navigates away must not leave a
  // live microphone — and its indicator light — behind them.
  useEffect(() => teardown, [teardown]);

  const fallBack = useCallback(
    (next: RealtimeFallback) => {
      teardown();
      if (!isMounted()) return;
      setRemoteStream(null);
      setIsOfficerSpeaking(false);
      setFallback(next);
      setStage('fallback');
    },
    [isMounted, teardown],
  );

  /**
   * The whole start sequence: microphone, then mint, then handshake.
   *
   * THE ORDER IS THE POINT. §7: "the browser's own permission denial is caught
   * before a realtime-session mint is even attempted (no
   * `POST /api/interviews/:id/realtime-session` call is made without a live
   * audio input)". A mint on a learner's own key, for a session they have no
   * microphone to speak into, spends their money on nothing.
   */
  const connect = useCallback(
    async (isReconnect: boolean) => {
      if (!id || startingRef.current) return;
      startingRef.current = true;

      /**
       * Give up on this attempt.
       *
       * ON THE FIRST ATTEMPT the learner has not started speaking, so they are
       * told exactly what went wrong and offered the text interview: an unbound
       * role, a refused microphone and a failed mint are three different
       * errands and only one of them is worth a retry.
       *
       * ON A RECONNECT none of that is the useful thing to say. The officer has
       * gone silent mid-conversation and the learner is sitting in it, so the
       * attempt is simply repeated up to {@link MAX_RECONNECTS} times and, when
       * that is spent, the interview moves to text. A screen that instead
       * reported "the provider refused the mint" would be explaining the wrong
       * layer to somebody who only wants to finish their rehearsal.
       */
      const giveUp = (first: RealtimeFallback) => {
        startingRef.current = false;
        if (!isReconnect) {
          fallBack(first);
          return;
        }
        if (reconnectsRef.current < MAX_RECONNECTS) {
          reconnectsRef.current += 1;
          void connectRef.current(true);
          return;
        }
        fallBack(CONNECTION_LOST);
      };

      if (isMounted()) {
        setStage('connecting');
        setFallback(null);
      }

      // ---- 1. The microphone ------------------------------------------------
      //
      // The six named problems and their six remedies come from
      // `useAudioCapture` (#99) rather than being re-derived here: a denied
      // permission, a dismissed prompt, no device, a device another app holds,
      // an insecure origin and a browser that cannot capture are six different
      // errands, and "microphone unavailable" sends a learner whose headset is
      // simply unplugged to change a permission that was never the problem.
      let stream: MediaStream;
      try {
        stream = await requestMicrophone();
      } catch (error) {
        const problem = toCaptureProblem(error);
        giveUp({
          code: 'microphone',
          message: problem.message,
          remedy: problem.remedy,
          cause: null,
          retryable:
            problem.code !== 'insecure_origin' && problem.code !== 'unsupported',
        });
        return;
      }

      // ---- 2. The mint ------------------------------------------------------
      try {
        const session = await createRealtimeSession(id);

        if (session.status === 'unavailable') {
          // NOT AN ERROR. Nothing was spent and nothing is broken — this is a
          // deployment where the voice interview is not configured, or a
          // learner who has not stored a key. Either way the answer is the text
          // interview (§7).
          stopStream(stream);
          giveUp({
            code: 'ai_unavailable',
            message:
              session.cause === 'no_user_key'
                ? 'A spoken interview runs on your own AI key, and there isn’t one saved on your account yet.'
                : 'Spoken interviews are not set up on this installation.',
            remedy: null,
            cause: session.cause,
            retryable: false,
          });
          return;
        }

        if (session.status === 'failed') {
          stopStream(stream);
          giveUp({
            code: 'mint_failed',
            // The API's own message, already redacted — never a key, never the
            // secret this route mints.
            message: session.error || 'The voice session could not be started.',
            remedy: 'Trying again often works. The interview itself is unaffected.',
            cause: null,
            retryable: true,
          });
          return;
        }

        // ---- 3. The handshake ----------------------------------------------
        const connection = await openRealtimeConnection({
          clientSecret: session.clientSecret,
          modelId: session.modelId,
          stream,
          handlers: {
            onToolCall: (event) => handleToolCallRef.current(event),
            onOfficerSpeech: (event) => officerSpeechRef.current(event),
            onApplicantSpeech: (event) => applicantSpeechRef.current(event),
            // THE TURN DETECTOR (#403). Earlier evidence of the same fact the
            // transcription events carry, and the reason the nothing-heard
            // guard no longer refuses answers whose transcription is merely
            // late. See `voiceActivity`.
            onVoiceActivity: (event) => voiceActivityRef.current(event),
            onProviderError: (error) => providerErrorRef.current(error),
            onRemoteStream: (remote) => {
              if (isMounted()) setRemoteStream(remote);
            },
            onClosed: (reason) => closedRef.current(reason),
          },
        });

        connectionRef.current = connection;
        startingRef.current = false;

        if (!isMounted()) {
          // Unmounted during the handshake. Close what we just opened rather
          // than leaving a live microphone attached to a page nobody is on.
          connection.close();
          return;
        }

        setStage('live');

        // THE OPENING TURN, WHICH THE TOOL-CALL ROUTE NEVER SERVES. See
        // `pendingLineRef`.
        const line = pendingLineRef.current;
        if (line) connection.speakVerbatim(line);
      } catch (error) {
        stopStream(stream);
        giveUp({
          code: 'connection_failed',
          message:
            error instanceof Error
              ? error.message
              : 'The voice connection could not be opened.',
          remedy:
            'You can carry on in text — nothing you have already answered is lost.',
          cause: null,
          retryable: true,
        });
      }
    },
    [fallBack, id, isMounted],
  );

  // ---------------------------------------------------------------------------
  // Handlers, held in refs
  // ---------------------------------------------------------------------------
  //
  // `openRealtimeConnection` captures its handlers once, at handshake time, and
  // the connection outlives many renders. Passing the callbacks directly would
  // freeze the first render's closures — a transcript that stops growing after
  // the first officer turn, and a tool call relayed against a stale interview
  // id. The refs are re-pointed on every render so the connection always calls
  // the current one.

  const connectRef = useRef(connect);
  connectRef.current = connect;

  const handleToolCallRef = useRef(handleToolCall);
  handleToolCallRef.current = handleToolCall;

  const officerSpeech = useCallback((event: RealtimeSpeechEvent) => {
    // KEPT, NOT RENDERED (#400). The completed utterance is what an echo would
    // be an echo OF — see `officerUtteranceRef`, including why keeping it
    // during a dictation leaks nothing. Only the `done` event, because a delta
    // is half a sentence and half a sentence would match things the whole one
    // does not.
    //
    // BEFORE THE MOUNT CHECK, for the same reason `applicantSpeech` is: the
    // connection outlives the component until teardown runs, and an utterance
    // dropped here is one a later `grade_answer` could not be measured against.
    if (event.done && event.text.trim() !== '') {
      officerUtteranceRef.current = event.text;
    }
    if (!isMounted()) return;
    setIsOfficerSpeaking(!event.done);
    // WITHHELD DURING A DICTATION — the officer's audio at that moment IS the
    // sentence. See the file header.
    appendSpeech(setTranscript, 'officer', event, withholdOfficerRef.current);
  }, [isMounted]);
  const officerSpeechRef = useRef(officerSpeech);
  officerSpeechRef.current = officerSpeech;

  const applicantSpeech = useCallback((event: RealtimeSpeechEvent) => {
    // THE ONE THING THIS EVENT IS NOW READ FOR BESIDES RENDERING (#400):
    // whether there was any applicant speech at all this turn. Not its words,
    // not their meaning — only that the microphone produced some. Deltas count
    // as much as the final event: an applicant who was cut off mid-answer still
    // spoke.
    //
    // NO LONGER THE ONLY SOURCE OF THAT FACT (#403): the turn detector says it
    // sooner, and this pipeline can and does land after the model has already
    // called `grade_answer`. See `voiceActivity` below.
    //
    // BEFORE THE MOUNT CHECK, on purpose. The flags are what the next
    // `grade_answer` is measured against, and a hook whose component has
    // unmounted still owns a live connection until its teardown runs — an
    // utterance dropped here would become an answer that could not be accounted
    // for.
    if (event.text.trim() !== '') {
      noteApplicantSpeech();
    }

    if (!isMounted()) return;
    // DISPLAY. What reaches the engine is still the transcript the MODEL
    // reports on its own `grade_answer` call; this is never sent anywhere and
    // is never compared to an answer.
    appendSpeech(setTranscript, 'applicant', event, false);
  }, [isMounted, noteApplicantSpeech]);
  const applicantSpeechRef = useRef(applicantSpeech);
  applicantSpeechRef.current = applicantSpeech;

  /**
   * The provider's turn detector heard the microphone open or close (#403).
   *
   * ---------------------------------------------------------------------------
   * THE SAME QUESTION AS `applicantSpeech`, ANSWERED IN TIME TO BE USEFUL
   * ---------------------------------------------------------------------------
   *
   * #400's guard measured "did the applicant say anything this turn" on
   * `conversation.item.input_audio_transcription.*` alone. That is a SEPARATE,
   * SLOWER pipeline from the model's own understanding of the audio: the
   * speech-to-speech model does not wait for a transcription before acting, so
   * a `grade_answer` for a real answer can — and, on a phone, does — arrive
   * while the answer to "have we heard anything?" is still "not yet". The guard
   * then refuses a genuine answer, and on this transport the refusal is
   * deliberately silent: the officer waits, the applicant is told nothing, and
   * the rehearsal stalls with nothing on screen. That is #403's 17-27s
   * signature, in the failure mode this file's header calls the worst one this
   * screen has.
   *
   * `input_audio_buffer.speech_started` is raised the moment the microphone
   * crosses the turn detector's threshold — before the model has finished
   * hearing the utterance, let alone before it can call a tool about it. So the
   * guard is now measuring an AFFIRMATIVE report that the applicant spoke,
   * rather than the absence of a report that may simply not have arrived.
   *
   * BOTH EDGES COUNT. `stopped` without a preceding `started` is not a shape
   * this provider produces, but if it ever did, the applicant has still
   * demonstrably spoken — and treating the end of speech as evidence of no
   * speech would be the exact inversion this measure exists to remove.
   *
   * THE GUARD IS NOT WEAKENED BY THIS. #400's second failure was the officer's
   * own question being graded into a `practice_attempts` row; that case is
   * `isLikelyCoachEcho`'s, it compares words, and it is untouched here — which
   * is precisely why the two guards were always independent. This one catches a
   * `grade_answer` with no applicant audio behind it AT ALL, and an echo that
   * reaches the microphone raises these events too.
   */
  const voiceActivity = useCallback((_event: RealtimeVoiceActivityEvent) => {
    // NO TEXT REACHES HERE, BY CONSTRUCTION (`RealtimeVoiceActivityEvent`
    // carries none), so there is nothing this could grow into reading.
    noteApplicantSpeech();
  }, [noteApplicantSpeech]);
  const voiceActivityRef = useRef(voiceActivity);
  voiceActivityRef.current = voiceActivity;

  /**
   * The provider reported an error (#385).
   *
   * TWO AUDIENCES, TWO RENDERINGS, AND NEITHER IS A TEARDOWN — the identical
   * handling `useRealtimePractice` gives the same event, for the identical
   * reason: closing a live connection over an error that ended one turn would
   * move an applicant to the text transport mid-interview for a hiccup the
   * next question would not have noticed.
   */
  const providerError = useCallback(
    (error: RealtimeProviderError) => {
      console.warn(
        '[realtime interview] the provider reported an error',
        error.code,
        error.message,
      );
      if (!isMounted()) return;
      setProviderNotice(REALTIME_INTERVIEW_PROVIDER_ERROR_LINE);
    },
    [isMounted],
  );
  const providerErrorRef = useRef(providerError);
  providerErrorRef.current = providerError;

  const closed = useCallback(
    (reason: 'closed' | 'dropped') => {
      connectionRef.current = null;
      if (!isMounted()) return;
      setRemoteStream(null);
      setIsOfficerSpeaking(false);

      // A deliberate close is the learner ending the interview; the page is
      // already navigating and has nothing to recover from.
      if (reason === 'closed') return;

      if (reconnectsRef.current < MAX_RECONNECTS) {
        // §3: re-mint while `in_progress`. The interview resumes at whatever
        // question the engine's own state says comes next, because that state
        // is server-side and was never held in the connection that just died.
        reconnectsRef.current += 1;
        void connect(true);
        return;
      }

      fallBack(CONNECTION_LOST);
    },
    [connect, fallBack, isMounted],
  );
  const closedRef = useRef(closed);
  closedRef.current = closed;

  // ---------------------------------------------------------------------------
  // What the page calls
  // ---------------------------------------------------------------------------

  const start = useCallback(() => {
    reconnectsRef.current = 0;
    void connect(false);
  }, [connect]);

  const retry = useCallback(() => {
    reconnectsRef.current = 0;
    setFallback(null);
    void connect(false);
  }, [connect]);

  const submitWriting = useCallback(
    (text: string) => {
      const prompt = writingPrompt;
      if (!prompt || isSubmittingWriting) return;

      setIsSubmittingWriting(true);
      void relay(
        {
          tool: 'grade_answer',
          questionId: prompt.itemId,
          // WHAT THEY TYPED, VERBATIM. No trimming of "extra" words, no
          // spell-check, no normalisation: the scorer is server-side and it is
          // the one place a writing attempt is judged.
          transcript: text,
          // NO `confidence`. Nothing was recognised — they typed it — and a
          // number here would be this screen inventing a fact about audio that
          // does not exist. Absent means unknown, which is the truth.
        },
        null,
      )
        .then((result) => {
          if (!isMounted()) return;
          setIsSubmittingWriting(false);
          // The officer never heard this answer, so it is told the interview
          // moved. Speaking the acknowledgement is also what prompts it to ask
          // for the next question.
          if (result?.status === 'ok' && result.tool === 'grade_answer') {
            connectionRef.current?.speakVerbatim(result.ack);
          }
        })
        .catch(() => {
          if (isMounted()) setIsSubmittingWriting(false);
        });
    },
    [isMounted, isSubmittingWriting, relay, writingPrompt],
  );

  const end = useCallback(async (): Promise<InterviewDebrief | null> => {
    if (!id) return null;

    // BEFORE the request, always. The learner has said they are done, and a
    // microphone that is still live — with its indicator light still on — while
    // a completion request is in flight is this application listening to
    // somebody who has just told it to stop.
    teardown();
    if (isMounted()) {
      setStage('ended');
      setRemoteStream(null);
      setIsOfficerSpeaking(false);
    }

    setIsCompleting(true);
    setCompleteError(null);
    try {
      const debrief = await completeInterview(id);
      if (isMounted()) setIsCompleting(false);
      return debrief;
    } catch (err) {
      if (isMounted()) {
        setCompleteError(
          err instanceof Error
            ? err.message
            : 'This interview could not be finished.',
        );
        setIsCompleting(false);
      }
      return null;
    }
  }, [id, isMounted, teardown]);

  return {
    interview,
    isLoading,
    loadError,

    stage,
    fallback,

    transcript,
    isOfficerSpeaking,
    providerNotice,

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
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Ask for the microphone, with `useAudioCapture`'s own preflight order.
 *
 * `insecure_origin` IS CHECKED FIRST because a browser on an insecure origin
 * does not merely refuse capture — it deletes `navigator.mediaDevices`
 * entirely, so checking support first reports `unsupported` on a perfectly
 * capable browser and sends the learner off to install a different one when the
 * actual fix is the address bar. That reasoning is `useAudioCapture`'s; it is
 * repeated in one sentence here because the order looks arbitrary otherwise.
 *
 * NO `MediaRecorder` CHECK, unlike push-to-talk: a realtime session streams its
 * audio over WebRTC and never records a blob, so a browser with `getUserMedia`
 * and no recorder can hold a perfectly good spoken interview.
 */
async function requestMicrophone(): Promise<MediaStream> {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new DOMException('Insecure origin', 'SecurityError');
  }

  const mediaDevices =
    typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
    throw new DOMException('Unsupported', 'NotSupportedError');
  }

  return mediaDevices.getUserMedia({ audio: true });
}

/** One `getUserMedia` rejection, as one of `useAudioCapture`'s six problems. */
function toCaptureProblem(error: unknown): AudioCaptureProblem {
  return describeCaptureProblem(classifyGetUserMediaError(error));
}

/** Stop every track on a stream. Safe on a stream that has none. */
function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Turn one honoured `next_question` result into a transcript entry.
 *
 * THE ONE BRANCH THAT DECIDES WHETHER THE WRITING SENTENCE REACHES THE DOM.
 * `speakOnly` means the string is the dictated sentence, so the entry carries
 * `null` and the raw text goes only to the data channel. Exported for the test
 * that asserts exactly that.
 */
export function toTranscriptEntry(
  result: Extract<
    RealtimeToolCallResponse,
    { tool: 'next_question'; status: 'ok' }
  >,
  index: number,
): RealtimeTranscriptEntry {
  return {
    id: `officer-turn-${result.turnIndex}-${index}`,
    role: 'officer',
    phase: result.phase,
    text: result.speakOnly ? null : result.text,
    final: true,
  };
}

/**
 * Fold one speech event into the transcript.
 *
 * Deltas accumulate onto the entry with the same provider item id, so an
 * utterance grows in place rather than arriving as one line per fragment — the
 * difference between a readable transcript and a column of half-words. A
 * `done` event REPLACES the accumulated text with the provider's own final
 * version, which is the one that has had its punctuation settled.
 */
function appendSpeech(
  setTranscript: React.Dispatch<
    React.SetStateAction<RealtimeTranscriptEntry[]>
  >,
  role: 'officer' | 'applicant',
  event: RealtimeSpeechEvent,
  withhold: boolean,
) {
  const key = `${role}-${event.itemId || 'live'}`;

  setTranscript((current) => {
    const index = current.findIndex((entry) => entry.id === key);
    const phase = current[current.length - 1]?.phase ?? 'smalltalk';

    if (index === -1) {
      if (!event.text && !withhold) return current;
      return [
        ...current,
        {
          id: key,
          role,
          phase,
          text: withhold ? null : event.text,
          final: event.done,
        },
      ];
    }

    const existing = current[index];
    const next: RealtimeTranscriptEntry = {
      ...existing,
      // Once withheld, always withheld for this utterance: a `done` event
      // carrying the whole dictated sentence must not undo a delta's
      // suppression.
      text: withhold || existing.text === null
        ? null
        : event.done
          ? event.text || existing.text
          : existing.text + event.text,
      final: event.done,
    };

    const updated = [...current];
    updated[index] = next;
    return updated;
  });
}

/**
 * Narrow one tool call's arguments to the shape its tool declares, or `null`.
 *
 * NOT A CAST. `grade_answer` without a `questionId` and `end_phase` without a
 * `phase` are calls the API would refuse as a 400, and a 400 reaches the model
 * as a generic failure rather than as the instruction that would get the
 * interview moving again. Refusing here produces the same refusal shape the
 * server produces, one round trip sooner.
 *
 * NOTHING IS INVENTED. A missing `confidence` stays missing — absent means
 * unknown, and a default would make every answer on a provider that reports
 * none read as misheard.
 */
export function toToolCallInput(
  event: RealtimeToolCallEvent,
): RealtimeToolCallInput | null {
  const { args } = event;

  if (event.name === 'next_question') return { tool: 'next_question' };

  if (event.name === 'grade_answer') {
    const questionId = args.questionId;
    const transcript = args.transcript;
    if (typeof questionId !== 'string' || typeof transcript !== 'string') {
      return null;
    }
    return {
      tool: 'grade_answer',
      questionId,
      transcript,
      confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
    };
  }

  if (event.name === 'end_phase') {
    const phase = args.phase;
    if (typeof phase !== 'string') return null;
    return { tool: 'end_phase', phase: phase as InterviewPhase };
  }

  return null;
}

export default useRealtimeInterview;
