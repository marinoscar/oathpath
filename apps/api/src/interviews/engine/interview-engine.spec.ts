import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  advancePhase,
  applyAnswer,
  nextPrompt,
  passedCivics,
  planCivicsQuestions,
  selectPassRule,
  startState,
  type InterviewPassRuleColumns,
  type InterviewPhase,
  type InterviewPrompt,
  type InterviewState,
} from './index';
import { INTERVIEW_PHASES, N400_TURNS, SMALLTALK_TURNS } from './phases';

// =============================================================================
// interview-engine.ts — tests (issue #123, epic #57 / E8 "Mock interview")
// =============================================================================
//
// The engine is pure — values in, values out, no clock, no database — so every
// case here is a plain function call over plain objects, in the style of
// `practice/mastery/scheduler.spec.ts`.
//
// The organising idea of this file: **almost nothing below is written against
// a number.** The stop-rule cases run as a table over two `civics_test_versions`
// rows and both senior settings, with ONE shared test body that derives N and
// T from `selectPassRule` and never mentions a literal. If the engine had a
// threshold baked into it, at most one of the four table entries could pass.
// The two spelled-out cases that do use literals (the 10/6 fifth-miss case and
// the small-pool case) exist for readability, as worked examples of what the
// generic bodies above them are asserting.
// =============================================================================

/** A pool comfortably larger than the widest row's N. */
const POOL = Array.from({ length: 60 }, (_, index) => `q${String(index + 1).padStart(3, '0')}`);

const SEED = '9f2c0f6e-0000-4000-8000-000000000001';

/** The standard row: 10 asked, 6 to pass; 6 asked, 4 to pass with the exemption. */
const STANDARD_ROW: InterviewPassRuleColumns = {
  questionsAsked: 10,
  passThreshold: 6,
  seniorQuestionsAsked: 6,
  seniorPassThreshold: 4,
};

/** A wider row: 20 asked, 12 to pass; 10 asked, 6 to pass with the exemption. */
const WIDE_ROW: InterviewPassRuleColumns = {
  questionsAsked: 20,
  passThreshold: 12,
  seniorQuestionsAsked: 10,
  seniorPassThreshold: 6,
};

const ROWS = [
  { label: 'standard row', version: STANDARD_ROW },
  { label: 'wide row', version: WIDE_ROW },
];

/**
 * The four (row, senior) combinations the stop-rule table below runs. Every
 * entry uses the SAME test bodies; only the row and the flag differ, which is
 * the strongest evidence available from a test suite that the rule is read
 * from a row rather than compiled into the engine.
 */
const RULE_CASES = ROWS.flatMap(({ label, version }) =>
  [false, true].map((seniorExemption) => ({
    label: `${label}, seniorExemption=${String(seniorExemption)}`,
    version,
    seniorExemption,
  })),
);

function interviewFor(
  version: InterviewPassRuleColumns,
  seniorExemption: boolean,
  pool: readonly string[] = POOL,
): InterviewState {
  return startState({
    seed: SEED,
    passRule: selectPassRule(version, seniorExemption),
    questionPool: pool,
  });
}

/** Answer through every pre-civics phase, so a case can start at the civics phase. */
function toCivics(state: InterviewState): InterviewState {
  let current = state;
  let guard = 0;

  while (current.phase !== 'civics' && !current.completed && guard < 100) {
    current = applyAnswer(current, { phase: current.phase, correct: false });
    guard += 1;
  }

  return current;
}

/** Feed civics answers one at a time, stopping the moment the engine leaves the phase. */
function playCivics(state: InterviewState, results: readonly boolean[]): InterviewState {
  let current = state;

  for (const correct of results) {
    if (current.phase !== 'civics') break;
    current = applyAnswer(current, { phase: 'civics', correct });
  }

  return current;
}

/** `count` answers, all of them `correct`. */
function repeatAnswer(count: number, correct: boolean): boolean[] {
  return Array.from({ length: count }, () => correct);
}

