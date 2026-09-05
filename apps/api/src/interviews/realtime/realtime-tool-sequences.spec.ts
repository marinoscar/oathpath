import {
  applyAnswer,
  selectPassRule,
  startState,
  type InterviewPassRule,
  type InterviewPassRuleColumns,
  type InterviewState,
} from '../engine';
import {
  decideEndPhase,
  decideGradeAnswer,
  decideNextQuestion,
  type OutstandingItem,
  type RealtimeTurnContext,
} from './realtime-tool-calls';

// =============================================================================
// realtime-tool-sequences.spec.ts — issue #161, epic #60 (E11)
// =============================================================================
//
// `docs/specs/realtime-interview.md` §10 is the brief this file answers: "the
// tool-handling layer... is testable the identical way `interview-engine.spec.ts`
// already tests the text transport: construct a state, feed it a scripted
// sequence of tool-call-shaped inputs, and assert the exact resulting question
// sequence, the exact stop reason, and the exact debrief... with no database,
// no network call, and no AI provider anywhere in the loop."
//
// -----------------------------------------------------------------------------
// WHAT THIS FILE DOES NOT RE-TEST, AND WHY
// -----------------------------------------------------------------------------
//
// #158 already shipped two suites that drive scripted sequences through this
// exact contract:
//
//   * `realtime-tool-calls.spec.ts` — the pure rules, per function, including a
//     stop-rule table over two SYNTHETIC pass-rule rows ("STANDARD" 10/6 and
//     "WIDE" 20/12) and a source-reading proof that no threshold literal is
//     compiled into this module.
//   * `interviews.service.spec.ts`'s "the realtime tool contract" describe
//     block — full scripted sequences through `InterviewsService
//     .handleRealtimeToolCall` itself (the layer that touches the database):
//     the exact question sequence, `grade_answer` discarding a model-implied
//     verdict, a wrong-item call being rejected AND recorded rather than
//     graded, a low-confidence civics answer landing as `failure_cause:
//     'misheard'` with no mastery scheduled, and a misheard READING attempt
//     writing no row at all and leaving the segment outstanding.
//
// None of that is repeated here. This file's distinct value is the one gap
// neither suite closes: every existing stop-rule test — pure or
// service-level — runs against either the synthetic STANDARD/WIDE numbers or
// a one-off mocked override invented for one test (`questionsAsked: 12,
// passThreshold: 8`), never the THREE PASS RULES this product actually seeds
// (`apps/api/prisma/seed.ts`'s `CIVICS_TEST_VERSIONS`): the 2008 test (10
// asked, 6 to pass), the 2025 test (20 asked, 12 to pass), and the 65/20
// senior accommodation (10 asked, 6 to pass — identical for both version rows,
// per that seed file's own comment, and deliberately DIFFERENT from the 2025
// test's own non-senior rule, which is the case worth exercising: a senior
// learner taking the 2025 bank must stop at the accommodation's own number,
// not the version's).
//
// `threshold_unreachable` is tested nowhere against the realtime tool
// contract at all before this file — `interviews.service.spec.ts` exercises it
// only through the TEXT transport's `POST /interviews/:id/turns` route
// (`create -> answer -> complete`'s "stops early the other way"). This file
// closes that gap too, for all three real pass rules.
//
// The real numbers live HERE, in a fixture, never inside `realtime-tool-
// calls.ts` or `interview-engine.ts` — the same discipline
// `interviews.service.spec.ts`'s own `VERSION_ROW` states for itself, and the
// one this suite's own "no literal in the rules' own source" check (below)
// exists to hold.
// =============================================================================

/**
 * The real `civics_test_versions` seed rows (`apps/api/prisma/seed.ts`,
 * `CIVICS_TEST_VERSIONS`), copied here as data rather than imported: this
 * suite is pure TypeScript with no Prisma and no database, and the seed
 * module is neither. Copying the numbers, not the file, is also what makes
 * this suite's own "the rules' source contains none of these digits" check
 * meaningful — the numbers must come from SOMEWHERE outside the module under
 * test.
 */
const V2008: InterviewPassRuleColumns = {
  questionsAsked: 10,
  passThreshold: 6,
  seniorQuestionsAsked: 10,
  seniorPassThreshold: 6,
};

const V2025: InterviewPassRuleColumns = {
  questionsAsked: 20,
  passThreshold: 12,
  seniorQuestionsAsked: 10,
  seniorPassThreshold: 6,
};

