import {
  alreadyAnsweredRejection,
  decideEndSession,
  decideGradeAnswer,
  decideNextQuestion,
  decideRepeatQuestion,
  decideSkipQuestion,
  emptyTranscriptRejection,
  noQuestionToServe,
  PRACTICE_REALTIME_REJECTION_REASONS,
  type PracticeRealtimeTurnContext,
} from './practice-realtime-tool-calls';

// =============================================================================
// The realtime practice rules — tests (issue #353, epic #345 / E15)
// =============================================================================
//
// The rules are pure functions over a three-field context, so every case below
// is a value in and a value out: no database, no provider, no Nest.
//
// What is asserted is the set of refusals, because the refusals ARE the
// contract. An honoured call does very little here (it says "yes, and here is
// which question"); a refused one is the mechanism that stops a model from
// walking a session it mis-heard, recording an answer against a question the
// learner never got, or ending a session that still has questions in it.
//
// `practice-realtime-sequences.spec.ts` drives the same functions as scripted
// CONVERSATIONS; this file covers one decision at a time.
// =============================================================================

const QUESTION = 'q-11111111-1111-4111-8111-111111111111';
const OTHER_QUESTION = 'q-22222222-2222-4222-8222-222222222222';

function ctx(
  overrides: Partial<PracticeRealtimeTurnContext> = {},
): PracticeRealtimeTurnContext {
  return {
    sessionStatus: 'in_progress',
    outstandingQuestionId: null,
    questionsRemaining: 5,
    ...overrides,
  };
}

/** Every refusal carries all three fields, whatever refused it. */
function expectWellFormedRefusal(decision: any, reason: string, tool: string) {
  expect(decision.status).toBe('rejected');
  expect(decision.reason).toBe(reason);
  expect(decision.tool).toBe(tool);
  // `error` says what was wrong; `instruction` says what to do INSTEAD.
  // Telling a model only that its call failed invites it to retry the same
  // call against a state that has not moved.
  expect(decision.error.length).toBeGreaterThan(0);
  expect(decision.instruction.length).toBeGreaterThan(0);
}

describe('decideNextQuestion', () => {
  it('serves the next question when nothing is outstanding', () => {
    expect(decideNextQuestion(ctx())).toEqual({ status: 'ok' });
  });

  it('refuses while an answer is outstanding', () => {
    // THE RULE THAT KEEPS ONE QUESTION IN THE AIR AT A TIME. Without it a
    // model that mis-heard a pause as an answer could walk the whole session
    // in one breath, and the learner's rows would be a sequence of questions
    // they never got to answer.
    const decision = decideNextQuestion(
      ctx({ outstandingQuestionId: QUESTION }),
    );

    expectWellFormedRefusal(decision, 'answer_outstanding', 'next_question');
    expect((decision as any).instruction).toMatch(/grade_answer/);
  });

  it('refuses when the session has asked everything it planned', () => {
    const decision = decideNextQuestion(ctx({ questionsRemaining: 0 }));

    expectWellFormedRefusal(decision, 'no_questions_left', 'next_question');
    expect((decision as any).instruction).toMatch(/end_session/);
  });

  it.each(['completed', 'abandoned'])('refuses on a %s session', (status) => {
    expectWellFormedRefusal(
      decideNextQuestion(ctx({ sessionStatus: status })),
      'session_not_in_progress',
      'next_question',
    );
  });
});

