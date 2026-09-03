import {
  INTERVIEW_PHASES,
  isSkippedPhase,
  type CivicsStopReason,
  type InterviewPassRule,
} from './engine';
import type {
  InterviewCivicsResult,
  InterviewDebrief,
  InterviewDebriefQuestion,
  InterviewPhaseStatus,
  InterviewReadinessSummary,
} from './dto/interview-debrief.dto';

// =============================================================================
// The debrief builder (issue #133, epic #57 / E8) — `mock-interview.md` §11
// =============================================================================
//
// A pure module, in the shape `readiness/top-recommendation.ts`,
// `journey/study-coach.ts` and `practice/mastery/scheduler.ts` already
// establish: no NestJS, no Prisma, no `Clock`, no I/O. Values in, values out,
// identical output for identical input forever.
//
// -----------------------------------------------------------------------------
// WHY THE DEBRIEF IS A PURE FUNCTION AND NOT A SERVICE METHOD
// -----------------------------------------------------------------------------
//
// It is the single most consequential thing this product ever tells a learner —
// §5.3 calls a mock interview's pass/fail "the most emotionally loaded verdict a
// learner ever receives from OathPath" — and §5.3's whole argument is that such
// a verdict must be reproducible and explainable. A rule that lives inside a
// service method is a rule that can only be exercised through DI, Prisma and
// HTTP; here every branch is reachable by calling one function with plain
// objects, which is what lets `debrief.spec.ts` assert the interesting cases as
// a table.
//
// It is also what keeps the "no model call" property visible. §11 requires
// `focusAreas` to be deterministic, and a file with no way to reach
// `AiDispatchService` cannot acquire one by accident.
//
// -----------------------------------------------------------------------------
// NOTHING HERE RE-DERIVES A NUMBER SOMEONE ELSE ALREADY OWNS
// -----------------------------------------------------------------------------
//
// `planned` and `threshold` are the engine's `InterviewPassRule`, which came
// from the `civics_test_versions` row. `asked`/`correct`/`stopReason` are the
// engine's own counters. `outcome` and `acceptedAnswers` are read off the
// `practice_attempts` rows the grading ladder wrote. The readiness block is the
// snapshot `ReadinessService` just computed. This file arranges those facts; it
// does not decide any of them, and it contains no threshold literal — a test
// reads its source off disk and asserts so, the same way the engine's own spec
// does for `interview-engine.ts`.
// =============================================================================

/** One graded civics attempt, as this builder reads it. */
export interface DebriefAttempt {
  questionId: string;
  number: number;
  prompt: string;
  categoryName: string;
  outcome: 'correct' | 'partial' | 'incorrect' | 'skipped';
  /** From the attempt's FROZEN `answer_snapshot`, never a live re-query (§11). */
  acceptedAnswers: string[];
}

/** Everything {@link buildInterviewDebrief} needs. */
export interface DebriefInput {
  /** N and T, straight from the version row by way of the engine. */
  passRule: InterviewPassRule;
  /** How many questions the interview actually reached. */
  civicsAsked: number;
  civicsCorrect: number;
  /** The engine's own stop reason. Never inferred here from the counters. */
  stopReason: CivicsStopReason;
  passedCivics: boolean;
  /** This interview's own civics attempts, in the order they were answered. */
  attempts: readonly DebriefAttempt[];
  readiness: InterviewReadinessSummary;
}

/**
 * The debrief for one completed interview.
 *
 * Called once, at completion, and the result is persisted verbatim into
 * `mock_interviews.result` — so this function runs a single time per interview
 * and every later read is a read of what it produced. That is deliberate and
 * mirrors `PracticeSession.summary`: a debrief recomputed on every read would
 * be recomputed against a question bank that has since changed, and §11's whole
 * `answer_snapshot` argument would be undone one layer up.
 */