/**
 * The three variants issue #161 names explicitly: the 2008 test, the 2025
 * test, and the 65/20 senior accommodation. The accommodation is taken off
 * the 2025 row specifically — `selectPassRule(V2025, true)` — because that is
 * the case where the accommodation's own numbers (10/6) genuinely differ from
 * the version's own non-senior rule (20/12); taking it off the 2008 row would
 * exercise a branch whose senior and non-senior numbers happen to be
 * identical and prove nothing about the branch actually being read.
 */
const VARIANTS: [string, InterviewPassRule][] = [
  ['the 2008 test (10 asked, 6 to pass)', selectPassRule(V2008, false)],
  ['the 2025 test (20 asked, 12 to pass)', selectPassRule(V2025, false)],
  ['the senior accommodation on the 2025 bank (10 asked, 6 to pass)', selectPassRule(V2025, true)],
];

/** A pool comfortably larger than the widest variant's N (20). */
const POOL = Array.from(
  { length: 40 },
  (_, index) => `question-${String(index + 1).padStart(3, '0')}`,
);

const SEED = 'e161seed-0000-4000-8000-000000000001';

function ctx(
  state: InterviewState,
  outstanding: OutstandingItem | null = null,
): RealtimeTurnContext {
  return {
    interviewStatus: 'in_progress',
    state,
    outstanding,
    ungradedTurnPending: false,
  };
}

/** Walk past smalltalk/n400 to the first civics question, by tool calls alone. */
function reachCivics(passRule: InterviewPassRule): InterviewState {
  let state = startState({ seed: SEED, passRule, questionPool: POOL });
  while (state.phase !== 'civics') {
    // Neither phase scores anything, so the correctness argument is
    // irrelevant — only the turn count matters, and `applyAnswer` is the
    // engine's own way of taking one.
    state = applyAnswer(state, { phase: state.phase, correct: false });
  }
  return state;
}

/**
 * Drive one full civics section by SCRIPTED TOOL CALLS ONLY — `next_question`,
 * `grade_answer`, `end_phase` — asserting, on every single question, the four
 * properties issue #161 asks this suite to hold together rather than singly:
 *
 *   1. `end_phase('civics')` is REJECTED for as long as the engine's own stop
 *      rule has not fired — never honoured early, regardless of how far into
 *      the section the model is.
 *   2. A second `next_question` while an answer is outstanding is REJECTED
 *      (`answer_outstanding`) — the engine's tally cannot be inflated by
 *      asking faster than the applicant answers.
 *   3. `grade_answer` accepts the outstanding item and reports NOTHING about
 *      the verdict (the field-level proof lives in `realtime-tool-calls.ts`
 *      itself; this is the sequence-level echo of it).
 *   4. The question sequence served is EXACTLY the engine's own
 *      `civicsPlan`, in order — never a question this suite invented.
 *
 * `correct` decides the outcome of every answer asked; the loop stops the
 * moment the engine leaves the civics phase, however that happened.
 */
function driveCivicsSection(
  passRule: InterviewPassRule,
  correct: boolean,
): { finalState: InterviewState; askedQuestionIds: string[] } {
  let state = reachCivics(passRule);
  const asked: string[] = [];

  for (;;) {
    // PROPERTY 1, checked on every iteration before a question is even asked:
    // the stop rule has not fired yet, so ending the phase now must be
    // refused.
    const early = decideEndPhase(ctx(state), { tool: 'end_phase', phase: 'civics' });
    expect(early.status).toBe('rejected');
    if (early.status === 'rejected') expect(early.reason).toBe('phase_not_over');

    const nq = decideNextQuestion(ctx(state));
    expect(nq.status).toBe('ok');
    if (nq.status !== 'ok') break;
    expect(nq.prompt.kind).toBe('civics');
    if (nq.prompt.kind !== 'civics') break;

    const questionId = nq.prompt.questionId;
    asked.push(questionId);
    const outstanding: OutstandingItem = { kind: 'civics', questionId };

    // PROPERTY 2: the officer cannot ask a second question before this one is
    // graded.
    const duplicate = decideNextQuestion(ctx(state, outstanding));
    expect(duplicate.status).toBe('rejected');
    if (duplicate.status === 'rejected') {
      expect(duplicate.reason).toBe('answer_outstanding');
    }

    // PROPERTY 3: the call is accepted and carries no verdict of any kind —
    // it hands back only the join key it was given, never an opinion.
    const graded = decideGradeAnswer(ctx(state, outstanding), {
      tool: 'grade_answer',
      questionId,
      transcript: correct ? 'the accepted answer' : 'not the accepted answer',
    });
    expect(graded).toEqual({ status: 'ok', item: outstanding });

    state = applyAnswer(state, { phase: 'civics', correct });

    if (state.phase !== 'civics') break;
  }

  return { finalState: state, askedQuestionIds: asked };
}

