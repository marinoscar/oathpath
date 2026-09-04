/**
 * Which of the two speech roles this deployment can actually serve.
 *
 * Issue #109, epic #58 / E9. Two booleans and a loading flag — deliberately
 * nothing else. Everything interesting about this hook is WHICH FIELD IT READS
 * and WHAT IT RESOLVES AN UNKNOWN TO, so both are written down below rather
 * than left to be re-derived at each call site.
 *
 * =============================================================================
 * WHY `unboundRoles`, AND NOT A FLAG OF OUR OWN
 * =============================================================================
 *
 * `transcribe` and `speak` are `wired: true` as of this epic, and
 * `unboundRoles` has always meant "every WIRED role with no model bound". So
 * the field that already exists answers a voice surface's question exactly —
 * `unboundRoles.includes('transcribe')` — with no change to its meaning and no
 * new API surface. `docs/specs/voice.md` §12 records the two shapes that were
 * considered and rejected in its place:
 *
 *   - A new `boundRoles` field on `GET /api/ai/status`: pure duplication of a
 *     field that already answers the question, added to the widest-read
 *     payload in the application — the exact move `AiStatusResponseDto`'s own
 *     `ForbiddenFieldNames` proof and comment exist to discourage.
 *   - A combined `voiceReady` boolean: `transcribe` unbound and `speak`
 *     unbound are different facts with different remedies and different
 *     urgency (one hides a control and explains itself; one is invisible by
 *     design and must NEVER explain itself). A caller handed one merged flag
 *     cannot render either correctly — the same mistake `systemReady` /
 *     `userKeyConfigured` were split to avoid.
 *
 * `systemReady` is NOT the field to read here and no longer answers a voice
 * surface's question at all: it narrowed to the text roles in the same commit
 * that wired these two (`voice.md` §1), precisely so that an installation with
 * `tutor` and `grader` bound and no voice configuration is a NORMAL, WORKING
 * installation rather than one reporting itself broken.
 *
 * =============================================================================
 * THE ROLE REGISTRY LIVES IN THE API. THESE TWO KEYS ARE NOT A COPY OF IT.
 * =============================================================================
 *
 * `AI_MODEL_ROLES` is the API's, and `CLAUDE.md` ("Adding a New AI Model Role")
 * forbids duplicating it in the web because `wired` is a per-deployment fact a
 * static copy would get wrong. Nothing here enumerates roles, classifies them,
 * or decides which are wired: this hook asks about membership of two specific
 * keys in a list the server computed, which is the same thing
 * `QuestionAudio.tsx` already does for `'speak'`.
 *
 * =============================================================================
 * AN UNKNOWN STATUS RESOLVES TO "NOT BOUND", AND THAT IS THE SAFE DIRECTION
 * =============================================================================
 *
 * Before the first response, and after a failed one, `status` is `null`. Both
 * `transcribeBound` and `speakBound` are then `false` — so a microphone is
 * absent for the moment rather than present-and-dead, and the premium voice is
 * not attempted. This is the direction with no cost: typing is always
 * available (`voice.md` §5) and the browser's own voice always speaks (§2), so
 * resolving an unknown to "no voice" loses a learner nothing, while resolving
 * it to "voice" hands them a control that cannot succeed — the one outcome
 * this issue exists to prevent.
 *
 * `transcribeUnbound` is a SEPARATE field rather than `!transcribeBound` for
 * that same reason: while the status is unknown, both are `false`. Collapsing
 * them would make the "speech recognition is not set up" notice flash on every
 * page load of a perfectly configured deployment, which is a message that is
 * not merely noisy but false.
 *
 * There is deliberately no `speakUnbound`. `voice.md` §2 is explicit that an
 * unbound `speak` is not a degraded state — the browser reads the question
 * either way — so nothing may render a notice about it, and a field whose only
 * possible use is rendering that notice would be an invitation to write it.
 */

import { useOptionalAiStatus } from '../contexts/AiStatusContext';

export interface VoiceAvailability {
  /**
   * A model is bound to `transcribe`: a spoken answer can be transcribed.
   *
   * THE CONDITION THE MICROPHONE RENDERS UNDER. False while the status is
   * unknown — see the file header.
   */
  transcribeBound: boolean;

  /**
   * The status is known AND `transcribe` has no model bound.
   *
   * THE CONDITION THE NOTICE RENDERS UNDER, and not the negation of
   * `transcribeBound` — see the file header.
   */
  transcribeUnbound: boolean;

  /**
   * A model is bound to `speak`: the premium, provider-hosted voice is
   * available to a learner who has asked for it.
   *
   * NOT a precondition for hearing a question. `QuestionAudio` speaks with the
   * browser's own engine regardless; this only decides whether the optional
   * upgrade is reachable, and its absence is never explained to anybody.
   */
  speakBound: boolean;

  /** True until the first status response settles, success or failure. */
  isLoading: boolean;
}

/**
 * Read the two speech roles' binding state.
 *
 * Safe in a tree with no `AiStatusProvider` above it — a practice screen's
 * reason to exist has nothing to do with AI, and a throw there would blank the
 * whole feature to report that we could not tell whether a microphone was
 * worth showing. `useOptionalAiStatus`'s `null` is treated exactly as a failed
 * status request: not bound.
 */
export function useVoiceAvailability(): VoiceAvailability {
  const ai = useOptionalAiStatus();
  const status = ai?.status ?? null;
  const isLoading = ai?.isLoading ?? false;

  return {
    transcribeBound: !!status && !status.unboundRoles.includes('transcribe'),
    transcribeUnbound: !!status && status.unboundRoles.includes('transcribe'),
    speakBound: !!status && !status.unboundRoles.includes('speak'),
    isLoading,
  };
}

export default useVoiceAvailability;
