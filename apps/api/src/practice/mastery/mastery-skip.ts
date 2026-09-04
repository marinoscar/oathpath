import { ASR_CONFIDENCE_THRESHOLD } from '../../ai/ai.types';
import type { AnswerResolutionStatus } from '../../civics/answer-resolution';

// =============================================================================
// When a recorded attempt must NOT advance mastery (issue #245, epic #60 / E11)
// =============================================================================
//
// One rule, in one file, for both callers of
// `AttemptGradingService.scheduleMastery`. It is a rule about SCHEDULING and
// nothing else: every attempt this module refuses is still written, still
// counts as an interaction, and still accrues toward the day's activity. What
// is withheld is a `question_mastery` write — a claim about recall.
//
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS AT ALL, WRITTEN OUT RATHER THAN LEFT TO ARCHAEOLOGY
// -----------------------------------------------------------------------------
//
// Until this epic the rule lived at the CALL SITES, and there were two of them
// that disagreed:
//
//   * `PracticeService.recordAttempt` guarded on
//     `status !== 'state_required' && !misheard`.
//   * `InterviewsService.recordApplicantTurn` guarded on
//     `graded.answerResolution !== 'state_required'` — one condition shorter.
//
// The interview guard was correct at the time and its own comment said so at
// length, for one reason only: the text interview path structurally could not
// produce a misheard attempt (no `asrConfidence` on its DTO, `inputMode`
// hardcoded to `'typed'`, `isMisheardAttempt` never called on it, and
// `PersistableFailureCause` excluding `'misheard'` at the type level). That
// same comment named the epic that would break it — "WIRING E9 VOICE INTO
// INTERVIEWS MAKES THIS GUARD WRONG IMMEDIATELY (E11 / #60 is the epic that
// will)" — and named the real fix as this one: move the skip rule INSIDE
// `scheduleMastery` so it is decided once and the two call sites cannot
// disagree.
//
// The E11 realtime transport is that wiring. A realtime civics answer carries a
// `confidence` the provider reported, so `isMisheardAttempt` can now return
// `true` on the interview path — and the old guard would have charged a nervous
// applicant a real mastery penalty (`correctStreak` reset, `lapses`
// incremented, `dueAt` pulled in) for an accent or a noisy connection, at
// precisely the moment a learner is most likely to be misheard.
//
// **The reason it is a shared FUNCTION rather than a second `&& !misheard`** is
// the one the old comment gave for preferring this fix: a rule stated twice is
// a rule that can be fixed in one place and silently left stale in the other.
// `scheduleMastery` now REQUIRES a {@link MasteryEvidence} argument, so a third
// call site cannot be written without stating the two facts the rule reads —
// the failure mode that made the old gap invisible (a call site that keeps
// compiling untouched while quietly skipping the rule) is now a compile error.
// =============================================================================

/**
 * Why an attempt was not scheduled, or `null` when it was.
 *
 * Two named values rather than a boolean, because a caller that logs "not
 * scheduled" without saying which rule fired has recorded the fact and lost the
 * reason — and the two mean genuinely different things. `state_required` is
 * "the product could not resolve what right was"; `misheard` is "we are not
 * confident we heard what was said". Neither is "the learner got it wrong".
 */
export type MasterySkipReason = 'state_required' | 'misheard';

/**
 * The facts the skip rule reads off one graded attempt.
 *
 * DELIBERATELY NOT THE WHOLE ATTEMPT. These three are what the two conditions
 * below need, and narrowing the input is what lets an interview turn and a
 * practice attempt — two different DTOs, two different write paths — reach the
 * identical rule without either constructing the other's shape.
 */
export interface MasteryEvidence {
  /**
   * The frozen snapshot's `answerResolution`.
   *
   * `state_required` means the learner has no state on their profile, so no
   * accepted answers could be resolved and the attempt was recorded `skipped`
   * rather than `incorrect`. Scheduling it would lapse a question's mastery for
   * a system limitation rather than for anything the learner did.
   */
  readonly answerResolution: AnswerResolutionStatus;

  /**
   * The attempt's outcome as written to `practice_attempts.outcome`.
   *
   * The FOUR-value column value, not the scheduler's three-value
   * `AttemptOutcome`: condition 3 of {@link isMisheardAttempt} is stated
   * against `'correct'`, and `AttemptOutcome` splits that into `correct` and
   * `correct_self_marked` — a distinction this rule must not accidentally
   * start reading as "not correct".
   */
  readonly outcome: 'correct' | 'partial' | 'incorrect' | 'skipped';

  /**
   * The recogniser's own confidence, when it reported one.
   *
   * `null`/`undefined` means UNKNOWN, and unknown is never low — see
   * {@link isMisheardAttempt}, condition 1. A typed attempt has none, and that
   * is why a typed attempt can never be skipped by this rule.
   */
  readonly asrConfidence?: number | null;
}

