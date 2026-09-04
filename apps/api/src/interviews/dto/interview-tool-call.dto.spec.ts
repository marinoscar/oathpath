import {
  interviewToolCallSchema,
  narrowToolCall,
  TOOL_CALL_NAMES_NO_IDENTITY_OR_VERDICT,
  TOOL_NAMES_MATCH_RULES,
  type InterviewToolCallInput,
} from './interview-tool-call.dto';

// =============================================================================
// interview-tool-call.dto.ts — tests (issue #158, epic #60 / E11)
// =============================================================================
//
// The edge. `realtime-tools.ts`' JSON Schema is what stops the MODEL expressing
// something; this is what stops anything else being posted to the route — and
// the browser that relays these calls is a program a person can modify, so the
// two layers are not redundant.
// =============================================================================

function parse(body: unknown) {
  return interviewToolCallSchema.safeParse(body);
}

const OUTSTANDING = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('the request edge', () => {
  it('accepts each tool with exactly its own arguments', () => {
    expect(parse({ tool: 'next_question' }).success).toBe(true);
    expect(
      parse({ tool: 'grade_answer', questionId: OUTSTANDING, transcript: 'the constitution' })
        .success,
    ).toBe(true);
    expect(
      parse({
        tool: 'grade_answer',
        questionId: OUTSTANDING,
        transcript: 'the constitution',
        confidence: 0.94,
      }).success,
    ).toBe(true);
    expect(parse({ tool: 'end_phase', phase: 'civics' }).success).toBe(true);
  });

  it('REJECTS a verdict in any of the shapes a model might reach for', () => {
    // The load-bearing case, and the reason it is a `strictObject`: without it,
    // "no `verdict` field" is a statement about what is documented rather than
    // about what can arrive, and a volunteered grade would sit in an
    // unvalidated bag a later handler could start reading.
    for (const smuggled of [
      { verdict: 'correct' },
      { outcome: 'correct' },
      { correct: true },
      { score: 1 },
      { isCorrect: true },
      { assessment: 'right' },
    ]) {
      expect(
        parse({
          tool: 'grade_answer',
          questionId: OUTSTANDING,
          transcript: 'the constitution',
          ...smuggled,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects an identity field of any kind', () => {
    for (const identity of [
      { userId: OUTSTANDING },
      { learnerId: OUTSTANDING },
      { email: 'someone@example.com' },
      { interviewId: OUTSTANDING },
    ]) {
      expect(parse({ tool: 'next_question', ...identity }).success).toBe(false);
    }
  });

  it('rejects a pass rule the caller tried to supply', () => {
    // §4.3's rule, held at the edge as well as in the decision: the pass mark
    // is a `civics_test_versions` row, and there is no request that can carry
    // one.
    expect(
      parse({ tool: 'end_phase', phase: 'civics', passThreshold: 1 }).success,
    ).toBe(false);
    expect(
      parse({ tool: 'end_phase', phase: 'civics', testVersionCode: 'v2008' })
        .success,
    ).toBe(false);
  });

  it('rejects an argument belonging to a DIFFERENT tool', () => {
    // Stricter than a discriminated union would be, and deliberately: a union
    // says nothing about a field from another variant arriving on this one.
    expect(
      parse({ tool: 'next_question', questionId: OUTSTANDING }).success,
    ).toBe(false);
    expect(parse({ tool: 'end_phase', phase: 'civics', confidence: 0.9 }).success).toBe(
      false,
    );
    expect(
      parse({
        tool: 'grade_answer',
        questionId: OUTSTANDING,
        transcript: 'x',
        phase: 'civics',
      }).success,
    ).toBe(false);
  });

  it('requires each tool’s own arguments', () => {
    expect(parse({ tool: 'grade_answer', transcript: 'x' }).success).toBe(false);
    expect(parse({ tool: 'grade_answer', questionId: OUTSTANDING }).success).toBe(
      false,
    );
    expect(parse({ tool: 'end_phase' }).success).toBe(false);
  });

  it('accepts an EMPTY transcript', () => {
    // An applicant who says nothing has still taken their turn. Rejecting it
    // would make "I don't know" the one thing a rehearsal of a high-stakes
    // conversation refuses to let a nervous person say.
    expect(
      parse({ tool: 'grade_answer', questionId: OUTSTANDING, transcript: '' }).success,
    ).toBe(true);
  });

  it('rejects a confidence outside 0–1, and treats absence as absence', () => {
    const base = { tool: 'grade_answer', questionId: OUTSTANDING, transcript: 'x' };
    expect(parse({ ...base, confidence: 1.1 }).success).toBe(false);
    expect(parse({ ...base, confidence: -0.1 }).success).toBe(false);

    const parsed = parse(base);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // NOT defaulted to zero. Unknown is not low, and a default would make every
    // answer on a provider that reports no confidence read as misheard.
    expect(parsed.data.confidence).toBeUndefined();
  });

  it('refuses `closing` on end_phase — ending the interview is the engine’s', () => {
    expect(parse({ tool: 'end_phase', phase: 'closing' }).success).toBe(false);
  });

  it('refuses an unknown tool name', () => {
    expect(parse({ tool: 'grade_it_yourself' }).success).toBe(false);
  });
});

describe('narrowToolCall', () => {
  it('produces the discriminated shape the engine’s rules take', () => {
    const parsed = parse({
      tool: 'grade_answer',
      questionId: OUTSTANDING,
      transcript: 'the constitution',
      confidence: 0.94,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(narrowToolCall(parsed.data as InterviewToolCallInput)).toEqual({
      tool: 'grade_answer',
      questionId: OUTSTANDING,
      transcript: 'the constitution',
      confidence: 0.94,
    });
  });

  it('drops every field the named tool does not own', () => {
    const parsed = parse({ tool: 'next_question' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(narrowToolCall(parsed.data as InterviewToolCallInput)).toEqual({
      tool: 'next_question',
    });
  });
});

describe('the compile-time proofs', () => {
  it('are present, so removing one is a build break rather than a quiet loss', () => {
    // These constants exist only so the TYPES they are annotated with have to
    // resolve. Asserting on them is what stops the whole block being deleted as
    // apparently-unused code.
    expect(TOOL_CALL_NAMES_NO_IDENTITY_OR_VERDICT).toBe(true);
    expect(TOOL_NAMES_MATCH_RULES).toBe(true);
  });
});
