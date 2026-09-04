import {
  MAX_ALIGNED_TOKENS,
  WER_CORRECT_MAX,
  WER_PARTIAL_MAX,
  classifyOutcome,
  scoreEnglishAttempt,
  tokenizeForScoring,
} from './english-scoring';

// =============================================================================
// The scorer, asserted against `docs/specs/english-test.md` §2.4's own table
// =============================================================================
//
// No Nest, no Prisma, no database: this is a pure function and the test is the
// spec's worked table typed out, so that a change to the rule fails HERE, next
// to the document that justifies it, rather than three layers up in a service
// test that also happens to touch a database.

describe('tokenizeForScoring', () => {
  it('applies E3 normalisation, including the ordinal and abbreviation rules', () => {
    // Documented consequences of reusing `normalizeAnswer`, pinned so a change
    // to E3's table is visible here rather than silently re-scoring history.
    expect(tokenizeForScoring('George Washington was the first President.')).toEqual([
      'george',
      'washington',
      'was',
      'the',
      '1',
      'president',
    ]);
    expect(tokenizeForScoring('We pay taxes.')).toEqual(['we', 'pay', 'taxes']);
    expect(tokenizeForScoring('Citizens can vote.')).toEqual(['citizens', 'can', 'vote']);
  });

  it('drops the leading article on BOTH sides, so the two still compare equal', () => {
    expect(tokenizeForScoring('The White House is in Washington, D.C.')).toEqual(
      tokenizeForScoring('White House is in Washington, D.C.'),
    );
  });

  it('is empty for an empty or whitespace-only input, never [""]', () => {
    expect(tokenizeForScoring('')).toEqual([]);
    expect(tokenizeForScoring('   ')).toEqual([]);
  });
});

describe('classifyOutcome — §2.3, error count first', () => {
  it('is correct with no errors at all', () => {
    expect(classifyOutcome(0, 0)).toBe('correct');
  });

  it('admits exactly one error while the rate stays within the bound', () => {
    expect(classifyOutcome(1, 1 / 3)).toBe('correct'); // 0.333 <= 0.34
    expect(classifyOutcome(1, WER_CORRECT_MAX)).toBe('correct'); // the boundary itself
  });

  it('refuses one error that costs more than the bound — half a two-word sentence', () => {
    expect(classifyOutcome(1, 0.5)).toBe('partial');
  });

  it('never returns correct for two or more errors, however low the rate', () => {
    // The whole reason the rule is compound: 2/8 = 0.25 is a LOWER rate than
    // the 1/3 = 0.333 admitted above, and is still not "read the sentence".
    expect(classifyOutcome(2, 0.25)).toBe('partial');
  });

  it('is partial up to and including the outer bound, incorrect past it', () => {
    expect(classifyOutcome(3, WER_PARTIAL_MAX)).toBe('partial');
    expect(classifyOutcome(3, WER_PARTIAL_MAX + 0.001)).toBe('incorrect');
  });
});

describe('scoreEnglishAttempt — §2.4, the spec table', () => {
  const REFERENCE = 'George Washington was the first President.';

  const row = (hypothesis: string) => scoreEnglishAttempt(REFERENCE, hypothesis);

  it('row 1 — read exactly: 0 errors, correct', () => {
    const r = row('George Washington was the first President.');
    expect(r.referenceTokenCount).toBe(6);
    expect(r.errors).toBe(0);
    expect(r.wer).toBe(0);
    expect(r.outcome).toBe('correct');
    expect(r.diff.every((op) => op.kind === 'match')).toBe(true);
  });

  it('row 2 — one deletion: near-miss that passes', () => {
    const r = row('George Washington was first President.');
    expect(r.deletions).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.wer).toBeCloseTo(1 / 6, 6);
    expect(r.outcome).toBe('correct');
    expect(r.diff.find((op) => op.kind === 'delete')?.reference).toBe('the');
  });

  it('row 3 — one substitution: near-miss that passes, and names the word', () => {
    const r = row('George Washington was the first leader.');
    expect(r.substitutions).toBe(1);
    expect(r.outcome).toBe('correct');
    const sub = r.diff.find((op) => op.kind === 'substitute');
    expect(sub).toMatchObject({ reference: 'president', hypothesis: 'leader' });
  });

  it('row 7 — one insertion: counted exactly like a substitution or a deletion', () => {
    const r = row('George Washington Adams was the first President.');
    expect(r.insertions).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.outcome).toBe('correct');
  });

  it('row 8 — two insertions: partial, never correct however low the rate', () => {
    const r = row('George Washington really was truly the first President.');
    expect(r.errors).toBe(2);
    expect(r.wer).toBeCloseTo(2 / 6, 6);
    expect(r.outcome).toBe('partial');
  });

  it('row 9 — three insertions: pinned exactly at WER_PARTIAL_MAX, still partial', () => {
    const r = row('Well George Washington was the first President I believe.');
    expect(r.errors).toBe(3);
    expect(r.wer).toBe(WER_PARTIAL_MAX);
    expect(r.outcome).toBe('partial');
  });

  it('row 10 — four errors: the genuine failure', () => {
    const r = row('Washington was our leader.');
    expect(r.errors).toBe(4);
    expect(r.wer).toBeCloseTo(4 / 6, 6);
    expect(r.outcome).toBe('incorrect');
  });

  it("the spec's own caught mistake: 'of the United States' normalises AWAY", () => {
    // Kept as a test, not only as prose: `normalizeAnswer`'s abbreviation table
    // collapses `president of the united states` to `president`, so this reads
    // as a perfect match rather than four insertions. If E3's table ever stops
    // doing that, this test fails and whoever changed it learns that a spec
    // example depends on it.
    const r = row('George Washington was the first President of the United States.');
    expect(r.errors).toBe(0);
    expect(r.outcome).toBe('correct');
  });
});

describe('scoreEnglishAttempt — edges', () => {
  it('an empty submission is every reference word deleted, wer 1, incorrect', () => {
    const r = scoreEnglishAttempt('We pay taxes.', '');
    expect(r.deletions).toBe(3);
    expect(r.wer).toBe(1);
    expect(r.outcome).toBe('incorrect');
    expect(r.diff).toHaveLength(3);
  });

  it('an empty reference reports a rate of 0 rather than dividing by zero', () => {
    const r = scoreEnglishAttempt('', 'anything at all');
    expect(r.referenceTokenCount).toBe(0);
    expect(r.wer).toBe(0);
    expect(Number.isNaN(r.wer)).toBe(false);
  });

  it('truncates a pathological hypothesis rather than sizing a matrix by it', () => {
    const r = scoreEnglishAttempt('We pay taxes.', 'word '.repeat(MAX_ALIGNED_TOKENS * 3));
    expect(r.insertions).toBeLessThanOrEqual(MAX_ALIGNED_TOKENS);
    expect(r.outcome).toBe('incorrect');
  });

  it('is deterministic — the same inputs give the identical result object', () => {
    const a = scoreEnglishAttempt('Alaska is the largest state.', 'Alaska is largest state');
    const b = scoreEnglishAttempt('Alaska is the largest state.', 'Alaska is largest state');
    expect(a).toEqual(b);
  });
});