describe('decideGradeAnswer', () => {
  it('accepts an answer to the outstanding question', () => {
    expect(
      decideGradeAnswer(ctx({ outstandingQuestionId: QUESTION }), {
        questionId: QUESTION,
      }),
    ).toEqual({ status: 'ok', questionId: QUESTION, then: 'ask_next_question' });
  });

  it('says the session is complete when this was the last question', () => {
    expect(
      decideGradeAnswer(
        ctx({ outstandingQuestionId: QUESTION, questionsRemaining: 1 }),
        { questionId: QUESTION },
      ),
    ).toEqual({ status: 'ok', questionId: QUESTION, then: 'session_complete' });
  });

  it('refuses an answer naming a different question than the outstanding one', () => {
    // COMPARED, NEVER ASSUMED. A mis-attribution on this path is not a
    // confusing sentence — it is a `practice_attempts` row and a
    // `question_mastery` update about a question the learner was never asked.
    const decision = decideGradeAnswer(
      ctx({ outstandingQuestionId: QUESTION }),
      { questionId: OTHER_QUESTION },
    );

    expectWellFormedRefusal(decision, 'wrong_question', 'grade_answer');
    expect((decision as any).instruction).toMatch(/repeat_question/);

    // AND IT NAMES THE OUTSTANDING QUESTION (#403). The opening turn is served
    // by the browser, so the first question of a session never reaches the
    // model as a tool result — "use the id the last tool result gave you" has
    // no referent there, and the only recovery left was reading the whole
    // question out loud again. Naming it makes the recovery silent.
    expect((decision as any).instruction).toContain(QUESTION);
    expect((decision as any).instruction).not.toContain(OTHER_QUESTION);
  });

  it('refuses an answer when nothing is outstanding', () => {
    expectWellFormedRefusal(
      decideGradeAnswer(ctx(), { questionId: QUESTION }),
      'no_answer_outstanding',
      'grade_answer',
    );
  });

  it.each(['completed', 'abandoned'])('refuses on a %s session', (status) => {
    expectWellFormedRefusal(
      decideGradeAnswer(
        ctx({ sessionStatus: status, outstandingQuestionId: QUESTION }),
        { questionId: QUESTION },
      ),
      'session_not_in_progress',
      'grade_answer',
    );
  });

  it('reads nothing about the answer itself', () => {
    // THE PROPERTY THIS WHOLE CONTRACT EXISTS FOR, asserted at the rules
    // layer: the decision is a function of the context and the question id
    // alone, so no transcript — and nothing a model could put in one — can
    // change what happens next. Whether the answer was right is
    // `AttemptGradingService`'s decision, made after this one.
    const context = ctx({ outstandingQuestionId: QUESTION });

    expect(
      decideGradeAnswer(context, {
        questionId: QUESTION,
        // Deliberately shaped like a model volunteering a verdict. The
        // provider's `additionalProperties: false` refuses it a layer up; here
        // the point is that it changes nothing even if it arrived.
        ...({ verdict: 'correct', confidence: 1 } as any),
      } as any),
    ).toEqual(decideGradeAnswer(context, { questionId: QUESTION }));
  });
});

describe('decideSkipQuestion', () => {
  it('accepts a skip of the outstanding question', () => {
    expect(
      decideSkipQuestion(ctx({ outstandingQuestionId: QUESTION }), {
        questionId: QUESTION,
      }),
    ).toEqual({ status: 'ok', questionId: QUESTION, then: 'ask_next_question' });
  });

  it('is refused by exactly the same rules an answer is', () => {
    // A skip IS an answer as far as the evidence table is concerned:
    // `outcome: 'skipped'` is a row, and it schedules. So the admissibility
    // rules are shared rather than re-derived, and this asserts the sharing.
    for (const context of [
      ctx({ sessionStatus: 'completed', outstandingQuestionId: QUESTION }),
      ctx(),
      ctx({ outstandingQuestionId: QUESTION }),
    ]) {
      expect(decideSkipQuestion(context, { questionId: OTHER_QUESTION })).toEqual(
        {
          ...(decideGradeAnswer(context, { questionId: OTHER_QUESTION }) as any),
          tool: 'skip_question',
        },
      );
    }
  });
});

