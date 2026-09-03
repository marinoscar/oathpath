import { N400_PROMPTS } from './officer-lines';
import {
  INTERVIEW_PHASES,
  PHASE_TURNS,
  type InterviewPhase,
  type SkippedPhase,
} from './phases';
import { shuffleWithSeed } from './seeded-random';

// =============================================================================
// The mock interview engine (issue #123, epic #57 / E8 "Mock interview")
// =============================================================================
//
// `nextPrompt` and `applyAnswer` — what the officer asks next, and what one
// answer does to the interview. Pure TypeScript only: no NestJS, no Prisma, no
// `Clock`, no `Date`, no I/O of any kind, exactly like
// `practice/mastery/scheduler.ts`'s `nextSchedule` and
// `readiness/readiness-engine.ts`'s `computeReadiness`. Values in, values out,
// identical output for identical input forever, and the state handed in is
// never mutated.
//
// The caller (an `InterviewsService`, eventually) owns Prisma, the clock, AI
// dispatch and the transcript. It reads a `civics_test_versions` row, hands
// this module the two numbers on it, hands it a pool of question ids, and asks
// it what happens next. This module never sees a user id, a database client,
// or a model.
//
// -----------------------------------------------------------------------------
// THE PASS RULE IS A ROW. IT IS NEVER A CONSTANT.
// -----------------------------------------------------------------------------
//
// How many civics questions are asked (N) and how many must be correct to pass
// (T) are columns on `civics_test_versions` — `questions_asked` /
// `pass_threshold`, and `senior_questions_asked` / `senior_pass_threshold` for
// a learner with the 65/20 exemption. Different test versions carry different
// values, and a learner's version is resolved per learner.
//
// So there is NO threshold literal anywhere in this file. Not as a default,
// not as a fallback for a missing row, not as a "sanity check", not in a
// comment-shaped constant. {@link selectPassRule} is the single place the
// senior branch is decided, and it decides it by reading two of four columns —
// it does not know what numbers are in them and must never learn.
//
// `interview-engine.spec.ts` enforces this by reading this file's own source
// off disk and asserting no such literal appears in it. That test exists
// because the weaker, obvious test — run two version rows, assert they behave
// differently — passes just as happily against an implementation that has a
// hardcoded default sitting on a path neither row exercises. Source is the
// only place the absence of a number is actually observable.
// =============================================================================

/** Why the civics phase ended. Always exactly one of these, never inferred later. */
export type CivicsStopReason = 'threshold_reached' | 'threshold_unreachable' | 'all_asked';

/**
 * The pass rule, read from a `civics_test_versions` row by the caller.
 *
 * Deliberately narrower than the row: the engine needs the two numbers that
 * apply to THIS learner, and has no business knowing there are four columns or
 * which two it was handed. {@link selectPassRule} is what collapses four into
 * two.
 */
export interface InterviewPassRule {
  /** N — how many civics questions this interview plans to ask. */
  questionsAsked: number;
  /** T — how many must be correct to pass. */
  passThreshold: number;
}

/** The four columns {@link selectPassRule} chooses between. */
export interface InterviewPassRuleColumns {
  questionsAsked: number;
  passThreshold: number;
  seniorQuestionsAsked: number;
  seniorPassThreshold: number;
}

/**
 * The whole state of one interview, as this engine sees it.
 *
 * Every field is either an input the caller resolved (`seed`, `passRule`,
 * `civicsPlan`) or a counter this module maintains. There is no derived field
 * that could disagree with another — `passedCivics` is a function over this
 * state, not a stored boolean, for that reason.
 */
export interface InterviewState {
  /** The interview's own id — the shuffle seed. See `seeded-random.ts`. */
  seed: string;
  phase: InterviewPhase;
  /** How many turns have been taken IN THE CURRENT PHASE. */
  phaseTurnIndex: number;
  passRule: InterviewPassRule;
  /** The ordered civics ask-list, derived once from the pool + seed. */
  civicsPlan: readonly string[];
  civicsAsked: number;
  civicsCorrect: number;
  stopReason: CivicsStopReason | null;
  completed: boolean;
}

/** What the officer does next. */
export type InterviewPrompt =
  | { kind: 'smalltalk' }
  | { kind: 'n400'; promptText: string }
  | {
      kind: 'civics';
      questionId: string;
      /** 1-based position within {@link InterviewState.civicsPlan}. */
      questionNumberInPlan: number;
      plannedCount: number;
    }
  | { kind: 'skipped_segment'; phase: SkippedPhase }
  | { kind: 'closing' }
  | { kind: 'completed' };

/**
 * One answer, as the caller reports it.
 *
 * `correct` is only meaningful in the civics phase — small talk and the N-400
 * rehearsal prompts are not graded at all, and a skipped segment consumes no
 * learner answer. In every non-civics phase this just advances the turn.
 *
 * `phase` is the caller's statement of which phase the answer belongs to, and
 * it must agree with the state's own phase. A disagreement means the caller
 * and the engine no longer share a view of where the interview is, and the
 * cheapest place to catch that is here — before a small-talk answer is
 * silently absorbed into the civics tally, where it would change a pass into a
 * fail (or worse, a fail into a pass) with nothing in the transcript to
 * explain it.
 */