// =============================================================================
// selectPassRule — the only place the senior branch is decided
// =============================================================================

describe('selectPassRule', () => {
  it.each(ROWS)('reads the standard columns for the $label when seniorExemption is false', ({
    version,
  }) => {
    expect(selectPassRule(version, false)).toEqual({
      questionsAsked: version.questionsAsked,
      passThreshold: version.passThreshold,
    });
  });

  it.each(ROWS)('reads the senior columns for the $label when seniorExemption is true', ({
    version,
  }) => {
    expect(selectPassRule(version, true)).toEqual({
      questionsAsked: version.seniorQuestionsAsked,
      passThreshold: version.seniorPassThreshold,
    });
  });
});

// =============================================================================
// The stop rule, as a table over rows — one body, four rows
// =============================================================================

describe.each(RULE_CASES)(
  'civics stop rule is read from the version row [$label]',
  ({ version, seniorExemption }) => {
    const { questionsAsked: N, passThreshold: T } = selectPassRule(version, seniorExemption);

    it("stops with threshold_reached on the answer that reaches the row's passThreshold, and asks no more", () => {
      const civics = toCivics(interviewFor(version, seniorExemption));

      // One more correct answer than the rule needs, to prove the extra one is
      // never asked rather than merely never counted.
      const finished = playCivics(civics, repeatAnswer(T + 1, true));

      expect(finished.stopReason).toBe('threshold_reached');
      expect(finished.civicsCorrect).toBe(T);
      expect(finished.civicsAsked).toBe(T);
      expect(finished.civicsAsked).toBeLessThanOrEqual(N);
      expect(passedCivics(finished)).toBe(true);
      expect(finished.phase).toBe('reading');
    });

    it("stops with threshold_unreachable on the miss that spends the row's (N - T) budget, and passedCivics is false", () => {
      const civics = toCivics(interviewFor(version, seniorExemption));
      const budget = N - T;

      // Exactly the budget: still answerable, still in the civics phase.
      const atBudget = playCivics(civics, repeatAnswer(budget, false));
      expect(atBudget.phase).toBe('civics');
      expect(atBudget.stopReason).toBeNull();
      expect(atBudget.civicsAsked).toBe(budget);

      // One miss beyond it: the threshold can no longer be reached.
      const overBudget = applyAnswer(atBudget, { phase: 'civics', correct: false });
      expect(overBudget.stopReason).toBe('threshold_unreachable');
      expect(overBudget.civicsAsked).toBe(budget + 1);
      expect(overBudget.civicsCorrect).toBe(0);
      expect(passedCivics(overBudget)).toBe(false);
      expect(overBudget.phase).toBe('reading');
    });

    it('runs the full plan and passes when exactly T correct and (N - T) wrong arrive interleaved', () => {
      const civics = toCivics(interviewFor(version, seniorExemption));

      // Alternate correct/wrong while both remain, then the leftover correct
      // answers: T correct and N - T wrong in total, arranged so the interview
      // never spends more than its miss budget and reaches T only at the end.
      const wrong = N - T;
      const sequence: boolean[] = [];
      for (let i = 0; i < wrong; i += 1) sequence.push(true, false);
      while (sequence.filter((correct) => correct).length < T) sequence.push(true);

      const finished = playCivics(civics, sequence);

      expect(finished.stopReason).toBe('threshold_reached');
      expect(finished.civicsAsked).toBe(N);
      expect(finished.civicsCorrect).toBe(T);
      expect(passedCivics(finished)).toBe(true);
    });

    it("plans exactly the row's questionsAsked questions, drawn from the pool without repeats", () => {
      const state = interviewFor(version, seniorExemption);

      expect(state.civicsPlan).toHaveLength(N);
      expect(new Set(state.civicsPlan).size).toBe(N);
      for (const id of state.civicsPlan) {
        expect(POOL).toContain(id);
      }
    });
  },
);

// =============================================================================
// The same unreachable case, spelled out — the worked example of the above
// =============================================================================