describe('decideRepeatQuestion', () => {
  it('repeats the outstanding question', () => {
    expect(
      decideRepeatQuestion(ctx({ outstandingQuestionId: QUESTION })),
    ).toEqual({ status: 'ok' });
  });

  it('is allowed however many times it is asked', () => {
    // WRITES NOTHING AND COSTS NOTHING. It is the re-sync path for a session
    // re-minted after a dropped connection — a model with no context at all —
    // so rationing it would leave that model's only options as inventing the
    // question or calling `next_question`, which abandons an outstanding one.
    const context = ctx({ outstandingQuestionId: QUESTION });

    for (let call = 0; call < 5; call += 1) {
      expect(decideRepeatQuestion(context)).toEqual({ status: 'ok' });
    }
  });

  it('refuses when nothing is outstanding', () => {
    expectWellFormedRefusal(
      decideRepeatQuestion(ctx()),
      'no_answer_outstanding',
      'repeat_question',
    );
  });

  it.each(['completed', 'abandoned'])('refuses on a %s session', (status) => {
    expectWellFormedRefusal(
      decideRepeatQuestion(
        ctx({ sessionStatus: status, outstandingQuestionId: QUESTION }),
      ),
      'session_not_in_progress',
      'repeat_question',
    );
  });
});

describe('decideEndSession', () => {
  it('believes the learner asking to stop, whatever is left', () => {
    // A report of something that happened in the room, which the model is the
    // only witness to. Refusing it would be the product overruling a learner
    // about their own time.
    expect(
      decideEndSession(ctx({ questionsRemaining: 4 }), { reason: 'learner_asked' }),
    ).toEqual({ status: 'ok', reason: 'learner_asked' });
  });

  it('verifies "no questions left" and refuses it when questions remain', () => {
    // A claim about the application's own state, which the application can
    // check. Believed, it would let a model cut a session short and have the
    // summary screen agree with it.
    const decision = decideEndSession(ctx({ questionsRemaining: 2 }), {
      reason: 'no_questions_left',
    });

    expectWellFormedRefusal(decision, 'questions_remain', 'end_session');
    expect((decision as any).instruction).toMatch(/next_question/);
    // And the model is told not to narrate the refusal to the learner.
    expect((decision as any).instruction).toMatch(/not tell the learner/i);
  });

  it('honours "no questions left" when there really are none', () => {
    expect(
      decideEndSession(ctx({ questionsRemaining: 0 }), {
        reason: 'no_questions_left',
      }),
    ).toEqual({ status: 'ok', reason: 'no_questions_left' });
  });

  it.each(['completed', 'abandoned'])('refuses on a %s session', (status) => {
    expectWellFormedRefusal(
      decideEndSession(ctx({ sessionStatus: status }), {
        reason: 'learner_asked',
      }),
      'session_not_in_progress',
      'end_session',
    );
  });
});

// -----------------------------------------------------------------------------
// The rules module's own source
// -----------------------------------------------------------------------------