export interface InterviewAnswerOutcome {
  phase: InterviewPhase;
  correct: boolean;
}

/** Everything {@link startState} needs. */
export interface StartInterviewInput {
  /** The interview's own id. */
  seed: string;
  passRule: InterviewPassRule;
  /**
   * Every question id this interview may draw from, already filtered by the
   * caller — the right test version, the senior-eligible subset when the
   * exemption applies, and nothing the learner's state makes unanswerable
   * (`practice/question-selection.ts`'s `excludeUnanswerable` is that rule,
   * and it belongs to the caller, not here).
   */
  questionPool: readonly string[];
}

/**
 * Pick the pass rule that applies to this learner — the ONLY place the senior
 * branch is decided.
 *
 * A learner aged 65 or over with the required years of permanent residency
 * answers from a smaller pool and needs fewer correct. That is two different
 * numbers, not a discount applied to one number, which is why the row carries
 * four columns and why this function returns a whole rule rather than a
 * modifier. Nothing downstream branches on `seniorExemption` again: once this
 * has returned, the rest of the engine sees one N and one T and cannot tell
 * which pair it was handed.
 */
export function selectPassRule(
  version: InterviewPassRuleColumns,
  seniorExemption: boolean,
): InterviewPassRule {
  return seniorExemption
    ? {
        questionsAsked: version.seniorQuestionsAsked,
        passThreshold: version.seniorPassThreshold,
      }
    : {
        questionsAsked: version.questionsAsked,
        passThreshold: version.passThreshold,
      };
}

/**
 * The ordered civics ask-list: the pool shuffled by the interview's own seed,
 * truncated to N.
 *
 * **If the pool is smaller than N, the plan is the whole pool**, and this
 * module does nothing to compensate for that. Stated honestly: with a pool
 * shorter than T, the threshold is unreachable from the very first question,
 * and the interview will run out of questions and end with
 * `stopReason: 'all_asked'` and {@link passedCivics} false. That is the
 * correct outcome and the stop rule already produces it.
 *
 * What must NEVER be done about it is lowering T to fit the pool. A pass mark
 * that quietly adjusts itself to whatever content happens to be loaded is a
 * mock interview that tells a learner they are ready for a test it did not
 * administer — the single most expensive lie this product could tell, and one
 * a learner has no way to detect. A short pool is a content bug: it should
 * surface as an interview nobody can pass, loudly, not as an easier interview
 * everybody passes.
 *
 * Note the two stop reasons stay distinguishable here, which is why the
 * unreachable rule is written against the row's own miss budget (N − T) rather
 * than against the plan's remaining length. `threshold_unreachable` means the
 * learner spent the misses the rule allows; `all_asked` means the bank ran
 * out. A debrief that conflates them tells a learner they failed when in fact
 * they were never given a full test.
 */
export function planCivicsQuestions(
  pool: readonly string[],
  seed: string,
  passRule: InterviewPassRule,
): string[] {
  return shuffleWithSeed(pool, seed).slice(0, passRule.questionsAsked);
}

/** A fresh interview, positioned at the first phase of {@link INTERVIEW_PHASES}. */
export function startState(input: StartInterviewInput): InterviewState {
  const state: InterviewState = {
    seed: input.seed,
    phase: INTERVIEW_PHASES[0],
    phaseTurnIndex: 0,
    passRule: input.passRule,
    civicsPlan: planCivicsQuestions(input.questionPool, input.seed, input.passRule),
    civicsAsked: 0,
    civicsCorrect: 0,
    stopReason: null,
    completed: false,
  };

  return settlePhase(state);
}

/**
 * The civics stop rule, evaluated after every civics answer AND on entry to
 * the civics phase.
 *
 * Three first-class outcomes, in this order — the order is the rule, not a
 * detail of the implementation:
 *
 *   1. `threshold_reached`     — T correct. Stop. The learner has passed and
 *                                asking more questions cannot change that.
 *                                Checked FIRST so an answer that both reaches
 *                                T and exhausts the plan reports the reason
 *                                that describes what the learner did.
 *   2. `threshold_unreachable` — more misses than the rule's budget (N − T).
 *                                Stop. Continuing would ask a learner who has
 *                                already failed to keep answering, which is
 *                                the real interview's behaviour and also the
 *                                kinder one.
 *   3. `all_asked`             — the plan is exhausted with the outcome still
 *                                undecided. Only reachable when the pool was
 *                                shorter than N; see {@link planCivicsQuestions}.
 *
 * Returns `null` while the interview should continue.
 */
function civicsStopReason(state: InterviewState): CivicsStopReason | null {
  const { questionsAsked, passThreshold } = state.passRule;

  if (state.civicsCorrect >= passThreshold) return 'threshold_reached';

  const misses = state.civicsAsked - state.civicsCorrect;
  if (misses > questionsAsked - passThreshold) return 'threshold_unreachable';

  if (state.civicsAsked >= state.civicsPlan.length) return 'all_asked';

  return null;
}

