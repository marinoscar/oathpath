import {
  RECORD_ATTEMPT_NAMES_NO_VERDICT,
  recordAttemptSchema,
} from './record-attempt.dto';

// =============================================================================
// POST /api/practice/sessions/:id/attempts body — voice fields (issue #104, E9)
// =============================================================================
//
// The five voice fields are client-reported, so this schema is the whole of
// the 400 surface protecting the evidence table from a body whose fields make
// two incompatible claims about the same event. Each rejection is asserted
// here directly; `test/practice.integration.spec.ts` then proves the same
// rejection reaches the wire as a 400 through the global Zod pipe.
// =============================================================================

const QUESTION_ID = 'a1111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = 'b1111111-1111-4111-8111-111111111111';

const parse = (body: Record<string, unknown>) =>
  recordAttemptSchema.safeParse({ questionId: QUESTION_ID, ...body });

/** The `path` of every issue a failed parse produced. */
function issuePaths(result: ReturnType<typeof parse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('recordAttemptSchema — voice fields', () => {
  describe('defaults', () => {
    it('defaults to the pre-E9 shape, so an existing client keeps meaning what it meant', () => {
      // The load-bearing property of the two defaults: a body written before
      // voice existed still parses, and still describes a typed answer to a
      // question read on screen. Requiring either field would have made a new
      // capability a breaking change to the one route the practice loop runs
      // through.
      const result = parse({ responseText: 'Congress' });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ inputMode: 'typed', promptMode: 'read' });
    });

    it('leaves transcript, asrConfidence and retryOfAttemptId absent rather than defaulting them', () => {
      // ABSENT, not null-and-not-zero. `asrConfidence` especially: a default
      // of 0 would be a claim that the recogniser was certain it heard
      // nothing, which is below the threshold and would route a perfectly
      // good answer to `misheard`.
      const result = parse({ responseText: 'Congress' });

      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty('transcript');
      expect(result.data).not.toHaveProperty('asrConfidence');
      expect(result.data).not.toHaveProperty('retryOfAttemptId');
    });
  });

  describe('the four inputMode × promptMode combinations are all accepted', () => {
    it.each([
      ['typed', 'read'],
      ['typed', 'heard'],
      ['spoken', 'read'],
      ['spoken', 'heard'],
    ] as const)('accepts inputMode: %s with promptMode: %s', (inputMode, promptMode) => {
      // None of the four is inferable from the other field — heard-and-typed
      // is a learner practising listening on a bus; read-and-spoken is one who
      // wants to hear themselves answer — so all four have to be expressible.
      const result = parse({
        responseText: 'Congress',
        inputMode,
        promptMode,
        ...(inputMode === 'spoken' ? { transcript: 'Congress' } : {}),
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ inputMode, promptMode });
    });
  });

  describe('a spoken attempt', () => {
    it('accepts the confirmed transcript and a confidence', () => {
      const result = parse({
        responseText: 'the President',
        inputMode: 'spoken',
        promptMode: 'heard',
        transcript: 'the President',
        asrConfidence: 0.41,
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        transcript: 'the President',
        asrConfidence: 0.41,
      });
    });

    it('rejects one that was answered but carries no transcript', () => {
      // The row would claim a recognition happened and keep no record of what
      // came out of it, which makes the confirm-before-grade promise
      // unauditable — the one property the column was added to make checkable.
      const result = parse({
        responseText: 'Congress',
        inputMode: 'spoken',
      });

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('transcript');
    });

    it('accepts a SKIPPED spoken attempt with no transcript — there was no answer to transcribe', () => {
      const result = parse({ inputMode: 'spoken', skipped: true });

      expect(result.success).toBe(true);
    });

    it('accepts the boundary confidences 0 and 1, and rejects anything outside [0, 1]', () => {
      // `0` is a legitimate value for a client that genuinely measured it; the
      // rule against it is "do not INVENT one", which is a rule about absence,
      // not about the number.
      expect(
        parse({
          responseText: 'x',
          inputMode: 'spoken',
          transcript: 'x',
          asrConfidence: 0,
        }).success,
      ).toBe(true);
      expect(
        parse({
          responseText: 'x',
          inputMode: 'spoken',
          transcript: 'x',
          asrConfidence: 1,
        }).success,
      ).toBe(true);
      expect(
        parse({
          responseText: 'x',
          inputMode: 'spoken',
          transcript: 'x',
          asrConfidence: 1.01,
        }).success,
      ).toBe(false);
      expect(
        parse({
          responseText: 'x',
          inputMode: 'spoken',
          transcript: 'x',
          asrConfidence: -0.01,
        }).success,
      ).toBe(false);
    });
  });

  describe('a typed attempt carries neither voice field', () => {
    it('rejects a transcript on a typed attempt', () => {
      const result = parse({
        responseText: 'Congress',
        inputMode: 'typed',
        transcript: 'Congress',
      });

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('transcript');
    });

    it('rejects an asrConfidence on a typed attempt', () => {
      // Not a tidiness rule. A stray low value here would attribute a wrong
      // answer to a recogniser that never ran — a manufactured diagnosis.
      const result = parse({
        responseText: 'Congress',
        inputMode: 'typed',
        asrConfidence: 0.41,
      });

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('asrConfidence');
    });

    it('rejects them on the DEFAULTED typed attempt too, not only an explicit one', () => {
      const result = parse({ responseText: 'Congress', asrConfidence: 0.41 });

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('asrConfidence');
    });
  });

  describe('a skip carries neither', () => {
    it('rejects a transcript on a skip — the same contradiction responseText already rejects', () => {
      const result = parse({
        inputMode: 'spoken',
        skipped: true,
        transcript: 'the head of the executive ranch',
      });

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('transcript');
    });

    it('rejects an asrConfidence on a skip', () => {
      // Without this rule a learner who pressed "skip" could be recorded with
      // `failureCause: misheard` — a story about themselves that nothing
      // observed, since the outcome of a skip is never `correct`.
      const result = parse({
        inputMode: 'spoken',
        skipped: true,
        asrConfidence: 0.41,
      });

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('asrConfidence');
    });
  });

  describe('retryOfAttemptId', () => {
    it('accepts a uuid, on a typed retry as well as a spoken one', () => {
      // voice.md §3.1's own worked example has the learner typing the retry
      // ("or they type it"); refusing that would strand a learner whose
      // microphone keeps failing.
      const result = parse({
        responseText: 'the President',
        retryOfAttemptId: ATTEMPT_ID,
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ retryOfAttemptId: ATTEMPT_ID });
    });

    it('rejects a non-uuid', () => {
      const result = parse({ responseText: 'x', retryOfAttemptId: 'the-last-one' });

      expect(result.success).toBe(false);
      expect(issuePaths(result)).toContain('retryOfAttemptId');
    });
  });

  describe('the client still cannot state a verdict', () => {
    it('rejects failureCause, misheard and transcriptConfidence outright', () => {
      // `strictObject` rejects every unknown key; these three are asserted by
      // name because they are the specific shapes the "let the client say why
      // it went wrong" mistake takes now that a confidence exists. The
      // compile-time proof at the bottom of the DTO holds the same line for a
      // contributor who adds one to the schema instead of the request.
      for (const key of ['failureCause', 'misheard', 'transcriptConfidence']) {
        expect(parse({ responseText: 'x', [key]: 'anything' }).success).toBe(false);
      }
    });

    it('keeps the compile-time no-verdict proof true at runtime too', () => {
      expect(RECORD_ATTEMPT_NAMES_NO_VERDICT).toBe(true);
    });
  });
});
