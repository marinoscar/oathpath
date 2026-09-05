// =============================================================================
// Attempt → reaction event (issue #320, epic #305 "The Coach's personality")
// =============================================================================
//
// One pure, total function: given the handful of facts a `practice_attempts`
// row already carries, say WHICH of `reaction-lines.ts`'s ten events just
// happened. `select-line.ts` then says what the coach says about it.
//
// -----------------------------------------------------------------------------
// WHY THIS IS ITS OWN MODULE RATHER THAN A `switch` IN `PracticeService`
// -----------------------------------------------------------------------------
//
// Two reasons, and the second is the load-bearing one:
//
//  1. It is testable without Nest. This file imports NOTHING at runtime — no
//     Nest, no Prisma, no clock, no provider — the same discipline
//     `grading.ts`, `personas.ts`, `reaction-lines.ts` and `select-line.ts`
//     each state for themselves, so `attempt-event.spec.ts` calls it directly
//     and enumerates every branch rather than driving HTTP to reach one.
//
//  2. THE PRECEDENCE IS A PRODUCT DECISION, not an implementation detail, and
//     it needs to sit somewhere a person can read it end to end. `misheard`
//     outranking the outcome (below) is the whole difference between telling a
//     learner "that was wrong" and telling them "we did not hear you", and a
//     precedence rule scattered through a mapper's `if`s in a 1700-line
//     service is a rule that gets reordered by accident.
//
// -----------------------------------------------------------------------------
// THE ORDER OF THE CHECKS, AND WHY IT IS THIS ORDER
// -----------------------------------------------------------------------------
//
// `misheard` is checked FIRST, ahead of the outcome, because it is not a
// statement about the learner's knowledge at all — it says the recogniser was
// not trusted, which is a fact about the microphone (`docs/specs/voice.md` §3,
// and `CLAUDE.md`'s own `practice_attempts` note: the server sets this cause
// itself, "overriding any cause the AI grader supplied"). Such a row is
// `incorrect` or `partial` in its `outcome` column, so an outcome-first mapper
// would react to a mishearing as if the learner had been wrong — the exact
// thing E14's floor rule 1 exists to prevent from ever being said out loud
// about somebody's speech.
//
// `self_marked` is checked next, ahead of `correct`, for the mirror-image
// reason `practice-sessions.md` §9 rejects a `self_correct` OUTCOME value: the
// outcome says it counts as right, `gradingMethod` says how it came to be
// right, and a coach that congratulated a self-mark in the same words it uses
// for a verified match would be congratulating somebody on a matcher's behalf
// (`reaction-lines.ts`'s own header makes exactly this point about why the two
// are separate events).
//
// Everything after that is a plain read of `outcome`.
// =============================================================================

import type { CoachReactionEvent } from './reaction-lines';

/**
 * How many consecutive correct answers make a run worth remarking on.
 *
 * THREE, INCLUSIVE OF THE ATTEMPT BEING MAPPED. Two in a row is a coincidence
 * and saying so cheapens the observation; the epic's own stated failure is
 * that "five in a row reads as five identical sentences", and a threshold of
 * three means the third, fourth and fifth of those five each draw from the
 * `answer.correct_run` cell instead.
 *
 * `docs/specs/coach-personality.md` §6 deliberately leaves this number to this
 * module rather than fixing it as a product contract: "the threshold is a
 * reaction-selection detail, not a product contract", so moving it is a tuning
 * change and does not reopen that document.
 */
export const COACH_CORRECT_RUN_THRESHOLD = 3;

/**
 * Everything {@link coachEventForAttempt} reads, and nothing else.
 *
 * NARROWED FROM THE ROW ON PURPOSE, the same way
 * `DeterministicGradingInput` is narrowed from `RecordAttemptInput`: stating
 * the four fields as a type is what lets a test construct one in a line, and
 * what stops this function from quietly growing a dependency on a column that
 * a caller reading a narrowed `select` would not have loaded.
 */