describe('threshold_unreachable fires on the miss that spends the budget, not the one after', () => {
  it('fires on the FIFTH miss for a 10-asked / 6-to-pass row, and not on the fourth', () => {
    // 10 asked, 6 to pass leaves room for 4 misses. The fifth makes 6 correct
    // arithmetically impossible: 5 wrong + 5 remaining < 6.
    let state = toCivics(interviewFor(STANDARD_ROW, false));

    for (let miss = 1; miss <= 4; miss += 1) {
      state = applyAnswer(state, { phase: 'civics', correct: false });
      expect(state.stopReason).toBeNull();
      expect(state.phase).toBe('civics');
    }

    state = applyAnswer(state, { phase: 'civics', correct: false });

    expect(state.civicsAsked).toBe(5);
    expect(state.stopReason).toBe('threshold_unreachable');
    expect(passedCivics(state)).toBe(false);
  });
});

// =============================================================================
// Phase sequence
// =============================================================================

describe('phase sequence', () => {
  /** Drive an interview to completion, recording the prompt for every turn. */
  function walk(initial: InterviewState): {
    final: InterviewState;
    phases: InterviewPhase[];
    prompts: InterviewPrompt[];
    stateBeforeReading: InterviewState | null;
  } {
    const phases: InterviewPhase[] = [];
    const prompts: InterviewPrompt[] = [];
    let stateBeforeReading: InterviewState | null = null;
    let current = initial;
    let guard = 0;

    while (!current.completed && guard < 200) {
      if (phases[phases.length - 1] !== current.phase) phases.push(current.phase);
      if (current.phase === 'reading' && stateBeforeReading === null) stateBeforeReading = current;

      prompts.push(nextPrompt(current));
      current = applyAnswer(current, { phase: current.phase, correct: true });
      guard += 1;
    }

    return { final: current, phases, prompts, stateBeforeReading };
  }

  it('visits every phase in INTERVIEW_PHASES order and then completes', () => {
    const { final, phases } = walk(interviewFor(STANDARD_ROW, false));

    expect(phases).toEqual([...INTERVIEW_PHASES]);
    expect(final.completed).toBe(true);
    expect(nextPrompt(final)).toEqual({ kind: 'completed' });
  });

  it('opens with small talk, then the N-400 rehearsal prompts, one per turn', () => {
    const { prompts } = walk(interviewFor(STANDARD_ROW, false));

    const smalltalk = prompts.filter((prompt) => prompt.kind === 'smalltalk');
    const n400 = prompts.filter((prompt) => prompt.kind === 'n400');

    expect(smalltalk).toHaveLength(SMALLTALK_TURNS);
    expect(n400).toHaveLength(N400_TURNS);
    for (const prompt of n400) {
      expect(prompt).toHaveProperty('promptText');
    }
    // Each N-400 turn gets its own prompt rather than repeating one.
    expect(new Set(n400.map((prompt) => (prompt.kind === 'n400' ? prompt.promptText : ''))).size).toBe(
      N400_TURNS,
    );
  });

  it('numbers the civics prompts 1..plannedCount against the plan', () => {
    const { prompts } = walk(interviewFor(STANDARD_ROW, false));
    const civics = prompts.flatMap((prompt) => (prompt.kind === 'civics' ? [prompt] : []));

    const plan = interviewFor(STANDARD_ROW, false).civicsPlan;
    civics.forEach((prompt, index) => {
      expect(prompt.questionNumberInPlan).toBe(index + 1);
      expect(prompt.questionId).toBe(plan[index]);
      expect(prompt.plannedCount).toBe(plan.length);
    });
  });

  it('names reading and writing as skipped segments rather than omitting them', () => {
    const { prompts } = walk(interviewFor(STANDARD_ROW, false));
    const skipped = prompts.flatMap((prompt) =>
      prompt.kind === 'skipped_segment' ? [prompt.phase] : [],
    );

    expect(skipped).toEqual(['reading', 'writing']);
  });

  it('lets the skipped segments consume no answer that affects the outcome', () => {
    const { final, stateBeforeReading } = walk(interviewFor(STANDARD_ROW, false));

    expect(stateBeforeReading).not.toBeNull();
    const before = stateBeforeReading as InterviewState;

    // The walk answers `correct: true` on the reading and writing turns too —
    // and none of it moves a civics counter, a stop reason, or the verdict.
    expect(final.civicsAsked).toBe(before.civicsAsked);
    expect(final.civicsCorrect).toBe(before.civicsCorrect);
    expect(final.stopReason).toBe(before.stopReason);
    expect(passedCivics(final)).toBe(passedCivics(before));
  });

  it('advancePhase moves one phase along and resets the turn counter', () => {
    const state = interviewFor(STANDARD_ROW, false);
    expect(state.phase).toBe('smalltalk');

    const next = advancePhase(state);
    expect(next.phase).toBe('n400');
    expect(next.phaseTurnIndex).toBe(0);
    expect(state.phase).toBe('smalltalk'); // input untouched
  });

  it('rejects an answer whose phase disagrees with the interview', () => {
    const state = interviewFor(STANDARD_ROW, false);

    expect(() => applyAnswer(state, { phase: 'civics', correct: true })).toThrow(
      /does not match interview phase/,
    );
  });
});