/**
 * Apply the stop rule on ENTRY to a phase.
 *
 * Only the civics phase has an entry condition, and it is the same rule
 * applied after every answer — so an interview whose plan is empty, or whose
 * rule is already satisfied before a question is asked, moves straight on with
 * a recorded `stopReason` instead of reaching {@link nextPrompt} in a state
 * that has no question to serve.
 */
function settlePhase(state: InterviewState): InterviewState {
  if (state.phase !== 'civics') return state;

  const reason = civicsStopReason(state);
  if (reason === null) return state;

  return advancePhase({ ...state, stopReason: reason });
}

/**
 * Move to the next phase in {@link INTERVIEW_PHASES}, or complete the
 * interview if there is no next phase.
 *
 * `phaseTurnIndex` resets, because it counts turns within a phase and nothing
 * else. Returns a NEW state; the input is never mutated.
 */
export function advancePhase(state: InterviewState): InterviewState {
  const nextIndex = INTERVIEW_PHASES.indexOf(state.phase) + 1;

  if (nextIndex >= INTERVIEW_PHASES.length) {
    return { ...state, phaseTurnIndex: 0, completed: true };
  }

  return settlePhase({
    ...state,
    phase: INTERVIEW_PHASES[nextIndex],
    phaseTurnIndex: 0,
  });
}

/**
 * What the officer asks next, for a state this module produced.
 *
 * Total over every state reachable through {@link startState},
 * {@link applyAnswer} and {@link advancePhase}. A hand-built state that is in
 * the civics phase with no question left to serve has skipped the stop rule,
 * which is a programming error rather than an interview outcome — it throws,
 * naming the disagreement, instead of returning some other phase's prompt and
 * letting a transcript record a question that was never planned.
 */
export function nextPrompt(state: InterviewState): InterviewPrompt {
  if (state.completed) return { kind: 'completed' };

  switch (state.phase) {
    case 'smalltalk':
      return { kind: 'smalltalk' };

    case 'n400':
      // Modulo, so the prompt list and `N400_TURNS` can be changed
      // independently without this indexing off the end. The list is the
      // longer of the two by design — see `officer-lines.ts`.
      return { kind: 'n400', promptText: N400_PROMPTS[state.phaseTurnIndex % N400_PROMPTS.length] };

    case 'civics': {
      if (state.civicsAsked >= state.civicsPlan.length || state.stopReason !== null) {
        throw new Error(
          'nextPrompt: the interview is in the civics phase with no question left to ask. ' +
            'The stop rule was bypassed — this state was not produced by startState/applyAnswer/advancePhase.',
        );
      }

      return {
        kind: 'civics',
        questionId: state.civicsPlan[state.civicsAsked],
        questionNumberInPlan: state.civicsAsked + 1,
        plannedCount: state.civicsPlan.length,
      };
    }

    case 'reading':
    case 'writing':
      return { kind: 'skipped_segment', phase: state.phase };

    case 'closing':
      return { kind: 'closing' };
  }
}

/**
 * Advance the interview by one answered turn.
 *
 * PURE: returns a NEW state and never mutates the one it was given, exactly
 * like `nextSchedule`. An answer in the civics phase updates the tally and
 * then re-runs the stop rule; an answer in any other phase advances that
 * phase's turn counter and moves on when the phase has had its turns.
 */
export function applyAnswer(
  state: InterviewState,
  outcome: InterviewAnswerOutcome,
): InterviewState {
  if (state.completed) return { ...state };

  if (outcome.phase !== state.phase) {
    throw new Error(
      `applyAnswer: outcome phase "${outcome.phase}" does not match interview phase "${state.phase}".`,
    );
  }

  if (state.phase === 'civics') {
    const answered: InterviewState = {
      ...state,
      phaseTurnIndex: state.phaseTurnIndex + 1,
      civicsAsked: state.civicsAsked + 1,
      civicsCorrect: state.civicsCorrect + (outcome.correct ? 1 : 0),
    };

    const reason = civicsStopReason(answered);
    return reason === null ? answered : advancePhase({ ...answered, stopReason: reason });
  }

  const phaseTurnIndex = state.phaseTurnIndex + 1;
  const advanced: InterviewState = { ...state, phaseTurnIndex };

  return phaseTurnIndex >= PHASE_TURNS[state.phase] ? advancePhase(advanced) : advanced;
}

/**
 * Whether the civics section was passed: `civicsCorrect >= passThreshold`.
 *
 * A function over the state rather than a stored flag, so it cannot drift from
 * the counters it is computed from — and so it reads the SAME `passThreshold`
 * the stop rule reads, from the same place, rather than a second copy that a
 * later edit could leave behind.
 */
export function passedCivics(state: InterviewState): boolean {
  return state.civicsCorrect >= state.passRule.passThreshold;
}
