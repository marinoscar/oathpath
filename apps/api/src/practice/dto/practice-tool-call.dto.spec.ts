import {
  narrowPracticeToolCall,
  practiceToolCallSchema,
} from './practice-tool-call.dto';
import { MAX_RESPONSE_LENGTH } from '../answer-matching';
import { PRACTICE_REALTIME_TOOL_NAMES } from '../realtime/practice-realtime-tools';

// =============================================================================
// The tool-call wire shape (issue #354, epic #345 / E15)
// =============================================================================
//
// Two properties are worth a test here and the rest follow from zod.
//
//   1. THE SET OF BODIES THIS ROUTE ACCEPTS IS EXACTLY THE FIVE TOOLS' DECLARED
//      ARGUMENTS. Not a superset — a `verdict` is refused, a `transcript`
//      posted with `skip_question` is refused, an argument belonging to another
//      tool is refused. The provider's own `additionalProperties: false` holds
//      this one layer up for the MODEL; this holds it for the BROWSER, which is
//      a program a person can modify.
//   2. `narrowPracticeToolCall` PRODUCES WHAT THE RULES TAKE, for all five, and
//      loses nothing on the way.
// =============================================================================

const QUESTION = '11111111-1111-4111-8111-111111111111';

/** Parse, returning zod's own result rather than throwing. */
function parse(body: unknown) {
  return practiceToolCallSchema.safeParse(body);
}

describe('practiceToolCallSchema — the five valid shapes', () => {
  const valid: Record<string, unknown>[] = [
    { tool: 'next_question' },
    { tool: 'grade_answer', questionId: QUESTION, transcript: 'the constitution' },
    { tool: 'repeat_question' },
    { tool: 'skip_question', questionId: QUESTION },
    { tool: 'end_session', reason: 'learner_asked' },
    { tool: 'end_session', reason: 'no_questions_left' },
  ];

  for (const body of valid) {
    it(`accepts ${JSON.stringify(body)}`, () => {
      expect(parse(body).success).toBe(true);
    });
  }

  it('covers every tool the session was minted with', () => {
    // A cheap guard against a sixth tool arriving in the contract with no way
    // for the browser to relay it — the mirror of the sequences spec's own
    // "no tool is contract-only" check, on the wire instead of in the rules.
    const named = new Set(valid.map((body) => body.tool));

    expect([...named].sort()).toEqual([...PRACTICE_REALTIME_TOOL_NAMES].sort());
  });
});

describe('practiceToolCallSchema — what it refuses', () => {
  it('refuses a sixth tool', () => {
    expect(parse({ tool: 'reveal_answer', questionId: QUESTION }).success).toBe(
      false,
    );
  });

  it('refuses a verdict, however it is spelled', () => {
    // THE ONE THIS FILE EXISTS FOR. `strictObject` is what makes "no verdict
    // field" a statement about what can ARRIVE rather than about what is
    // documented — without it a model that volunteers one lands it in an
    // unvalidated bag a later handler could start reading.
    for (const field of [
      'verdict',
      'correct',
      'outcome',
      'score',
      'confidence',
      'failureCause',
    ]) {
      const result = parse({
        tool: 'grade_answer',
        questionId: QUESTION,
        transcript: 'something',
        [field]: true,
      });

      expect(result.success).toBe(false);
    }
  });

  it('refuses an identity, so the caller can never name a learner', () => {
    for (const field of ['userId', 'sessionId', 'learnerId']) {
      expect(
        parse({ tool: 'next_question', [field]: 'someone-else' }).success,
      ).toBe(false);
    }
  });

  it('refuses an argument belonging to a different tool', () => {
    // A `transcript` on a skip is the exact shape a mis-heard silence would
    // take if a client tried to launder it into a graded answer; a `reason` on
    // a grade is a model reaching for the tool that ends sessions.
    expect(
      parse({ tool: 'skip_question', questionId: QUESTION, transcript: 'x' })
        .success,
    ).toBe(false);
    expect(
      parse({
        tool: 'grade_answer',
        questionId: QUESTION,
        transcript: 'x',
        reason: 'learner_asked',
      }).success,
    ).toBe(false);
    expect(parse({ tool: 'next_question', questionId: QUESTION }).success).toBe(
      false,
    );
  });

  it('refuses a call missing its tool’s required arguments', () => {
    expect(parse({ tool: 'grade_answer', questionId: QUESTION }).success).toBe(
      false,
    );
    expect(parse({ tool: 'grade_answer', transcript: 'x' }).success).toBe(false);
    expect(parse({ tool: 'skip_question' }).success).toBe(false);
    expect(parse({ tool: 'end_session' }).success).toBe(false);
  });

  it('refuses an end reason that is not one of the two observations', () => {
    // `END_SESSION_REASONS` is imported from the constant the session was
    // minted with, so a judgement-shaped reason (`learner_struggling`,
    // `enough_for_today`) has nowhere to arrive.
    expect(
      parse({ tool: 'end_session', reason: 'learner_struggling' }).success,
    ).toBe(false);
  });

  it('refuses a questionId that is not a uuid', () => {
    expect(
      parse({ tool: 'skip_question', questionId: 'question-one' }).success,
    ).toBe(false);
  });

  it('bounds the transcript at the same length responseText is bounded at', () => {
    // The same 2000 characters, because this string BECOMES `response_text`. A
    // looser bound here would let one transport store what the other refuses.
    expect(
      parse({
        tool: 'grade_answer',
        questionId: QUESTION,
        transcript: 'a'.repeat(MAX_RESPONSE_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      parse({
        tool: 'grade_answer',
        questionId: QUESTION,
        transcript: 'a'.repeat(MAX_RESPONSE_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('accepts a blank transcript, leaving the refusal to the engine', () => {
    // DELIBERATE, and the reason is the relay: a 400 is flattened into generic
    // failure handling and `instruction` — "ask the learner to say it again" —
    // would never reach the model. The engine answers it as a 200 rejection
    // with `empty_transcript` instead.
    expect(
      parse({ tool: 'grade_answer', questionId: QUESTION, transcript: '' })
        .success,
    ).toBe(true);
  });
});

describe('narrowPracticeToolCall', () => {
  it('produces the discriminated shape the rules take, for all five', () => {
    const narrowed = [
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: QUESTION, transcript: 'a b c' },
      { tool: 'repeat_question' },
      { tool: 'skip_question', questionId: QUESTION },
      { tool: 'end_session', reason: 'learner_asked' },
    ].map((body) => narrowPracticeToolCall(parse(body).data as never));

    expect(narrowed).toEqual([
      { tool: 'next_question' },
      { tool: 'grade_answer', questionId: QUESTION, transcript: 'a b c' },
      { tool: 'repeat_question' },
      { tool: 'skip_question', questionId: QUESTION },
      { tool: 'end_session', reason: 'learner_asked' },
    ]);
  });

  it('carries the transcript through byte for byte', () => {
    // NOT TRIMMED, NOT NORMALISED, NOT CORRECTED. It is the learner's own
    // words and it becomes `response_text` and `transcript` on the row;
    // anything this layer did to it would be a change nobody could see later.
    const transcript = '  the  Constitution ';
    const narrowed = narrowPracticeToolCall(
      parse({ tool: 'grade_answer', questionId: QUESTION, transcript })
        .data as never,
    );

    expect(narrowed).toEqual({
      tool: 'grade_answer',
      questionId: QUESTION,
      transcript,
    });
  });
});
