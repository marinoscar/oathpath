/**
 * Which cue every phase transition of the conversation loop makes — as a
 * table, not as a call site.
 *
 * Issue #357, epic #345. E13 shipped three cues (`lib/earcons.ts`) and wired
 * them by hand at the three places somebody noticed: the microphone opening,
 * the turn being captured, the pulse over `processing`. Placing them by hand
 * is what left five edges silent — the tap that starts a session, the top of a
 * question, the pause before the next one, and both ways a session can end —
 * and it is also what put a `stopProcessingPulse()` on the `onsetTimeout` path
 * where no pulse had ever started. Neither is a bug you can see. Both are
 * symptoms of the same thing: there was no place where "does this transition
 * make a sound?" was a question anybody had to answer.
 *
 * =============================================================================
 * THE TABLE IS THE POINT. A NEW PHASE CANNOT BE ADDED SILENTLY.
 * =============================================================================
 *
 * {@link CONVERSATION_TRANSITION_CUES} is a `Record<ConversationPhase,
 * Record<ConversationPhase, ...>>` — every ordered pair of phases, written
 * out. That is deliberately more typing than a lookup keyed only by the phase
 * being entered, and the extra typing is the whole feature: adding an eighth
 * phase to `ConversationPhase` does not compile until fifteen new cells have
 * been decided, one for each way into the new phase and one for each way out.
 * A destination-keyed map would have accepted the new phase with one entry and
 * left every transition out of it undecided, which is precisely the state this
 * issue found the module in.
 *
 * `preparing` is the worked example, and it is not hypothetical: issue #349
 * added it three weeks before this file existed, and the cue that should fire
 * when a learner taps Start — the one thing the whole hands-free mode most
 * needed — was not added with it, because nothing asked.
 *
 * EVERY CELL CARRIES A `reason`, INCLUDING THE SILENT ONES. Silence is a
 * decision here, never an omission, and `conversationCues.test.ts` asserts
 * that every one of the 49 cells has a non-empty one. A reason string rather
 * than a code comment because a comment cannot be asserted over, and the
 * failure mode being guarded against is a future cell added with a copied
 * value and no thought.
 *
 * =============================================================================
 * WHY THE EXIT CUE IS LOOKED UP SEPARATELY
 * =============================================================================
 *
 * Every involuntary exit and every deliberate one both arrive as the same pair
 * — `<something> → idle`. A learner who has just heard a session stop needs to
 * know WHICH, because the remedies differ: "that was the last question" needs
 * nothing from them, and "your microphone was taken away" needs them to look
 * at the screen when they can. The phase pair cannot tell those apart, so the
 * `→ idle` cells resolve through {@link CONVERSATION_EXIT_CUES}, which is
 * exhaustive over `ConversationStopReason` for the same reason the phase table
 * is exhaustive over `ConversationPhase`: a stop reason added without a cue
 * decision does not compile.
 *
 * =============================================================================
 * THE PULSE IS DERIVED, WHICH IS WHY IT IS NEVER STOPPED FOR NOTHING
 * =============================================================================
 *
 * The "working on it" pulse belongs to `processing` and to no other phase, so
 * {@link applyConversationCue} starts it on the way in and stops it on the way
 * out, and `stopProcessingPulse()` is unreachable from any path that did not
 * pass through `processing`. That is the invariant the hand-placed calls could
 * not keep. The one path that has to fall silent BEFORE it leaves the phase —
 * `processing` speaks a nudge and then re-opens the microphone, and a pulse
 * beating under a spoken sentence is nagging — uses
 * {@link silenceProcessingCue}, which is phase-guarded for the same reason.
 *
 * NOTHING HERE MAKES A SOUND ITSELF. Every cue is a call into `earcons.ts`,
 * which is still the only module that constructs an oscillator, still checks
 * the learner's one switch before it does, and still degrades to silence
 * rather than to an exception when there is no audio to play through.
 */

import {
  playAdvancingEarcon,
  playCapturedEarcon,
  playListeningEarcon,
  playQuestionEarcon,
  playSessionEndEarcon,
  playSessionFailedEarcon,
  playSessionStartEarcon,
  startProcessingPulse,
  stopProcessingPulse,
} from './earcons';
import type {
  ConversationPhase,
  ConversationStopReason,
} from '../hooks/useConversationSession';

/**
 * The cues this loop can play, by name.
 *
 * Names rather than descriptors, so this table says WHAT IS MEANT and
 * `earcons.ts` keeps sole ownership of what it sounds like — the same
 * separation that file's own header defends when it argues that a later swap
 * to designed audio must be a change to it and to nothing else.
 */
