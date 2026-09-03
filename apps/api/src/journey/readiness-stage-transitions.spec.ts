import {
  nextStageOnReadinessSnapshot,
  READINESS_PRACTICING_THRESHOLD,
  READINESS_PERFORMING_THRESHOLD,
  READINESS_READY_THRESHOLD,
} from './readiness-stage-transitions';

// =============================================================================
// nextStageOnReadinessSnapshot (issue #127, epic #55 / E6)
// =============================================================================
//
// No DB, no NestJS `TestingModule` — called directly, exactly like
// `nextStageOnMasteryEvent`'s own spec.
// =============================================================================

describe('nextStageOnReadinessSnapshot', () => {
  it('exposes the exact threshold constants readiness-model.md §8.1 declares', () => {
    expect(READINESS_PRACTICING_THRESHOLD).toBe(50);
    expect(READINESS_PERFORMING_THRESHOLD).toBe(65);
    expect(READINESS_READY_THRESHOLD).toBe(80);
  });

  // ---------------------------------------------------------------------------
  // remembering -> practicing (>= 50)
  // ---------------------------------------------------------------------------

  describe('remembering -> practicing', () => {
    it('does not transition just below the threshold', () => {
      expect(nextStageOnReadinessSnapshot('remembering', 49, 'typed_only')).toBeNull();
    });

    it('transitions exactly AT the threshold (>=, not >) — the Day 2 worked example', () => {
      expect(nextStageOnReadinessSnapshot('remembering', 50, 'typed_only')).toBe('practicing');
    });

    it('transitions above the threshold', () => {
      expect(nextStageOnReadinessSnapshot('remembering', 51, 'typed_only')).toBe('practicing');
    });

    it('capReason does not gate this transition', () => {
      expect(nextStageOnReadinessSnapshot('remembering', 50, null)).toBe('practicing');
    });
  });

  // ---------------------------------------------------------------------------
  // practicing -> performing (>= 65)
  // ---------------------------------------------------------------------------

  describe('practicing -> performing', () => {
    it('does not transition just below the threshold', () => {
      expect(nextStageOnReadinessSnapshot('practicing', 64, 'typed_only')).toBeNull();
    });

    it('transitions exactly AT the threshold', () => {
      expect(nextStageOnReadinessSnapshot('practicing', 65, 'typed_only')).toBe('performing');
    });

    it('transitions above the threshold', () => {
      expect(nextStageOnReadinessSnapshot('practicing', 90, 'typed_only')).toBe('performing');
    });
  });

  // ---------------------------------------------------------------------------
  // performing -> ready (>= 80 AND capReason === null)
  // ---------------------------------------------------------------------------

  describe('performing -> ready', () => {
    it('does not transition just below the threshold, even uncapped', () => {
      expect(nextStageOnReadinessSnapshot('performing', 79, null)).toBeNull();
    });

    it('transitions exactly AT the threshold when uncapped', () => {
      expect(nextStageOnReadinessSnapshot('performing', 80, null)).toBe('ready');
    });

    it('transitions above the threshold when uncapped', () => {
      expect(nextStageOnReadinessSnapshot('performing', 95, null)).toBe('ready');
    });

    it('does NOT transition at score 85 while still capped — a learner can never reach ready on typed answers alone', () => {
      expect(nextStageOnReadinessSnapshot('performing', 85, 'typed_only')).toBeNull();
    });

    it('does not transition at exactly the threshold while still capped', () => {
      expect(nextStageOnReadinessSnapshot('performing', 80, 'typed_only')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // speaking — always null, this function never touches it
  // ---------------------------------------------------------------------------

  it('speaking always returns null, at any score and any capReason', () => {
    expect(nextStageOnReadinessSnapshot('speaking', 0, 'typed_only')).toBeNull();
    expect(nextStageOnReadinessSnapshot('speaking', 50, 'typed_only')).toBeNull();
    expect(nextStageOnReadinessSnapshot('speaking', 100, null)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Every other stage, and regression — never automatic
  // ---------------------------------------------------------------------------

  it('never regresses a stage backward when score falls, even far below a once-cleared threshold', () => {
    expect(nextStageOnReadinessSnapshot('performing', 10, 'typed_only')).toBeNull();
    expect(nextStageOnReadinessSnapshot('practicing', 0, 'typed_only')).toBeNull();
  });

  it('returns null for stages this function does not act on (uncertain, oriented, learning, ready)', () => {
    expect(nextStageOnReadinessSnapshot('uncertain', 100, null)).toBeNull();
    expect(nextStageOnReadinessSnapshot('oriented', 100, null)).toBeNull();
    expect(nextStageOnReadinessSnapshot('learning', 100, null)).toBeNull();
    expect(nextStageOnReadinessSnapshot('ready', 100, null)).toBeNull();
  });
});
