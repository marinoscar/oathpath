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
  InterviewSegmentResult,
  InterviewSpokenSummary,
} from './dto/interview-debrief.dto';

// =============================================================================
// The debrief builder (issue #133, epic #57 / E8) — `mock-interview.md` §11
// Extended for the spoken transport by issue #160 (epic #60 / E11) —
// `realtime-interview.md` §5, §6, §8
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
// `practice_attempts` rows the grading ladder wrote, and since #160 so are
// `input_mode`, `failure_cause` and `asr_confidence`; the segment results are
// `english_attempts` rows, paired to this interview by the caller. The
// readiness block is the snapshot `ReadinessService` just computed. This file
// arranges those facts; it does not decide any of them, and it contains no
// threshold literal — a test reads its source off disk and asserts so, the same
// way the engine's own spec does for `interview-engine.ts`.
//
// THE ONE THING THIS FILE DOES DECIDE is what a debrief CALLS a mishearing, and
// that is deliberate rather than an exception: the mapping from the whole
// six-value `failure_cause` enum to a single boolean is a presentation choice,
// it is made once here rather than once per caller, and both facts survive it
// — `outcome` is copied through beside `misheard`, untouched.
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

  /** `practice_attempts.input_mode`, verbatim (issue #160, E11 §6). */
  inputMode: 'typed' | 'spoken';

  /**
   * `practice_attempts.failure_cause`, verbatim — the whole column, not a
   * boolean the caller pre-computed.
   *
   * THE MAPPING TO "misheard" IS MADE HERE, ONCE. The column is a closed
   * six-value enum in which `null` means no grader ran and `'unknown'` means
   * one ran and honestly could not tell; a caller that flattened it to a
   * boolean would be deciding what the debrief says, which is this module's
   * job — and it would decide it in as many places as there are callers.
   */
  failureCause: string | null;

  /** `practice_attempts.asr_confidence`. Null means UNKNOWN, never low. */
  asrConfidence: number | null;
}

/**
 * One conducted English segment, as this builder reads it — an
 * `english_attempts` row plus its sentence's text.
 *
 * THE CALLER PROVES THE SEGMENT BELONGS TO THIS INTERVIEW; this module trusts
 * that and only arranges it. The proof is worth naming because
 * `english_attempts` carries no `mock_interview_id` column to join on (E10 §5
 * gave the table no owner but the learner): `InterviewsService` pairs a scored
 * row with an applicant turn this interview recorded in that phase, so an entry
 * reaching here has two independent stored traces behind it, not one.
 */
export interface DebriefSegmentAttempt {
  kind: 'reading' | 'writing';
  outcome: 'correct' | 'partial' | 'incorrect';
  /** `english_sentences.text` — the reveal, read after the fact. */
  sentence: string;
  wer: number;
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
  /**
   * The English segments this interview conducted and scored, in phase order.
   *
   * EMPTY IS THE ORDINARY CASE and means the segments were not conducted —
   * which is every text interview, and also a voice interview that ended before
   * reaching them. {@link phaseStatuses} reads this array and nothing else to
   * decide the two phases' status, so "conducted" means exactly "produced a
   * scored attempt" here and cannot come to mean anything looser.
   */
  segments: readonly DebriefSegmentAttempt[];
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
  const segments = input.segments.map(toSegmentResult);