export type ConversationCueName =
  | 'start'
  | 'question'
  | 'listening'
  | 'captured'
  | 'advancing'
  | 'ended'
  | 'failed';

/**
 * What one transition does. `'exit'` means "ask
 * {@link CONVERSATION_EXIT_CUES}" — see the header.
 */
export type ConversationCueChoice = ConversationCueName | 'exit' | null;

/** One cell of the table: a decision, and why it is that. */
export interface ConversationCueDecision {
  /** The cue, `'exit'` to defer to the stop reason, or `null` for silence. */
  readonly cue: ConversationCueChoice;
  /**
   * Why this transition sounds like that — REQUIRED, even when there is a cue.
   * A silent cell with no reason is an omission wearing a decision's clothes.
   */
  readonly reason: string;
}

/** Every cue, played. The one place a cue name becomes a sound. */
const CUE_PLAYERS: Record<ConversationCueName, () => void> = {
  start: playSessionStartEarcon,
  question: playQuestionEarcon,
  listening: playListeningEarcon,
  captured: playCapturedEarcon,
  advancing: playAdvancingEarcon,
  ended: playSessionEndEarcon,
  failed: playSessionFailedEarcon,
};

// ---------------------------------------------------------------------------
// The decisions, named once and referenced by every cell that makes them.
//
// Written as shared constants rather than 49 inline objects so that the table
// below reads as a grid — which is the only way a reader can see at a glance
// that a pair was decided rather than defaulted.
// ---------------------------------------------------------------------------

/**
 * Entering `preparing`: the tap registered.
 *
 * Only `idle → preparing` happens today, and this is THE cue the mode most
 * needed: it plays in front of `acquireStream()`, so a permission prompt or a
 * slow device open is a wait the learner knows they are in, rather than a tap
 * they will assume did not land and repeat.
 */
const ENTER_PREPARING: ConversationCueDecision = {
  cue: 'start',
  reason:
    'The learner tapped Start. Cued before the device is opened, so a slow or blocked permission prompt is a wait rather than a tap that seemed to do nothing.',
};

/**
 * Entering `speakingQuestion`: a question is about to be read.
 *
 * Reachable from every non-idle phase, not only from `preparing` and
 * `advancing` — the host can change the question under the driver at any
 * moment, and the question-change effect asks it afresh from wherever the loop
 * was. All of those mean the same thing to a learner, so all of them sound the
 * same.
 */
const ENTER_SPEAKING_QUESTION: ConversationCueDecision = {
  cue: 'question',
  reason:
    'A question is about to be read aloud. It marks the top of a turn — after the advancing pause it is the only signal that the loop moved on rather than stopped.',
};

/** Entering `listening`: the microphone is open and it is the learner's turn. */
const ENTER_LISTENING: ConversationCueDecision = {
  cue: 'listening',
  reason:
    "The microphone is open and it is the learner's turn. The rising two-tone E13 shipped; up-means-open needs no explaining.",
};

/**
 * Entering `processing`: the turn was captured, and the wait starts.
 *
 * The falling cue AND the pulse: the cue closes the learner's turn, the pulse
 * covers the several seconds of transcription and grading behind it. The pulse
 * is started by {@link applyConversationCue}, not named here, because it is
 * bound to the phase rather than to this edge.
 */
const ENTER_PROCESSING: ConversationCueDecision = {
  cue: 'captured',
  reason:
    'The turn was captured. The falling partner of the listening cue, and the point where the processing pulse takes over for the silence that follows.',
};

/**
 * Entering `speakingAnswer`: silent, and this is the one silence worth
 * defending.
 *
 * The accepted answer is read aloud the instant this phase begins, so a cue
 * here is a sound played over the top of the sentence it was announcing. The
 * end of the wait is already audible: the pulse stops.
 */
const ENTER_SPEAKING_ANSWER: ConversationCueDecision = {
  cue: null,
  reason:
    'Silent on purpose: the verdict is spoken the instant this phase begins, so a cue would talk over the sentence it announced. The pulse stopping is itself the "it landed" signal.',
};

/** Entering `advancing`: the pause before the next question. */
const ENTER_ADVANCING: ConversationCueDecision = {
  cue: 'advancing',
  reason:
    'The deliberate pause before the next question, which is otherwise entirely silent. Low, against the high cue that starts the next question.',
};