// =============================================================================
// Determinism
// =============================================================================

describe('determinism', () => {
  it('derives an identical civicsPlan from the same seed and pool, every time', () => {
    const first = interviewFor(STANDARD_ROW, false).civicsPlan;

    for (let run = 0; run < 25; run += 1) {
      expect(interviewFor(STANDARD_ROW, false).civicsPlan).toEqual(first);
    }

    expect(planCivicsQuestions(POOL, SEED, selectPassRule(STANDARD_ROW, false))).toEqual([
      ...first,
    ]);
  });

  it('derives a different plan for a different interview id', () => {
    const passRule = selectPassRule(STANDARD_ROW, false);

    expect(planCivicsQuestions(POOL, 'interview-a', passRule)).not.toEqual(
      planCivicsQuestions(POOL, 'interview-b', passRule),
    );
  });

  it('never mutates the pool it was handed', () => {
    const pool = [...POOL];
    planCivicsQuestions(pool, SEED, selectPassRule(STANDARD_ROW, false));

    expect(pool).toEqual(POOL);
  });
});

// =============================================================================
// A pool smaller than N
// =============================================================================

describe('a pool smaller than the row questionsAsked', () => {
  it('plans the whole pool and never lowers the threshold to fit it', () => {
    const shortPool = POOL.slice(0, 3);
    const state = interviewFor(STANDARD_ROW, false, shortPool);

    expect(state.civicsPlan).toEqual(expect.arrayContaining([...shortPool]));
    expect(state.civicsPlan).toHaveLength(shortPool.length);
    // The rule is still the row's: 10 asked, 6 to pass, unchanged by the pool.
    expect(state.passRule).toEqual({ questionsAsked: 10, passThreshold: 6 });
  });

  it('ends with all_asked and a failed civics section when the pool cannot reach T', () => {
    const shortPool = POOL.slice(0, 3);
    const civics = toCivics(interviewFor(STANDARD_ROW, false, shortPool));

    const finished = playCivics(civics, repeatAnswer(shortPool.length, true));

    expect(finished.civicsAsked).toBe(shortPool.length);
    expect(finished.civicsCorrect).toBe(shortPool.length);
    expect(finished.stopReason).toBe('all_asked');
    expect(passedCivics(finished)).toBe(false);
    expect(finished.phase).toBe('reading');
  });

  it('still passes on a short pool that does reach T', () => {
    const shortPool = POOL.slice(0, 8); // fewer than N (10), more than T (6)
    const civics = toCivics(interviewFor(STANDARD_ROW, false, shortPool));

    const finished = playCivics(civics, repeatAnswer(shortPool.length, true));

    expect(finished.stopReason).toBe('threshold_reached');
    expect(finished.civicsCorrect).toBe(6);
    expect(passedCivics(finished)).toBe(true);
  });

  it('walks straight past an empty pool with all_asked rather than asking nothing forever', () => {
    const civics = toCivics(interviewFor(STANDARD_ROW, false, []));

    expect(civics.phase).not.toBe('civics');
    expect(civics.stopReason).toBe('all_asked');
    expect(passedCivics(civics)).toBe(false);
  });
});