export function buildInterviewDebrief(input: DebriefInput): InterviewDebrief {
  const questions = input.attempts.map(toDebriefQuestion);

  return {
    civics: civicsResult(input),
    questions,
    phases: phaseStatuses(),
    focusAreas: focusAreasFrom(questions),
    readiness: input.readiness,
  };
}

/**
 * The civics section's numbers.
 *
 * `stoppedEarly` is `asked < planned` and NOT `stopReason !== 'all_asked'`, and
 * the difference is worth one sentence. `all_asked` fires when the plan runs
 * out with the outcome still undecided — which, per the engine's own
 * `planCivicsQuestions` comment, is only reachable when the eligible pool was
 * SHORTER than N. In that case `asked < planned` is true and the interview
 * really did stop before the version row's full count, so `stoppedEarly`
 * reports it. Deriving the flag from the stop reason instead would tell a
 * learner their 4-question interview ran its full 10.
 */
function civicsResult(input: DebriefInput): InterviewCivicsResult {
  return {
    planned: input.passRule.questionsAsked,
    asked: input.civicsAsked,
    correct: input.civicsCorrect,
    threshold: input.passRule.passThreshold,
    passed: input.passedCivics,
    stoppedEarly: input.civicsAsked < input.passRule.questionsAsked,
    stopReason: input.stopReason,
  };
}

/** One attempt, as the debrief renders it. A rename, not a computation. */
function toDebriefQuestion(attempt: DebriefAttempt): InterviewDebriefQuestion {
  return {
    questionId: attempt.questionId,
    number: attempt.number,
    prompt: attempt.prompt,
    categoryName: attempt.categoryName,
    outcome: attempt.outcome,
    acceptedAnswers: attempt.acceptedAnswers,
  };
}

/**
 * Every phase, in order, and whether text mode conducted it.
 *
 * COMPUTED FROM `INTERVIEW_PHASES` AND `isSkippedPhase`, never from a literal
 * list — so when E10 supplies the reading and writing content and flips those
 * two phases out of `SKIPPED_PHASES`, this function starts reporting them
 * `completed` in the same edit, with nothing here to remember to change.
 *
 * Every non-skipped phase reports `completed`, including on an interview whose
 * civics section stopped early: the phase was conducted, and the early stop is
 * described by `civics.stopReason`, which is where a learner should read it.
 * Reporting `civics: 'skipped'` for an interview that asked six questions and
 * passed would be plainly wrong.
 */
function phaseStatuses(): InterviewPhaseStatus[] {
  return INTERVIEW_PHASES.map((phase) => ({
    kind: phase,
    status: isSkippedPhase(phase) ? ('skipped' as const) : ('completed' as const),
  }));
}

/**
 * Category names with at least one non-`correct` outcome, in the order they
 * were first missed.
 *
 * DETERMINISTIC, NO MODEL CALL (§11), and no ranking either: this is a list of
 * where the misses were, not a judgement about which matters most. A count per
 * category would invite a screen to render "you missed 3 of 4 in American
 * Government", which is a characterisation of a six-question sample dressed as
 * a measurement — and §11.1's copy rule is to name the questions, not the
 * person.
 *
 * A `skipped` outcome counts as a miss here, and that is the honest reading:
 * `skipped` on an interview attempt means the deterministic rung could not
 * resolve an answer to grade against (a `state`-scope question with no state on
 * the profile — see `AttemptGradingService.gradeDeterministic`). The learner
 * did not demonstrate the category, so the category is worth another look; what
 * it must never do is enter the evidence table as a wrong answer, and it does
 * not.
 */
export function focusAreasFrom(
  questions: readonly InterviewDebriefQuestion[],
): string[] {
  const seen = new Set<string>();
  const areas: string[] = [];

  for (const question of questions) {
    if (question.outcome === 'correct') continue;
    if (seen.has(question.categoryName)) continue;

    seen.add(question.categoryName);
    areas.push(question.categoryName);
  }

  return areas;
}
