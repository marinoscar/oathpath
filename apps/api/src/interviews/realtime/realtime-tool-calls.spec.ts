import {
  applyAnswer,
  startState,
  type InterviewPassRuleColumns,
  type InterviewPhase,
  type InterviewState,
} from '../engine';
import {
  decideEndPhase,
  decideGradeAnswer,
  decideNextQuestion,
  END_PHASE_DECLARES_NO_VERDICT,
  type OutstandingItem,
  type RealtimeTurnContext,
} from './realtime-tool-calls';

// =============================================================================
// realtime-tool-calls.ts — tests (issue #158, epic #60 / E11)
// =============================================================================
//
// The rules are pure, so every case here is a plain function call over plain
// objects, in the style of `interview-engine.spec.ts` next door — no database,
// no NestJS, no AI provider, and (the point of the whole design) no audio.
//
// **Almost nothing below is written against a number.** The stop-rule cases run
// as a table over two `civics_test_versions` rows, with one shared body that
// derives N and T from `selectPassRule` and never mentions a literal, so an
// implementation with a threshold baked into it could satisfy at most one entry.
// The source-reading case at the bottom is what proves the number is not
// THERE — the property behaviour cannot observe.
// =============================================================================

const SEED = '7c1b0f6e-0000-4000-8000-000000000042';

/** A pool comfortably larger than the widest row's N. */
const POOL = Array.from(
  { length: 40 },
  (_, index) => `q${String(index + 1).padStart(3, '0')}`,
);

/** Two rows with different numbers, so no single literal can satisfy both. */
const STANDARD: InterviewPassRuleColumns = {
  questionsAsked: 10,
  passThreshold: 6,
  seniorQuestionsAsked: 6,
  seniorPassThreshold: 4,
};

const WIDE: InterviewPassRuleColumns = {
  questionsAsked: 20,
  passThreshold: 12,
  seniorQuestionsAsked: 12,
  seniorPassThreshold: 8,
};

function stateFor(row: InterviewPassRuleColumns): InterviewState {
  return startState({
    seed: SEED,
    passRule: { questionsAsked: row.questionsAsked, passThreshold: row.passThreshold },
    questionPool: POOL,
  });
}

/** Walk the interview to the civics phase by answering the fixed-length ones. */
function atCivics(row: InterviewPassRuleColumns): InterviewState {
  let state = stateFor(row);
  while (state.phase !== 'civics') {
    state = applyAnswer(state, { phase: state.phase, correct: false });
  }
  return state;
}

function answerCivics(
  state: InterviewState,
  correct: boolean,
  times: number,
): InterviewState {
  let current = state;
  for (let i = 0; i < times; i += 1) {
    current = applyAnswer(current, { phase: 'civics', correct });
  }
  return current;
}

function ctx(
  state: InterviewState,
  overrides: Partial<RealtimeTurnContext> = {},
): RealtimeTurnContext {
  return {
    interviewStatus: 'in_progress',
    state,
    outstanding: null,
    ungradedTurnPending: false,
    ...overrides,
  };
}

const CIVICS_ITEM = (
  state: InterviewState,
): Extract<OutstandingItem, { kind: 'civics' }> => ({
  kind: 'civics',
  questionId: state.civicsPlan[state.civicsAsked],
});

// -----------------------------------------------------------------------------
// next_question
// -----------------------------------------------------------------------------

describe('next_question', () => {
  it('serves the engine’s own next prompt', () => {
    const state = atCivics(STANDARD);
    const decision = decideNextQuestion(ctx(state));

    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.prompt).toEqual({
      kind: 'civics',
      questionId: state.civicsPlan[0],
      questionNumberInPlan: 1,
      plannedCount: state.civicsPlan.length,
    });
  });

  it('is REFUSED while an answer is still outstanding', () => {
    const state = atCivics(STANDARD);

    const decision = decideNextQuestion(
      ctx(state, { outstanding: CIVICS_ITEM(state) }),
    );

    // §4.1's third rejection, and the one with a consequence: the engine's
    // `civicsAsked` tally is the stop rule's own input, so a second question
    // asked before the first is graded would count a question nobody answered.
    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') return;
    expect(decision.reason).toBe('answer_outstanding');
    expect(decision.instruction).toContain('grade_answer');
  });

  it.each(['completed', 'abandoned'])(
    'is refused for an interview that is %s',
    (status) => {
      const decision = decideNextQuestion(
        ctx(atCivics(STANDARD), { interviewStatus: status }),
      );

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') return;
      expect(decision.reason).toBe('interview_not_in_progress');
    },
  );

  it('is refused once the engine has run out of turns', () => {
    let state = answerCivics(atCivics(STANDARD), true, STANDARD.passThreshold);
    while (!state.completed) {
      state = applyAnswer(state, { phase: state.phase, correct: false });
    }

    const decision = decideNextQuestion(ctx(state));

    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') return;
    expect(decision.reason).toBe('interview_complete');
  });

  it('reports an ungraded reply that must be consumed first', () => {
    const decision = decideNextQuestion(
      ctx(stateFor(STANDARD), { ungradedTurnPending: true }),
    );

    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.consumeUngradedTurn).toBe(true);
  });

  it('refuses rather than throwing on a state the engine cannot serve', () => {
    // `nextPrompt`'s one documented throw — the civics phase with no question
    // left and the stop rule bypassed, which its own comment calls a
    // programming error. On a live spoken connection the honest handling is to
    // refuse this call, not to 500 into the middle of somebody's rehearsal.
    const broken: InterviewState = {
      ...atCivics(STANDARD),
      civicsPlan: [],
      stopReason: null,
    };

    const decision = decideNextQuestion(ctx(broken));

    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') return;
    expect(decision.reason).toBe('engine_refused');
  });
});