// =============================================================================
// Purity
// =============================================================================

describe('purity', () => {
  it('applyAnswer never mutates the state it was given', () => {
    const state = toCivics(interviewFor(STANDARD_ROW, false));
    const snapshot = structuredClone(state);

    applyAnswer(state, { phase: 'civics', correct: true });
    applyAnswer(state, { phase: 'civics', correct: false });

    expect(state).toEqual(snapshot);
  });

  it('applyAnswer returns a new object, and a new plan array is never shared mutably', () => {
    const state = toCivics(interviewFor(STANDARD_ROW, false));
    const next = applyAnswer(state, { phase: 'civics', correct: true });

    expect(next).not.toBe(state);
    expect(next.civicsPlan).toEqual(state.civicsPlan);
  });

  it('startState and advancePhase leave their inputs alone', () => {
    const state = interviewFor(STANDARD_ROW, false);
    const snapshot = structuredClone(state);

    advancePhase(state);

    expect(state).toEqual(snapshot);
  });
});

// =============================================================================
// No threshold literal in this module's source
// =============================================================================

describe('the pass rule is never compiled into this module', () => {
  /** Remove block and line comments, so prose about 6-of-10 is not mistaken for code. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  const source = stripComments(
    readFileSync(join(__dirname, 'interview-engine.ts'), 'utf8'),
  );

  // WHAT THIS HOLDS, AND WHY THE OBVIOUS TEST DOES NOT HOLD IT
  // ----------------------------------------------------------
  // The property is *absence*: this module must contain no civics threshold or
  // question count at all — not as a value, not as a default, not as a
  // fallback for a missing row, not as a "sanity check" on a row that looks
  // wrong. N and T come from `civics_test_versions`, and different versions
  // carry different numbers.
  //
  // The obvious test — run two version rows and assert the outcomes differ —
  // is a BEHAVIOURAL test, and behaviour can only observe the paths a test
  // exercises. An implementation with `const DEFAULT_PASS_THRESHOLD = 6` used
  // when the rule looks unset, or a `Math.min(passThreshold, 6)` clamp, or a
  // hardcoded 10 in a resume path no table entry reaches, passes that test
  // every time. The table above is still worth having — it is what proves the
  // rule is READ correctly — but only source can prove the number is not
  // THERE. So this case reads the file off disk and looks.
  //
  // The digits chosen are the ones that would actually appear: 6 and 10 are
  // the standard row's T and N, 12 and 20 the wide row's. The second
  // assertion is the general form of the same property — after comments are
  // stripped, every bare integer left in this file must be a 0 or a 1, which
  // are array indices and increments and nothing else.

  it.each(['6', '10', '12', '20'])(
    'contains no occurrence of the digits %s outside comments',
    (forbidden) => {
      expect(source).not.toContain(forbidden);
    },
  );

  it('contains no bare integer literal other than 0 and 1', () => {
    const literals = source.match(/\b\d+\b/g) ?? [];

    for (const literal of literals) {
      expect(['0', '1']).toContain(literal);
    }
  });

  it('names the senior columns, so the branch is visible and is here rather than downstream', () => {
    // The rule reaches the engine through exactly one door: `passRule`, whose
    // only producer is `selectPassRule`. The senior column names appear in
    // this file — in that function and in the interface it reads — and
    // `seniorExemption` appears nowhere else, so nothing downstream branches
    // on the exemption a second time.
    expect(source).toContain('seniorQuestionsAsked');
    expect(source).toContain('seniorPassThreshold');
    expect(source.match(/seniorExemption/g) ?? []).toHaveLength(2);
  });
});