/**
 * Is this attempt's failure better explained by the recogniser than by the
 * learner? (issue #104, epic #58 / E9)
 *
 * -----------------------------------------------------------------------------
 * THREE CONDITIONS, AND EACH ONE IS LOAD-BEARING
 * -----------------------------------------------------------------------------
 *
 * 1. **A confidence was reported at all.** `null`/`undefined` NEVER produces
 *    `misheard`, and this is the condition most likely to be "simplified" away
 *    by someone reading `< 0.6` and reaching for `(confidence ?? 0)`. Unknown
 *    is not low. Several transcription models report no confidence whatsoever
 *    (`OpenAiProvider.runTranscription`: the `gpt-4o-transcribe` family
 *    cannot), so collapsing the two would stamp `misheard` on every attempt
 *    whose confidence merely could not be read — telling a learner the system
 *    struggled to hear them when, as far as anything here knows, it did not.
 *    `schema.prisma`'s `asrConfidence` comment makes the same point about the
 *    column; this is the code that has to honour it.
 *
 * 2. **The confidence is strictly below {@link ASR_CONFIDENCE_THRESHOLD}.**
 *    The number lives in one place for the reason its own doc gives; `0.6`
 *    exactly is trusted, because the boundary has to fall on one side and
 *    trusting the transcript is the side that cannot invent a mishearing.
 *
 * 3. **The outcome is not `correct`.** A right answer is right however it was
 *    heard. Writing a failure cause beside a correct outcome would manufacture
 *    a failure to explain where there is none — the same rule
 *    `persistedFailureCause` already applies to a grader's `correct` verdict.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS OVERRIDES A GRADER-SUPPLIED CAUSE RATHER THAN DEFERRING TO IT
 * -----------------------------------------------------------------------------
 *
 * The grader sees TEXT. It is handed the question, the accepted answers and a
 * string, and asked what that string means; when it offers a cause it is
 * inferring, from words alone, why a person got something wrong. The
 * recogniser's confidence is a MEASUREMENT of how well those words captured
 * what was said — evidence about the pipeline rather than an inference about
 * the learner — and when it says the capture was poor, that is the better
 * explanation of a miss than any reading of its output can be.
 *
 * It is also the fairness-preserving direction, which is the reason the
 * override exists at all. `VISION.md` line 228 promises a learner may
 * "practice without being unfairly penalized for accent or speech-recognition
 * errors", and `misheard` is precisely the value `PracticeFailureCause` has
 * for that. The alternative — recording `not_known` or `not_recalled` on an
 * answer the recogniser garbled — tells a learner something about themselves
 * that nothing observed. `docs/specs/ai-evaluation.md` §8 calls that a
 * manufactured diagnosis and it is the failure the whole taxonomy exists to
 * avoid.
 *
 * Note the direction of the risk if this rule is ever wrong: `misheard` never
 * makes a wrong answer count as correct, never advances mastery, and never
 * raises a readiness score. The worst a false `misheard` does is decline to
 * blame a learner. The worst a false `not_known` does is tell them they do not
 * know something they do.
 *
 * Nothing here consults `inputMode`, and it does not need to: the practice DTO
 * rejects an `asrConfidence` on a typed attempt outright, and the realtime tool
 * contract only carries a confidence on a spoken turn, so a confidence only
 * ever arrives on a spoken attempt. The practice DTO rejects one on a SKIPPED
 * attempt too — which is why "not `correct`" can be stated as plainly as the
 * spec states it, without a carve-out for the learner who declined to answer
 * at all.
 *
 * MOVED HERE FROM `practice.service.ts` BY ISSUE #245, unchanged. It was
 * `PracticeService`'s while `PracticeService` was the only caller; it is this
 * module's now that `scheduleMastery` reads it for both.
 */
export function isMisheardAttempt(
  asrConfidence: number | null | undefined,
  outcome: string,
): boolean {
  if (asrConfidence === null || asrConfidence === undefined) return false;
  if (asrConfidence >= ASR_CONFIDENCE_THRESHOLD) return false;
  return outcome !== 'correct';
}

/**
 * Whether this attempt is scheduled, and if not, which rule refused it.
 *
 * ORDER MATTERS ONLY FOR THE REASON REPORTED, never for whether the attempt is
 * scheduled — both conditions refuse. `state_required` is checked first because
 * it is the stronger statement: there were no accepted answers at all, so
 * whether the transcript was trusted is a question about an answer nothing
 * could have graded.
 *
 * **Both refusals are DEFERRALS, not discounts.** A `state_required` attempt is
 * scheduled the moment the learner sets their state and answers again; a
 * misheard one is scheduled from the retry that actually heard them
 * (`docs/specs/voice.md` §3.3). Neither leaves a question permanently
 * unscheduled, and neither charges the learner for it in the meantime.
 */
export function masterySkipReason(
  evidence: MasteryEvidence,
): MasterySkipReason | null {
  if (evidence.answerResolution === 'state_required') return 'state_required';

  if (isMisheardAttempt(evidence.asrConfidence, evidence.outcome)) {
    return 'misheard';
  }

  return null;
}
