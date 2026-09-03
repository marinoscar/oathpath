import {
  CLOSING_TURNS,
  INTERVIEW_PHASES,
  N400_TURNS,
  PHASE_TURNS,
  SKIPPED_PHASES,
  SKIPPED_SEGMENT_TURNS,
  SMALLTALK_TURNS,
  isSkippedPhase,
  type InterviewPhase,
} from './phases';

// =============================================================================
// phases.ts — tests (issue #123, epic #57 / E8 "Mock interview")
// =============================================================================
//
// The order of `INTERVIEW_PHASES` is the contract the engine walks, so it is
// asserted here literally rather than derived from anything — a test that
// computed the expected order from the array under test would pass for every
// possible order.
// =============================================================================

describe('INTERVIEW_PHASES', () => {
  it('is the six phases in conducting order', () => {
    expect(INTERVIEW_PHASES).toEqual([
      'smalltalk',
      'n400',
      'civics',
      'reading',
      'writing',
      'closing',
    ]);
  });

  it('names every phase exactly once', () => {
    expect(new Set(INTERVIEW_PHASES).size).toBe(INTERVIEW_PHASES.length);
  });
});

describe('SKIPPED_PHASES', () => {
  it('is reading and writing — named in the sequence, not omitted from it', () => {
    expect(SKIPPED_PHASES).toEqual(['reading', 'writing']);

    for (const phase of SKIPPED_PHASES) {
      expect(INTERVIEW_PHASES).toContain(phase);
    }
  });

  it('isSkippedPhase is true for exactly those two and false for the rest', () => {
    const skipped = INTERVIEW_PHASES.filter((phase: InterviewPhase) => isSkippedPhase(phase));
    expect(skipped).toEqual(['reading', 'writing']);
  });
});

describe('PHASE_TURNS', () => {
  it('gives every phase but civics a fixed turn count', () => {
    expect(PHASE_TURNS).toEqual({
      smalltalk: SMALLTALK_TURNS,
      n400: N400_TURNS,
      reading: SKIPPED_SEGMENT_TURNS,
      writing: SKIPPED_SEGMENT_TURNS,
      closing: CLOSING_TURNS,
    });
  });

  it('has no entry for civics, whose length the version row and the stop rule decide', () => {
    expect(Object.keys(PHASE_TURNS)).not.toContain('civics');
    expect(Object.keys(PHASE_TURNS).sort()).toEqual(
      INTERVIEW_PHASES.filter((phase) => phase !== 'civics')
        .slice()
        .sort(),
    );
  });

  it('counts at least one turn for every phase it covers', () => {
    for (const turns of Object.values(PHASE_TURNS)) {
      expect(turns).toBeGreaterThanOrEqual(1);
    }
  });
});
