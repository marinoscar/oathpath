import {
  fromStoredMasteryOutcome,
  toAttemptOutcome,
  toStoredMasteryOutcome,
} from './outcome-mapping';
import type { AttemptOutcome } from './scheduler';

// =============================================================================
// outcome-mapping.ts — tests (issue #78, epic #54 / E5 "Memory")
// =============================================================================
//
// Every direction this file's own header names: (outcome, gradingMethod) ->
// AttemptOutcome INTO the scheduler; AttemptOutcome -> the 2-value stored
// column OUT of it; and the stored 2-value column back OUT into an
// AttemptOutcome for a caller that re-reads a persisted row. The middle
// direction is a DOCUMENTED, LOSSY collapse (`correct_self_marked` ->
// `correct`) — this file asserts that collapse happens, and separately
// asserts the round-trip does NOT recover the original self-marked fact,
// rather than asserting a false round-trip guarantee.
// =============================================================================

describe('toAttemptOutcome', () => {
  it('maps a correct outcome graded "self" to correct_self_marked — the discounted-credit case', () => {
    expect(toAttemptOutcome('correct', 'self')).toBe('correct_self_marked');
  });

  it.each<'exact' | 'ai'>(['exact', 'ai'])(
    'maps a correct outcome graded "%s" to plain correct',
    (gradingMethod) => {
      expect(toAttemptOutcome('correct', gradingMethod)).toBe('correct');
    },
  );

  it.each<'exact' | 'self' | 'ai'>(['exact', 'self', 'ai'])(
    'maps an incorrect outcome to incorrect regardless of gradingMethod ("%s")',
    (gradingMethod) => {
      expect(toAttemptOutcome('incorrect', gradingMethod)).toBe('incorrect');
    },
  );

  it.each<'exact' | 'self' | 'ai'>(['exact', 'self', 'ai'])(
    'collapses partial to incorrect regardless of gradingMethod ("%s") — no correct recall was demonstrated',
    (gradingMethod) => {
      expect(toAttemptOutcome('partial', gradingMethod)).toBe('incorrect');
    },
  );

  it.each<'exact' | 'self' | 'ai'>(['exact', 'self', 'ai'])(
    'collapses skipped to incorrect regardless of gradingMethod ("%s")',
    (gradingMethod) => {
      expect(toAttemptOutcome('skipped', gradingMethod)).toBe('incorrect');
    },
  );

  it('a "self" gradingMethod only produces correct_self_marked when the outcome itself is correct — self-graded-incorrect is impossible in practice, but this function still maps it to incorrect rather than the self-marked variant', () => {
    expect(toAttemptOutcome('incorrect', 'self')).toBe('incorrect');
  });
});

describe('toStoredMasteryOutcome', () => {
  it('collapses correct_self_marked to correct on persist — the documented one-bit loss', () => {
    expect(toStoredMasteryOutcome('correct_self_marked')).toBe('correct');
  });

  it('stores a plain correct as correct', () => {
    expect(toStoredMasteryOutcome('correct')).toBe('correct');
  });

  it('stores incorrect as incorrect', () => {
    expect(toStoredMasteryOutcome('incorrect')).toBe('incorrect');
  });
});

describe('fromStoredMasteryOutcome', () => {
  it('maps a stored null to null (no attempt has ever been scheduled for this question)', () => {
    expect(fromStoredMasteryOutcome(null)).toBeNull();
  });

  it('maps a stored "correct" to the AttemptOutcome "correct" — NOT "correct_self_marked", even though a self-marked attempt could have written it', () => {
    expect(fromStoredMasteryOutcome('correct')).toBe('correct');
  });

  it('maps a stored "incorrect" to "incorrect"', () => {
    expect(fromStoredMasteryOutcome('incorrect')).toBe('incorrect');
  });

  it.each<'partial' | 'skipped'>(['partial', 'skipped'])(
    'maps a stored "%s" to "incorrect", for totality against the 4-value DB column even though toStoredMasteryOutcome never writes it',
    (stored) => {
      expect(fromStoredMasteryOutcome(stored)).toBe('incorrect');
    },
  );
});

describe('round-tripping through storage', () => {
  it('a plain correct round-trips faithfully: correct -> stored "correct" -> AttemptOutcome "correct"', () => {
    const outcome: AttemptOutcome = 'correct';
    const stored = toStoredMasteryOutcome(outcome);
    expect(fromStoredMasteryOutcome(stored)).toBe('correct');
  });

  it('an incorrect round-trips faithfully', () => {
    const outcome: AttemptOutcome = 'incorrect';
    const stored = toStoredMasteryOutcome(outcome);
    expect(fromStoredMasteryOutcome(stored)).toBe('incorrect');
  });

  it('does NOT round-trip correct_self_marked — this is the accepted, documented lossy behavior, not a bug: the column has no way to distinguish it from an objective correct once written, per the file header (that distinction lives on practice_attempts.grading_method instead)', () => {
    const outcome: AttemptOutcome = 'correct_self_marked';
    const stored = toStoredMasteryOutcome(outcome);

    expect(stored).toBe('correct');
    // The read path has no choice but to report the ambiguous stored value as
    // a plain "correct" — this is the loss, made explicit and pinned so a
    // future change that tries to "fix" it here (rather than by consulting
    // grading_method, per the header) is caught by this assertion changing.
    expect(fromStoredMasteryOutcome(stored)).toBe('correct');
    expect(fromStoredMasteryOutcome(stored)).not.toBe(outcome);
  });

  it('crashes on nothing — every AttemptOutcome value survives a full store-then-read cycle without throwing', () => {
    const outcomes: AttemptOutcome[] = ['correct', 'incorrect', 'correct_self_marked'];

    for (const outcome of outcomes) {
      expect(() => fromStoredMasteryOutcome(toStoredMasteryOutcome(outcome))).not.toThrow();
    }
  });
});