/** Entering `idle`: which cue depends on WHY. See the header. */
const EXIT: ConversationCueDecision = {
  cue: 'exit',
  reason:
    'The loop ended. A normal finish and a failure must be told apart by somebody who missed the spoken sentence, and a phase pair cannot tell them apart — CONVERSATION_EXIT_CUES decides from the stop reason.',
};

/**
 * `idle → idle`: not a transition at all.
 *
 * `finish()` is reachable from a state that has already finished (an unmount
 * racing a capture failure, say). Making a sound for it would mean a learner
 * who stopped a session sometimes hears it stop twice.
 */
const NOT_A_TRANSITION: ConversationCueDecision = {
  cue: null,
  reason:
    'Not a transition: the loop is already idle. A cue here would sound a second time for a session that has already ended.',
};

/**
 * EVERY ORDERED PAIR OF PHASES. Outer key is where the loop was, inner key is
 * where it is going.
 *
 * Some of these pairs cannot happen today, and they are still decided rather
 * than left out — the decision recorded is the one that would be RIGHT if the
 * machine ever grew that edge, because a pair that becomes reachable in a
 * later refactor should not fall silent by accident. `ConversationPhase` is
 * the source of truth for the keys, in both dimensions, and TypeScript rejects
 * this literal the moment a phase is added to it.
 */
export const CONVERSATION_TRANSITION_CUES: Record<
  ConversationPhase,
  Record<ConversationPhase, ConversationCueDecision>
> = {
  // From `idle`: only `start()` leaves, and it always goes to `preparing`.
  idle: {
    idle: NOT_A_TRANSITION,
    preparing: ENTER_PREPARING,
    speakingQuestion: ENTER_SPEAKING_QUESTION,
    listening: ENTER_LISTENING,
    processing: ENTER_PROCESSING,
    speakingAnswer: ENTER_SPEAKING_ANSWER,
    advancing: ENTER_ADVANCING,
  },

  // From `preparing`: the stream resolves into the question, the learner taps
  // Next or Stop, or the device fails and the capture-problem exit runs.
  preparing: {
    idle: EXIT,
    preparing: ENTER_PREPARING,
    speakingQuestion: ENTER_SPEAKING_QUESTION,
    listening: ENTER_LISTENING,
    processing: ENTER_PROCESSING,
    speakingAnswer: ENTER_SPEAKING_ANSWER,
    advancing: ENTER_ADVANCING,
  },

  // From `speakingQuestion`: playback ends or is barged into (`listening`),
  // the host changes the question (a fresh `speakingQuestion`), or an exit.
  speakingQuestion: {
    idle: EXIT,
    preparing: ENTER_PREPARING,
    speakingQuestion: ENTER_SPEAKING_QUESTION,
    listening: ENTER_LISTENING,
    processing: ENTER_PROCESSING,
    speakingAnswer: ENTER_SPEAKING_ANSWER,
    advancing: ENTER_ADVANCING,
  },

  // From `listening`: end of turn (`processing`), a nudge that re-opens the
  // microphone (`listening` again), Next, or an exit.
  listening: {
    idle: EXIT,
    preparing: ENTER_PREPARING,
    speakingQuestion: ENTER_SPEAKING_QUESTION,
    listening: ENTER_LISTENING,
    processing: ENTER_PROCESSING,
    speakingAnswer: ENTER_SPEAKING_ANSWER,
    advancing: ENTER_ADVANCING,
  },

  // From `processing`: a grade (`speakingAnswer`), a nudge and another go
  // (`listening`), a spent budget (`advancing`), or an exit. Every one of them
  // stops the pulse — see `applyConversationCue`.
  processing: {
    idle: EXIT,
    preparing: ENTER_PREPARING,
    speakingQuestion: ENTER_SPEAKING_QUESTION,
    listening: ENTER_LISTENING,
    processing: ENTER_PROCESSING,
    speakingAnswer: ENTER_SPEAKING_ANSWER,
    advancing: ENTER_ADVANCING,
  },

  // From `speakingAnswer`: the retry (`listening`), the next question
  // (`advancing`), or an exit.
  speakingAnswer: {
    idle: EXIT,
    preparing: ENTER_PREPARING,
    speakingQuestion: ENTER_SPEAKING_QUESTION,
    listening: ENTER_LISTENING,
    processing: ENTER_PROCESSING,
    speakingAnswer: ENTER_SPEAKING_ANSWER,
    advancing: ENTER_ADVANCING,
  },

  // From `advancing`: the host's next question, another Next, or an exit.
  advancing: {
    idle: EXIT,
    preparing: ENTER_PREPARING,
    speakingQuestion: ENTER_SPEAKING_QUESTION,
    listening: ENTER_LISTENING,
    processing: ENTER_PROCESSING,
    speakingAnswer: ENTER_SPEAKING_ANSWER,
    advancing: ENTER_ADVANCING,
  },
};