describe('the rules module itself', () => {
  function strippedSource(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:fs').readFileSync(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:path').join(__dirname, 'practice-realtime-tool-calls.ts'),
      'utf8',
    ) as string)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  it('grades nothing and writes nothing', () => {
    // THE SCAR THIS EPIC MUST NOT REPEAT, asserted rather than promised.
    // `InterviewsService.gradeCivicsAnswer` is a second assembly of the same
    // facts a practice attempt already assembles, and every rule that must
    // hold on both surfaces is now something two files have to agree about. A
    // third assembly would start exactly here — a rules module that "just"
    // resolved an answer to decide what to say next.
    const source = strippedSource();

    for (const forbidden of [
      'prisma',
      'PrismaService',
      'recordAttempt',
      'gradeDeterministic',
      'escalateToGrader',
      'AttemptGradingService',
      'questionMastery',
      'nextSchedule',
      'Injectable',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('reads no clock', () => {
    // `CLAUDE.md`'s clock rule, and the reason these functions are scriptable
    // at all: a decision that depended on "now" could not be replayed.
    expect(strippedSource()).not.toContain('new Date(');
    expect(strippedSource()).not.toContain('Clock');
  });
});

// =============================================================================
// The three refusals the rules cannot decide (issue #354)
// =============================================================================
//
// Every other rejection in this file comes out of a rule over the context
// struct. These three come from somewhere the context cannot see — a
// `ConflictException` raised inside `recordAttempt`'s transaction, a blank
// string on a call the schema had no way to refuse, and a state the derivation
// says is impossible — so they are exported builders the handler calls, tested
// here as the refusals they produce rather than as rules.

describe('the builders the handler reaches for', () => {
  it('already_answered is a well-formed refusal for either writing tool', () => {
    for (const tool of ['grade_answer', 'skip_question'] as const) {
      expectWellFormedRefusal(alreadyAnsweredRejection(tool), 'already_answered', tool);
    }
  });

  it('already_answered tells the model to carry on, never to retry', () => {
    // THE DISTINCTION THAT MATTERS. The state HAS moved — the row exists — so
    // a retry of the same call could only produce this same refusal again. An
    // instruction that said "try again" would turn a duplicate tool call into
    // a loop on a per-minute-billing connection.
    const rejection = alreadyAnsweredRejection('grade_answer');

    expect(rejection.instruction).toContain('next_question');
    expect(rejection.instruction.toLowerCase()).not.toContain('try again');
  });

  it('empty_transcript refuses rather than skipping on the learner’s behalf', () => {
    const rejection = emptyTranscriptRejection();

    expectWellFormedRefusal(rejection, 'empty_transcript', 'grade_answer');
    // A silence the model could not fill is not the learner DECIDING to move
    // on, so the instruction offers the honest move (ask again) and warns off
    // the dishonest one rather than taking either.
    expect(rejection.instruction).toContain('say their answer again');
    expect(rejection.instruction).toContain('unless they have');
  });

  it('noQuestionToServe points at end_session, whichever tool asked', () => {
    for (const tool of ['next_question', 'repeat_question'] as const) {
      const rejection = noQuestionToServe(tool);
      expectWellFormedRefusal(rejection, 'no_questions_left', tool);
      expect(rejection.instruction).toContain('end_session');
    }
  });
});

describe('the closed set of rejection reasons', () => {
  it('is exactly the set the rules and the builders can produce', () => {
    // ENUMERATED SO IT CAN BE ITERATED. A union type alone cannot keep this
    // promise: a reason declared and never produced compiles perfectly, and a
    // reason produced but undeclared is a compile error somewhere far from
    // here. This walks the array and collects everything this module can
    // actually emit.
    const produced = new Set<string>();

    const record = (decision: { status: string; reason?: string }) => {
      if (decision.status === 'rejected' && decision.reason) {
        produced.add(decision.reason);
      }
    };

    const closed = ctx({ sessionStatus: 'completed' });
    const outstanding = ctx({ outstandingQuestionId: QUESTION });

    // session_not_in_progress — every tool, from a closed session.
    record(decideNextQuestion(closed));
    // answer_outstanding — a second question before the first is answered.
    record(decideNextQuestion(outstanding));
    // no_questions_left — the count ran out.
    record(decideNextQuestion(ctx({ questionsRemaining: 0 })));
    // no_answer_outstanding — an answer with nothing in the air.
    record(decideGradeAnswer(ctx(), { questionId: QUESTION }));
    // wrong_question — an answer naming something else.
    record(decideGradeAnswer(outstanding, { questionId: OTHER_QUESTION }));
    // questions_remain — the model declaring a session over that is not.
    record(decideEndSession(ctx(), { reason: 'no_questions_left' }));
    // The two the rules cannot decide.
    record(alreadyAnsweredRejection('grade_answer'));
    record(emptyTranscriptRejection());

    expect([...produced].sort()).toEqual(
      [...PRACTICE_REALTIME_REJECTION_REASONS].sort(),
    );
  });

  it('every reason is distinct, so a model can branch on it', () => {
    expect(new Set(PRACTICE_REALTIME_REJECTION_REASONS).size).toBe(
      PRACTICE_REALTIME_REJECTION_REASONS.length,
    );
  });
});