// -----------------------------------------------------------------------------
// grade_answer
// -----------------------------------------------------------------------------

describe('grade_answer', () => {
  it('accepts an answer to the outstanding question', () => {
    const state = atCivics(STANDARD);
    const item = CIVICS_ITEM(state);

    const decision = decideGradeAnswer(ctx(state, { outstanding: item }), {
      tool: 'grade_answer',
      questionId: item.questionId,
      transcript: 'the constitution',
      confidence: 0.94,
    });

    expect(decision).toEqual({ status: 'ok', item });
  });

  it('REJECTS a call naming a question the engine did not ask', () => {
    const state = atCivics(STANDARD);

    const decision = decideGradeAnswer(
      ctx(state, { outstanding: CIVICS_ITEM(state) }),
      {
        tool: 'grade_answer',
        // A real question, from the same plan, just not the one outstanding —
        // which is exactly what a duplicate or out-of-order call looks like.
        questionId: state.civicsPlan[3],
        transcript: 'anything',
      },
    );

    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') return;
    expect(decision.reason).toBe('wrong_item');
    // §4.2: the model is told to move on, never to retry the same call — the
    // engine's state has not moved, so a retry could only repeat the rejection.
    expect(decision.instruction).toContain('next_question');
  });

  it('rejects an answer when nothing is outstanding', () => {
    const decision = decideGradeAnswer(ctx(atCivics(STANDARD)), {
      tool: 'grade_answer',
      questionId: 'q001',
      transcript: 'anything',
    });

    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') return;
    expect(decision.reason).toBe('no_answer_outstanding');
  });

  it('compares the SENTENCE id in a conducted reading segment', () => {
    let state = answerCivics(atCivics(STANDARD), true, STANDARD.passThreshold);
    expect(state.phase).toBe('reading');

    const item: OutstandingItem = {
      kind: 'english',
      segment: 'reading',
      sentenceId: 'sentence-1',
    };

    expect(
      decideGradeAnswer(ctx(state, { outstanding: item }), {
        tool: 'grade_answer',
        questionId: 'sentence-1',
        transcript: 'who was the first president',
      }).status,
    ).toBe('ok');

    expect(
      decideGradeAnswer(ctx(state, { outstanding: item }), {
        tool: 'grade_answer',
        questionId: 'sentence-2',
        transcript: 'who was the first president',
      }).status,
    ).toBe('rejected');
  });
});

// -----------------------------------------------------------------------------
// end_phase — the rejection rule that matters most
// -----------------------------------------------------------------------------