/**
 * How each way out of the loop sounds. Exhaustive over
 * `ConversationStopReason`.
 *
 * The two deliberate exits are SILENT, matching the driver's own rule that
 * they are not spoken either: the learner just asked for this, and being told
 * what you did is not information. Everything else is either the end of the
 * work or something that went wrong, and those two are the distinction a
 * hands-free learner has to be able to hear.
 */
export const CONVERSATION_EXIT_CUES: Record<
  ConversationStopReason,
  { readonly cue: ConversationCueName | null; readonly reason: string }
> = {
  learner: {
    cue: null,
    reason:
      'The learner tapped Stop. Silent, exactly as this exit is unspoken: confirming an action somebody just took is not information.',
  },
  typing: {
    cue: null,
    reason:
      'The learner chose to type instead. Silent for the same reason as `learner` — they asked for it, and the screen they are now looking at says so.',
  },
  capture_problem: {
    cue: 'failed',
    reason:
      'The microphone failed. Not the end of the work, and not the learner doing anything: the failure cue says "look at the screen when you can".',
  },
  transcribe_unavailable: {
    cue: 'failed',
    reason:
      'Speech recognition is not set up on this deployment. Nothing was attempted and nothing the learner does will change it, so it must not sound like a finished session.',
  },
  grade_failed: {
    cue: 'failed',
    reason:
      'The attempt could not be recorded. The answer is gone, which is the opposite of a session that ended having counted everything.',
  },
  no_answer: {
    cue: 'failed',
    reason:
      'Nothing could be heard, twice, with no attempt to move past. A microphone that is not working is a failure, however calmly it is reported.',
  },
  session_complete: {
    cue: 'ended',
    reason:
      'The last question is done. The one exit that is genuinely finished work, and the only one that gets the resolved cadence.',
  },
};

/**
 * The cue a transition plays, or `null` for silence.
 *
 * `exitReason` is only consulted for a transition into `idle`. It defaults to
 * `learner` — the SILENT reason — so a future exit that forgets to name itself
 * is quiet rather than telling a learner their session failed when it did not.
 */
export function resolveConversationCue(
  from: ConversationPhase,
  to: ConversationPhase,
  exitReason?: ConversationStopReason,
): ConversationCueName | null {
  const decision = CONVERSATION_TRANSITION_CUES[from][to];
  if (decision.cue !== 'exit') return decision.cue;
  return CONVERSATION_EXIT_CUES[exitReason ?? 'learner'].cue;
}

/**
 * Make one phase transition audible: stop the pulse, play the cue, start the
 * pulse — in that order.
 *
 * ORDER MATTERS. The pulse is silenced before the cue that replaces it sounds,
 * so a verdict or an exit is not heard through a beat that is still running;
 * and the captured cue plays before the pulse begins, so the learner hears
 * "got it" and then the wait, rather than both at once.
 *
 * `stopProcessingPulse()` is reached ONLY from a transition out of
 * `processing`, which is the whole of the fix for the `onsetTimeout` path that
 * used to stop a pulse that had never started.
 *
 * Never throws — everything below is a call into `earcons.ts`, which is silent
 * and harmless when cues are off or there is no audio to play through.
 */
export function applyConversationCue(
  from: ConversationPhase,
  to: ConversationPhase,
  exitReason?: ConversationStopReason,
): void {
  if (from === 'processing' && to !== 'processing') stopProcessingPulse();

  const cue = resolveConversationCue(from, to, exitReason);
  if (cue) CUE_PLAYERS[cue]();

  if (to === 'processing' && from !== 'processing') startProcessingPulse();
}

/**
 * Stop the pulse from a path that has NOT left `processing` yet.
 *
 * There is exactly one: a turn that missed speaks a short nudge and then
 * re-opens the microphone, and it is still in `processing` while it speaks. A
 * pulse beating under that sentence is the nagging the pulse's own descriptor
 * warns about, so it stops when the wait conceptually ends rather than when
 * the phase changes.
 *
 * Phase-guarded rather than unconditional, so this cannot become a second way
 * to stop a pulse that never ran — an unmount from `listening` calls it and
 * nothing happens, which is the point.
 */
export function silenceProcessingCue(phase: ConversationPhase): void {
  if (phase !== 'processing') return;
  stopProcessingPulse();
}