describe('scripted realtime sequences over the real civics_test_versions rows', () => {
  describe.each(VARIANTS)('%s', (_label, passRule) => {
    it('stops with threshold_reached at exactly T correct, and the debrief agrees', () => {
      const { finalState, askedQuestionIds } = driveCivicsSection(passRule, true);

      // PROPERTY 4: the exact sequence served is the engine's own plan, in
      // order — never re-derived or reordered by this suite.
      const plan = reachCivics(passRule).civicsPlan;
      expect(askedQuestionIds).toEqual(plan.slice(0, askedQuestionIds.length));

      expect(finalState.stopReason).toBe('threshold_reached');
      expect(askedQuestionIds).toHaveLength(passRule.passThreshold);
      expect(finalState.civicsAsked).toBe(passRule.passThreshold);
      expect(finalState.civicsCorrect).toBe(passRule.passThreshold);

      // The officer's own `end_phase` call, made once the engine has actually
      // left the phase — HONOURED, and it names where the interview now is.
      const honoured = decideEndPhase(ctx(finalState), {
        tool: 'end_phase',
        phase: 'civics',
      });
      expect(honoured.status).toBe('ok');
      if (honoured.status === 'ok') expect(honoured.nextPhase).toBe(finalState.phase);
    });

    it('stops with threshold_unreachable at exactly the miss budget, and never asks past it', () => {
      const { finalState, askedQuestionIds } = driveCivicsSection(passRule, false);

      const missBudget = passRule.questionsAsked - passRule.passThreshold;

      expect(finalState.stopReason).toBe('threshold_unreachable');
      // One miss MORE than the budget is what proves the rule fired on the
      // miss that broke it, not one question early or one question late.
      expect(askedQuestionIds).toHaveLength(missBudget + 1);
      expect(finalState.civicsCorrect).toBe(0);
      expect(finalState.civicsCorrect).toBeLessThan(passRule.passThreshold);

      const honoured = decideEndPhase(ctx(finalState), {
        tool: 'end_phase',
        phase: 'civics',
      });
      expect(honoured.status).toBe('ok');
    });

    it('a call naming a question other than the one outstanding is rejected, not graded', () => {
      const state = reachCivics(passRule);
      const first = decideNextQuestion(ctx(state));
      expect(first.status).toBe('ok');
      if (first.status !== 'ok' || first.prompt.kind !== 'civics') return;

      const outstanding: OutstandingItem = {
        kind: 'civics',
        questionId: first.prompt.questionId,
      };
      // A real id from the SAME plan, just not the one asked — exactly what a
      // duplicate or out-of-order call from the model looks like.
      const someOtherQuestion = state.civicsPlan.find(
        (id) => id !== outstanding.questionId,
      )!;

      const rejected = decideGradeAnswer(ctx(state, outstanding), {
        tool: 'grade_answer',
        questionId: someOtherQuestion,
        transcript: 'anything at all',
      });

      expect(rejected.status).toBe('rejected');
      if (rejected.status === 'rejected') expect(rejected.reason).toBe('wrong_item');
      // NOT GRADED: the state this suite would advance from is untouched —
      // there is nothing here for a caller to have applied `applyAnswer` to,
      // because `decideGradeAnswer` never produced an `ok` result to act on.
    });
  });
});

// -----------------------------------------------------------------------------
// No real pass-rule digit is compiled into the rules themselves
// -----------------------------------------------------------------------------
//
// The behavioural tests above prove the real numbers are READ correctly;
// only source can prove they are not also sitting somewhere as a fallback or
// a default the fixtures above never exercise. Same discipline as
// `realtime-tool-calls.spec.ts`'s own source-reading check, run again here
// against the PRODUCTION numbers rather than the synthetic STANDARD/WIDE
// ones, because a module could satisfy the synthetic check while still
// hardcoding a real one on an unreached branch.

describe('none of the real seeded thresholds are compiled into the tool rules', () => {
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  const source = stripComments(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').readFileSync(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:path').join(__dirname, 'realtime-tool-calls.ts'),
      'utf8',
    ),
  );

  it.each(['6', '10', '12', '20'])(
    'contains no occurrence of the digits %s outside comments',
    (forbidden) => {
      expect(source).not.toContain(forbidden);
    },
  );
});