describe('end_phase', () => {
  const ROWS: [string, InterviewPassRuleColumns][] = [
    ['the standard row', STANDARD],
    ['a wider row', WIDE],
  ];

  it.each(ROWS)(
    'refuses to end the civics phase one correct answer short, on %s',
    (_label, row) => {
      // ONE SHORT, derived from the row rather than written down. If the rule
      // were compiled in, at most one of these two entries could pass.
      const state = answerCivics(atCivics(row), true, row.passThreshold - 1);
      expect(state.phase).toBe('civics');

      const decision = decideEndPhase(ctx(state), {
        tool: 'end_phase',
        phase: 'civics',
      });

      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') return;
      expect(decision.reason).toBe('phase_not_over');
      expect(decision.error).toContain('civics');
    },
  );

  it.each(ROWS)('honours it the moment the threshold is reached, on %s', (_label, row) => {
    const state = answerCivics(atCivics(row), true, row.passThreshold);

    // The engine has already left the phase of its own accord — that IS the
    // stop rule agreeing, and it is what `end_phase` reports rather than
    // decides.
    expect(state.stopReason).toBe('threshold_reached');

    const decision = decideEndPhase(ctx(state), {
      tool: 'end_phase',
      phase: 'civics',
    });

    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.nextPhase).toBe('reading');
  });

  it.each(ROWS)('honours it when the threshold becomes unreachable, on %s', (_label, row) => {
    // The miss budget is N − T, again derived rather than written down.
    const misses = row.questionsAsked - row.passThreshold + 1;
    const state = answerCivics(atCivics(row), false, misses);

    expect(state.stopReason).toBe('threshold_unreachable');
    expect(
      decideEndPhase(ctx(state), { tool: 'end_phase', phase: 'civics' }).status,
    ).toBe('ok');
  });

  it.each<[InterviewPhase]>([['smalltalk'], ['n400']])(
    'refuses to end %s before its own turn count is reached',
    (phase) => {
      let state = stateFor(STANDARD);
      while (state.phase !== phase) {
        state = applyAnswer(state, { phase: state.phase, correct: false });
      }

      const decision = decideEndPhase(ctx(state), { tool: 'end_phase', phase });

      // `PHASE_TURNS[phase]` is a fact the engine owns, and this asks the
      // engine — "have you left the phase" — rather than recomputing it.
      expect(decision.status).toBe('rejected');
      if (decision.status !== 'rejected') return;
      expect(decision.reason).toBe('phase_not_over');
    },
  );

  it('refuses to end a phase the interview has not reached yet', () => {
    const decision = decideEndPhase(ctx(stateFor(STANDARD)), {
      tool: 'end_phase',
      phase: 'writing',
    });

    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') return;
    expect(decision.reason).toBe('phase_not_over');
  });

  it('honours any phase once the interview is over', () => {
    let state = answerCivics(atCivics(STANDARD), true, STANDARD.passThreshold);
    while (!state.completed) {
      state = applyAnswer(state, { phase: state.phase, correct: false });
    }

    const decision = decideEndPhase(ctx(state), {
      tool: 'end_phase',
      phase: 'civics',
    });

    expect(decision.status).toBe('ok');
    if (decision.status !== 'ok') return;
    expect(decision.completed).toBe(true);
  });

  it('returns no verdict of any kind', () => {
    const state = answerCivics(atCivics(STANDARD), true, STANDARD.passThreshold);
    const decision = decideEndPhase(ctx(state), {
      tool: 'end_phase',
      phase: 'civics',
    });

    // The compile-time proof is the real guarantee; this is the runtime echo of
    // it, so a `JSON.stringify` of what reaches the model carries no score.
    expect(END_PHASE_DECLARES_NO_VERDICT).toBe(true);
    expect(Object.keys(decision).sort()).toEqual([
      'completed',
      'nextPhase',
      'status',
    ]);
  });
});

// =============================================================================
// No threshold literal in this module's source
// =============================================================================

describe('the pass rule is never compiled into this module', () => {
  /** Remove block and line comments, so prose about 6-of-10 is not code. */
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

  // WHAT THIS HOLDS, AND WHY THE TABLE ABOVE DOES NOT HOLD IT
  // --------------------------------------------------------
  // `realtime-interview.md` §4.3: "Pass rules come from `civics_test_versions`
  // via `selectPassRule` — no threshold constant anywhere in the realtime path
  // either." The table above proves the rule is READ correctly; only source can
  // prove the number is not THERE. An implementation with a
  // `Math.min(passThreshold, 6)` clamp, or a hardcoded 10 on a branch no
  // fixture reaches, passes every behavioural case every time.
  //
  // This is the same assertion `interview-engine.spec.ts` makes about the
  // engine, restated here because a second file on the same path is a second
  // place the number could appear — and §13's rejected "lowering the pass
  // threshold for a spoken interview" row is what it would look like when it
  // did.

  it.each(['6', '10', '12', '20'])(
    'contains no occurrence of the digits %s outside comments',
    (forbidden) => {
      expect(source).not.toContain(forbidden);
    },
  );

  it('contains no bare integer literal at all', () => {
    expect(source.match(/\b\d+\b/g) ?? []).toEqual([]);
  });

  it('reaches the stop rule through the engine, not through a copy of it', () => {
    // The one function that decides whether the civics phase is over, named
    // here and imported from `interview-engine.ts`. A local re-derivation would
    // be a second opinion about the most consequential claim this product
    // makes.
    expect(source).toContain('civicsStopReason');
    expect(source).toContain("from '../engine'");
  });
});