export interface CoachAttemptFacts {
  /** The recorded outcome. */
  readonly outcome: 'correct' | 'partial' | 'incorrect' | 'skipped';

  /** Who or what made the call — `exact` | `self` | `ai`. */
  readonly gradingMethod: 'exact' | 'self' | 'ai';

  /**
   * The recorded failure cause, or null when no grader ran.
   *
   * Typed as a plain nullable string rather than the six-value enum so a row
   * written by a newer build carrying a seventh cause is data this function
   * still maps, rather than a compile error at every call site. Only one value
   * is ever compared against.
   */
  readonly failureCause: string | null;

  /**
   * How many consecutive correct answers this attempt is the newest of, within
   * its own session and counting itself. `1` for a lone correct answer, `0`
   * (or anything) for a non-correct one, where it is not read.
   *
   * PASSED IN, NEVER COMPUTED HERE. This function has no session, no
   * repository and no way to ask; the caller already holds the session's
   * attempts in memory when it maps them, and computing a run is a query this
   * module must not learn how to make.
   */
  readonly correctRunLength: number;
}

/**
 * Which of the ten reaction events this attempt is.
 *
 * TOTAL: every combination of the four fields returns one of the seven
 * `answer.*` events. There is no `undefined` branch and no default that means
 * "nothing happened" — an attempt was recorded, so something happened.
 */
export function coachEventForAttempt(
  facts: CoachAttemptFacts,
): CoachReactionEvent {
  // FIRST, AHEAD OF THE OUTCOME. A mishearing is a statement about the
  // microphone, never about the speaker — see the header.
  if (facts.failureCause === 'misheard') return 'answer.misheard';

  // Ahead of `correct`, because the learner did something different and the
  // bank has a different cell for it.
  if (facts.gradingMethod === 'self') return 'answer.self_marked';

  switch (facts.outcome) {
    case 'skipped':
      return 'answer.skipped';
    case 'partial':
      return 'answer.partial';
    case 'incorrect':
      return 'answer.incorrect';
    case 'correct':
    default:
      // The run is the only thing that makes five right answers read as five
      // different sentences rather than one sentence five times.
      return facts.correctRunLength >= COACH_CORRECT_RUN_THRESHOLD
        ? 'answer.correct_run'
        : 'answer.correct';
  }
}

/**
 * The run lengths for a session's attempts, in the order they were answered.
 *
 * Returns a map from attempt id to "how many consecutive correct answers this
 * attempt is the newest of, counting itself" — `1` for the first correct
 * answer after a miss, `2` for the next, and so on. A non-correct attempt maps
 * to `0` and resets the count.
 *
 * ---------------------------------------------------------------------------
 * A PURE FUNCTION OVER ROWS ALREADY LOADED, NOT A QUERY
 * ---------------------------------------------------------------------------
 *
 * Exactly the posture `dropSuperseded` takes in `practice.service.ts`, and for
 * the same reason: two call sites need this number — the immediate response to
 * `POST .../attempts` and the re-read through `GET /api/practice/sessions/:id`
 * — and the ONE property they must have is that they agree, because
 * `docs/specs/coach-personality.md` §7's determinism guarantee is precisely
 * that the live screen and the summary show the same line. Two SQL expressions
 * can drift; one function they both call cannot.
 *
 * The caller is responsible for handing these in answered order and for having
 * already dropped superseded attempts (`voice.md` §3.2) — a mishearing and its
 * correction are one answered question everywhere else in this codebase, and a
 * run that counted the superseded row would be the one place they were two.
 */
export function coachCorrectRunLengths(
  attempts: ReadonlyArray<{ id: string; outcome: string }>,
): Map<string, number> {
  const runs = new Map<string, number>();
  let run = 0;

  for (const attempt of attempts) {
    if (attempt.outcome === 'correct') {
      run += 1;
      runs.set(attempt.id, run);
    } else {
      run = 0;
      runs.set(attempt.id, 0);
    }
  }

  return runs;
}