  return {
    civics: civicsResult(input),
    questions,
    spoken: spokenSummaryFrom(questions),
    segments,
    phases: phaseStatuses(segments),
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

/**
 * One attempt, as the debrief renders it. A rename and one comparison.
 *
 * The comparison is `failureCause === 'misheard'`, and it is the ONE place in
 * this codebase that decides what a debrief calls a mishearing. `outcome` is
 * copied through untouched beside it: a misheard answer is not re-graded here,
 * re-labelled here, or promoted to `correct` here. Both facts survive, because
 * they are two different facts — see the DTO's own note on the low-confidence
 * transcript that scored correct anyway, which is not a mishearing at all.
 */
function toDebriefQuestion(attempt: DebriefAttempt): InterviewDebriefQuestion {
  return {
    questionId: attempt.questionId,
    number: attempt.number,
    prompt: attempt.prompt,
    categoryName: attempt.categoryName,
    outcome: attempt.outcome,
    acceptedAnswers: attempt.acceptedAnswers,
    inputMode: attempt.inputMode,
    misheard: attempt.failureCause === MISHEARD_FAILURE_CAUSE,
    asrConfidence: attempt.asrConfidence,
  };
}

/**
 * `practice_attempts.failure_cause`'s one value that means "we do not believe
 * these were the learner's words".
 *
 * A named constant rather than an inline string because it is compared against
 * a value the API layer writes as a literal in a different file
 * (`interviews.service.ts`'s `misheard` override) and `voice.md` §3 defines
 * once — a typo in either place would silently report every mishearing as an
 * ordinary miss, which is precisely the failure the whole distinction exists to
 * prevent, and nothing would fail to compile.
 */
const MISHEARD_FAILURE_CAUSE = 'misheard';

/** One segment attempt, as the debrief renders it. A rename, not a computation. */
function toSegmentResult(segment: DebriefSegmentAttempt): InterviewSegmentResult {
  return {
    kind: segment.kind,
    outcome: segment.outcome,
    sentence: segment.sentence,
    wer: segment.wer,
  };
}

/**
 * The three spoken counts (issue #160, `realtime-interview.md` §6, §8).
 *
 * COUNTED OVER THE QUESTIONS THIS DEBRIEF IS ALREADY REPORTING, so the summary
 * and the list beneath it cannot disagree — a learner who counts the "spoken"
 * chips on screen gets the number in the summary, every time. Deriving it from
 * a separate query instead would give the page two answers to one question and
 * no way to tell which is wrong.
 *
 * `correct` deliberately does NOT exclude a misheard answer, and the exclusion
 * would be meaningless rather than merely wrong: `isMisheardAttempt`'s third
 * condition already requires the outcome not be `correct`, so the two sets
 * cannot overlap. Stated here because a reader who has just read
 * {@link focusAreasFrom}'s exclusion will reasonably wonder why this one does
 * not have the matching guard.
 */
function spokenSummaryFrom(
  questions: readonly InterviewDebriefQuestion[],
): InterviewSpokenSummary {
  // FILTERED RATHER THAN COUNTED WITH ACCUMULATORS, and the reason is a test
  // rather than a style preference: `debrief.spec.ts` asserts this module's
  // source contains NO bare numeric literal at all — the strong form of §4's
  // "no threshold in code", chosen because a list of known-bad values would let
  // tomorrow's wrong constant through. A `let correct = 0; correct += 1` pair
  // is three literals that mean nothing, and the honest way to keep the
  // assertion strong is to not write numbers, not to weaken it into a list.
  const spoken = questions.filter((question) => question.inputMode === 'spoken');

  return {
    answers: spoken.length,
    correct: spoken.filter((question) => question.outcome === 'correct').length,
    misheard: spoken.filter((question) => question.misheard).length,
  };
}

/**
 * Every phase, in order, and whether text mode conducted it.
 *
 * COMPUTED FROM `INTERVIEW_PHASES` AND `isSkippedPhase`, never from a literal
 * list — so a phase added to the sequence appears here in the same edit, with
 * nothing to remember to change.
 *
 * -----------------------------------------------------------------------------
 * A SKIPPABLE PHASE IS `completed` WHEN, AND ONLY WHEN, IT PRODUCED A SCORED
 * ATTEMPT (issue #160, `realtime-interview.md` §5)
 * -----------------------------------------------------------------------------
 *
 * `SKIPPED_PHASES` still names `reading` and `writing`, and `phases.ts`'s own
 * header explains why nothing there changed for E11: whether the walk stops in
 * a segment is a decision the officer driver makes from the transport and the
 * transcript, one layer up. This function therefore cannot ask
 * `isSkippedPhase` alone any more — on a realtime interview that conducted the
 * reading test, it would report a segment the learner actually sat as one this
 * rehearsal did not include, which is §2.4's harm with the sign flipped and is
 * worse: a learner told they still have not rehearsed something they have.
 *
 * The evidence is `input.segments`, and specifically NOT
 * `mock_interviews.mode`. A voice interview whose connection dropped during
 * civics, or whose learner had exhausted the sentence bank
 * (`conductableSegments` returns false for both segments then), conducted no
 * more of the reading test than a text interview did — and a mode flag would
 * claim otherwise on both. What the learner sat is what was scored.
 *
 * Every non-skipped phase reports `completed`, including on an interview whose
 * civics section stopped early: the phase was conducted, and the early stop is
 * described by `civics.stopReason`, which is where a learner should read it.
 * Reporting `civics: 'skipped'` for an interview that asked six questions and
 * passed would be plainly wrong.
 */
function phaseStatuses(
  segments: readonly InterviewSegmentResult[],
): InterviewPhaseStatus[] {
  const conducted = new Set<string>(segments.map((segment) => segment.kind));

  return INTERVIEW_PHASES.map((phase) => ({
    kind: phase,
    status:
      isSkippedPhase(phase) && !conducted.has(phase)
        ? ('skipped' as const)
        : ('completed' as const),
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
 * A MISHEARD ANSWER IS NOT A MISS AND IS EXCLUDED (issue #160) — see the
 * comment on the guard itself, which is where the reasoning belongs because it
 * is the guard, not the docstring, that a later reader will be tempted to
 * delete as redundant with the `correct` check above it.
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
    // A MISHEARD ANSWER IS NOT A MISS, AND THIS IS WHERE THAT STOPS BEING ONE
    // (issue #160, `voice.md` §3). The row's `outcome` is not `correct` — the
    // engine graded the words it was handed and they did not match — but its
    // `failure_cause` says we do not believe those were the learner's words.
    // Sending the category here on that evidence would tell a learner to go and
    // study a topic on the strength of a noisy connection, which is the same
    // unearned penalty `voice.md` spent a worked example keeping out of
    // `question_mastery`, arriving instead as advice. `spoken.misheard` reports
    // the mishearings honestly, and the question's own card is marked.
    if (question.misheard) continue;
    if (seen.has(question.categoryName)) continue;

    seen.add(question.categoryName);
    areas.push(question.categoryName);
  }

  return areas;
}
