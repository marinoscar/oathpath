import { computeReadiness, type ReadinessEvidence } from './readiness-engine';

// =============================================================================
// computeReadiness (issue #122, epic #55 / E6 "Readiness and Progress")
// =============================================================================
//
// No DB, no NestJS `TestingModule` — `computeReadiness` is called directly,
// exactly like `nextSchedule` and `nextStageOnMasteryEvent`'s own specs.
//
// The three "Dana" worked examples at the bottom of this file
// (`docs/specs/readiness-model.md` §12) are the single most important test
// in this whole epic: `tests/e2e/readiness.spec.ts` (issue #146) asserts the
// exact same three numbers later, so a wrong result here means everything
// downstream is wrong too.
// =============================================================================

/** A minimal, fully-zeroed evidence object a test can override one field of. */
function baseEvidence(overrides: Partial<ReadinessEvidence> = {}): ReadinessEvidence {
  return {
    totalQuestionsInVersion: 100,
    masteryRows: [],
    recentQualifyingAttempts: [],
    distinctPracticeDaysInLast14: 0,
    distinctQuestionsCorrectSpoken: 0,
    englishBestOutcomesInWindow: [],
    mockInterviewsPassed: 0,
    ...overrides,
  };
}

describe('computeReadiness', () => {
  // ---------------------------------------------------------------------------
  // coverage (§2.1)
  // ---------------------------------------------------------------------------

  describe('coverage', () => {
    it('is distinctQuestionsAttempted / totalQuestionsInVersion', () => {
      const result = computeReadiness(
        baseEvidence({
          totalQuestionsInVersion: 100,
          masteryRows: Array.from({ length: 25 }, () => ({ state: 'learning' as const, lapses: 0 })),
        }),
      );

      expect(result.components.coverage.value).toBeCloseTo(0.25, 10);
      expect(result.components.coverage.weight).toBe(0.15);
      expect(result.evidenceCounts.coverage).toEqual({
        distinctQuestionsAttempted: 25,
        totalQuestionsInVersion: 100,
      });
    });

    it('is 0, not NaN, when the bank is empty', () => {
      const result = computeReadiness(baseEvidence({ totalQuestionsInVersion: 0, masteryRows: [] }));
      expect(result.components.coverage.value).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // recall (§2.2) — the evidence floor
  // ---------------------------------------------------------------------------

  describe('recall', () => {
    it('is (correct + 0.5*partial) / qualifying, at 20 qualifying attempts', () => {
      const result = computeReadiness(
        baseEvidence({
          recentQualifyingAttempts: [
            ...Array(14).fill({ outcome: 'correct' as const }),
            ...Array(2).fill({ outcome: 'partial' as const }),
            ...Array(4).fill({ outcome: 'incorrect' as const }),
          ],
        }),
      );

      expect(result.components.recall.value).toBeCloseTo(0.75, 10);
      expect(result.evidenceCounts.recall).toEqual({
        qualifyingAttempts: 20,
        correctCount: 14,
        partialCount: 2,
        incorrectCount: 4,
        skippedCount: 0,
      });
    });

    it('is 0 below 5 qualifying attempts, but evidenceCounts still reports the true count', () => {
      const result = computeReadiness(
        baseEvidence({
          recentQualifyingAttempts: [
            { outcome: 'correct' },
            { outcome: 'correct' },
            { outcome: 'correct' },
            { outcome: 'correct' },
          ],
        }),
      );

      expect(result.components.recall.value).toBe(0);
      expect(result.evidenceCounts.recall.qualifyingAttempts).toBe(4);
      expect(result.evidenceCounts.recall.correctCount).toBe(4);
    });

    it('is exactly the 5-attempt boundary — 5 qualifying attempts is enough', () => {
      const result = computeReadiness(
        baseEvidence({
          recentQualifyingAttempts: Array(5).fill({ outcome: 'correct' as const }),
        }),
      );

      expect(result.components.recall.value).toBe(1);
      expect(result.evidenceCounts.recall.qualifyingAttempts).toBe(5);
    });

    it('is 0, not NaN, with zero qualifying attempts', () => {
      const result = computeReadiness(baseEvidence({ recentQualifyingAttempts: [] }));
      expect(result.components.recall.value).toBe(0);
      expect(result.evidenceCounts.recall.qualifyingAttempts).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // retention (§2.3)
  // ---------------------------------------------------------------------------

  describe('retention', () => {
    it('is (mastered*1.0 + review*0.6) / totalAttemptedQuestions', () => {
      const result = computeReadiness(
        baseEvidence({
          masteryRows: [
            { state: 'mastered', lapses: 0 },
            { state: 'mastered', lapses: 0 },
            { state: 'review', lapses: 0 },
            { state: 'review', lapses: 0 },
            { state: 'review', lapses: 0 },
            { state: 'learning', lapses: 0 },
            { state: 'lapsed', lapses: 2 },
          ],
        }),
      );

      // (2*1.0 + 3*0.6) / 7 = 3.8 / 7
      expect(result.components.retention.value).toBeCloseTo(3.8 / 7, 10);
      expect(result.evidenceCounts.retention).toEqual({
        masteredCount: 2,
        reviewCount: 3,
        totalAttemptedQuestions: 7,
      });
    });

    it('gives lapsed and learning rows zero credit, but still counts them in the denominator', () => {
      const result = computeReadiness(
        baseEvidence({
          masteryRows: [
            { state: 'learning', lapses: 0 },
            { state: 'lapsed', lapses: 3 },
          ],
        }),
      );

      expect(result.components.retention.value).toBe(0);
      expect(result.evidenceCounts.retention.totalAttemptedQuestions).toBe(2);
    });

    it('is 0, not NaN, with no mastery rows at all', () => {
      const result = computeReadiness(baseEvidence({ masteryRows: [] }));
      expect(result.components.retention.value).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // consistency (§2.4)
  // ---------------------------------------------------------------------------

  describe('consistency', () => {
    it('is min(distinctPracticeDaysInLast14, 7) / 7', () => {
      expect(
        computeReadiness(baseEvidence({ distinctPracticeDaysInLast14: 3 })).components.consistency
          .value,
      ).toBeCloseTo(3 / 7, 10);
    });

    it('caps at 7 days — 10 real days reads the same as 7', () => {
      const at10 = computeReadiness(baseEvidence({ distinctPracticeDaysInLast14: 10 }));
      const at7 = computeReadiness(baseEvidence({ distinctPracticeDaysInLast14: 7 }));
      expect(at10.components.consistency.value).toBe(1);
      expect(at10.components.consistency.value).toBe(at7.components.consistency.value);
    });

    it('is 0 with no practice days', () => {
      expect(
        computeReadiness(baseEvidence({ distinctPracticeDaysInLast14: 0 })).components.consistency
          .value,
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // remediation (§2.5)
  // ---------------------------------------------------------------------------

  describe('remediation', () => {
    it('is remediatedCount / everWeakCount, counting only rows with lapses >= WEAK_LAPSES_THRESHOLD (2)', () => {
      const result = computeReadiness(
        baseEvidence({
          masteryRows: [
            { state: 'review', lapses: 2 }, // ever-weak, remediated
            { state: 'mastered', lapses: 3 }, // ever-weak, remediated
            { state: 'lapsed', lapses: 2 }, // ever-weak, not remediated
            { state: 'learning', lapses: 1 }, // NOT ever-weak (below threshold) — excluded entirely
          ],
        }),
      );

      expect(result.components.remediation.value).toBeCloseTo(2 / 3, 10);
      expect(result.evidenceCounts.remediation).toEqual({ everWeakCount: 3, remediatedCount: 2 });
    });

    it('is 1.0 — full credit, not 0 — when everWeakCount is 0', () => {
      const result = computeReadiness(
        baseEvidence({ masteryRows: [{ state: 'mastered', lapses: 0 }] }),
      );

      expect(result.components.remediation.value).toBe(1.0);
      expect(result.evidenceCounts.remediation).toEqual({ everWeakCount: 0, remediatedCount: 0 });
    });

    it('is 1.0 with no mastery rows at all', () => {
      const result = computeReadiness(baseEvidence({ masteryRows: [] }));
      expect(result.components.remediation.value).toBe(1.0);
    });
  });

  // ---------------------------------------------------------------------------
  // english (english-test.md §6.2) — REAL EVIDENCE SINCE #141
  // ---------------------------------------------------------------------------
  //
  // No database anywhere in this block: `englishBestOutcomesInWindow` arrives
  // already windowed, already grouped by sentence and already reduced to a
  // best outcome, exactly as the engine's own contract says it does, so every
  // number below is `computeEnglish`'s arithmetic and nothing else's.

  describe('english', () => {
    /** `n` distinct sentences of one segment, all at `outcome`. */
    function sentences(
      kind: 'reading' | 'writing',
      outcome: 'correct' | 'partial' | 'incorrect',
      n: number,
    ): ReadinessEvidence['englishBestOutcomesInWindow'] {
      return Array.from({ length: n }, () => ({ kind, outcome }));
    }

    it('is 0, and reports zero sentences of both kinds, with no attempts at all', () => {
      const result = computeReadiness(baseEvidence({ englishBestOutcomesInWindow: [] }));

      expect(result.components.english.value).toBe(0);
      expect(result.evidenceCounts.english).toEqual({
        readingSentences: 0,
        writingSentences: 0,
        readingCredit: 0,
        writingCredit: 0,
      });
    });

    it('separates "no practice" from "practiced and missed" — both score 0, the counts differ', () => {
      // The whole reason `evidenceCounts.english` carries sentence counts and
      // not credit alone: these two learners are not the same person, and
      // §6.2 requires the explanation to name the missing evidence.
      const none = computeReadiness(baseEvidence({ englishBestOutcomesInWindow: [] }));
      const missed = computeReadiness(
        baseEvidence({
          englishBestOutcomesInWindow: [
            ...sentences('reading', 'incorrect', 3),
            ...sentences('writing', 'incorrect', 2),
          ],
        }),
      );

      expect(none.components.english.value).toBe(0);
      expect(missed.components.english.value).toBe(0);

      expect(none.evidenceCounts.english.readingSentences).toBe(0);
      expect(missed.evidenceCounts.english).toEqual({
        readingSentences: 3,
        writingSentences: 2,
        readingCredit: 0,
        writingCredit: 0,
      });
    });

    it('credits a partial at half a correct — the same 0.5 recall uses (§6.2)', () => {
      // 2 correct + 2 partial = 3.0 reading credit -> min(3/6, 1) = 0.5
      const result = computeReadiness(
        baseEvidence({
          englishBestOutcomesInWindow: [
            ...sentences('reading', 'correct', 2),
            ...sentences('reading', 'partial', 2),
          ],
        }),
      );

      expect(result.evidenceCounts.english.readingCredit).toBeCloseTo(3, 10);
      expect(result.components.english.value).toBeCloseTo(0.5 * 0.5, 10);
    });

    it('reading-only and writing-only evidence differ at equal counts — §6.2\'s worked arithmetic', () => {
      // THE HEADLINE ASSERTION OF THE TWO DENOMINATORS. Three all-correct
      // passes each: reading is min(3/6, 1) = 0.5 -> 0.25 of the component;
      // writing is min(3/4, 1) = 0.75 -> 0.375. Same raw count, different
      // contribution, because a reading pass is scored through a recognizer
      // and a writing pass is scored against the typed characters themselves.
      const readingOnly = computeReadiness(
        baseEvidence({ englishBestOutcomesInWindow: sentences('reading', 'correct', 3) }),
      );
      const writingOnly = computeReadiness(
        baseEvidence({ englishBestOutcomesInWindow: sentences('writing', 'correct', 3) }),
      );

      expect(readingOnly.components.english.value).toBeCloseTo(0.25, 10);
      expect(writingOnly.components.english.value).toBeCloseTo(0.375, 10);
      expect(writingOnly.components.english.value).toBeGreaterThan(
        readingOnly.components.english.value,
      );
    });

    it('caps each segment at its own target, so one segment alone never exceeds half the component', () => {
      const result = computeReadiness(
        baseEvidence({ englishBestOutcomesInWindow: sentences('reading', 'correct', 50) }),
      );

      expect(result.components.english.value).toBe(0.5);
      expect(result.evidenceCounts.english.readingCredit).toBe(50);
    });

    it('is 1 only when both segments reach their target', () => {
      const result = computeReadiness(
        baseEvidence({
          englishBestOutcomesInWindow: [
            ...sentences('reading', 'correct', 6),
            ...sentences('writing', 'correct', 4),
          ],
        }),
      );

      expect(result.components.english.value).toBe(1);
      expect(result.components.english.weight).toBe(0.05);
      expect(result.components.english.contribution).toBeCloseTo(0.05, 10);
    });

    it('weights the two segments evenly', () => {
      // reading 6/6 = 1, writing 2/4 = 0.5 -> 0.5*1 + 0.5*0.5 = 0.75
      const result = computeReadiness(
        baseEvidence({
          englishBestOutcomesInWindow: [
            ...sentences('reading', 'correct', 6),
            ...sentences('writing', 'correct', 2),
          ],
        }),
      );

      expect(result.components.english.value).toBeCloseTo(0.75, 10);
    });
  });

  // ---------------------------------------------------------------------------
  // spoken / interview (§2.7-§2.8)
  // ---------------------------------------------------------------------------

  describe('spoken, interview', () => {
    it('spoken is min(distinctQuestionsCorrectSpoken / 20, 1)', () => {
      expect(
        computeReadiness(baseEvidence({ distinctQuestionsCorrectSpoken: 5 })).components.spoken
          .value,
      ).toBeCloseTo(0.25, 10);
      expect(
        computeReadiness(baseEvidence({ distinctQuestionsCorrectSpoken: 100 })).components.spoken
          .value,
      ).toBe(1);
    });

    it('interview is min(mockInterviewsPassed / 2, 1)', () => {
      expect(computeReadiness(baseEvidence({ mockInterviewsPassed: 1 })).components.interview.value).toBe(
        0.5,
      );
      expect(computeReadiness(baseEvidence({ mockInterviewsPassed: 5 })).components.interview.value).toBe(
        1,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // capReason (§3) — the lift/no-lift boundary
  // ---------------------------------------------------------------------------

  describe('capReason', () => {
    it('is typed_only when both spoken and interview evidence read 0 attempts', () => {
      const result = computeReadiness(
        baseEvidence({ distinctQuestionsCorrectSpoken: 0, mockInterviewsPassed: 0 }),
      );
      expect(result.capReason).toBe('typed_only');
    });

    it('lifts to null the instant spoken evidence is nonzero, even one', () => {
      const result = computeReadiness(
        baseEvidence({ distinctQuestionsCorrectSpoken: 1, mockInterviewsPassed: 0 }),
      );
      expect(result.capReason).toBeNull();
    });

    it('lifts to null the instant interview evidence is nonzero, even one', () => {
      const result = computeReadiness(
        baseEvidence({ distinctQuestionsCorrectSpoken: 0, mockInterviewsPassed: 1 }),
      );
      expect(result.capReason).toBeNull();
    });

    it('the 75-point structural cap: score never exceeds 75 with none of the three', () => {
      const result = computeReadiness(
        baseEvidence({
          totalQuestionsInVersion: 10,
          masteryRows: Array.from({ length: 10 }, () => ({ state: 'mastered' as const, lapses: 0 })),
          recentQualifyingAttempts: Array(20).fill({ outcome: 'correct' as const }),
          distinctPracticeDaysInLast14: 14,
          distinctQuestionsCorrectSpoken: 0,
          englishBestOutcomesInWindow: [],
          mockInterviewsPassed: 0,
        }),
      );

      expect(result.capReason).toBe('typed_only');
      expect(result.score).toBe(75);
    });

    // -------------------------------------------------------------------------
    // english-test.md §6.3 — THE INVARIANT E10 MOST ENDANGERS
    // -------------------------------------------------------------------------
    //
    // A learner can now earn a real, non-zero `english` value without ever
    // having spoken a civics answer or sat a mock interview. These three
    // assertions are what stop that from being mistaken for the evidence the
    // cap is about. If any of them ever fails, the product is telling someone
    // they are close to ready on the strength of typing sentences.

    it('perfect English evidence does NOT lift the cap', () => {
      const result = computeReadiness(
        baseEvidence({
          englishBestOutcomesInWindow: [
            ...Array.from({ length: 20 }, () => ({
              kind: 'reading' as const,
              outcome: 'correct' as const,
            })),
            ...Array.from({ length: 20 }, () => ({
              kind: 'writing' as const,
              outcome: 'correct' as const,
            })),
          ],
          distinctQuestionsCorrectSpoken: 0,
          mockInterviewsPassed: 0,
        }),
      );

      expect(result.components.english.value).toBe(1);
      expect(result.capReason).toBe('typed_only');
    });

    it('a learner perfect at everything except speaking still cannot exceed 75', () => {
      const result = computeReadiness(
        baseEvidence({
          totalQuestionsInVersion: 10,
          masteryRows: Array.from({ length: 10 }, () => ({ state: 'mastered' as const, lapses: 0 })),
          recentQualifyingAttempts: Array(20).fill({ outcome: 'correct' as const }),
          distinctPracticeDaysInLast14: 14,
          englishBestOutcomesInWindow: [
            ...Array.from({ length: 6 }, () => ({
              kind: 'reading' as const,
              outcome: 'correct' as const,
            })),
            ...Array.from({ length: 4 }, () => ({
              kind: 'writing' as const,
              outcome: 'correct' as const,
            })),
          ],
          distinctQuestionsCorrectSpoken: 0,
          mockInterviewsPassed: 0,
        }),
      );

      // 75 (everything else perfect) + 5 (english at its full 0.05 weight) —
      // English moves the score by its own weight and by exactly nothing
      // else. The 75 ceiling belongs to `spoken` + `interview`'s 0.20, which
      // is still unearned here.
      expect(result.capReason).toBe('typed_only');
      expect(result.score).toBe(80);
      expect(result.components.spoken.value).toBe(0);
      expect(result.components.interview.value).toBe(0);
    });

    it('English evidence changes nothing about capReason in either direction', () => {
      const withEnglish = { kind: 'writing' as const, outcome: 'correct' as const };

      expect(
        computeReadiness(baseEvidence({ englishBestOutcomesInWindow: [withEnglish] })).capReason,
      ).toBe('typed_only');
      expect(
        computeReadiness(
          baseEvidence({ englishBestOutcomesInWindow: [], distinctQuestionsCorrectSpoken: 1 }),
        ).capReason,
      ).toBeNull();
      expect(
        computeReadiness(
          baseEvidence({
            englishBestOutcomesInWindow: [withEnglish],
            distinctQuestionsCorrectSpoken: 1,
          }),
        ).capReason,
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Dana — the three worked-example days (readiness-model.md §12)
  // ---------------------------------------------------------------------------
  //
  // Every number below is transcribed verbatim from the spec's own table.
  // These exact scores (33, 50, 59) and capReasons are asserted a second
  // time, independently, by `tests/e2e/readiness.spec.ts` (issue #146) — if
  // this suite and that one ever disagree, this engine is the one that is
  // wrong.

  describe('Dana — Day 1 (2026-04-06)', () => {
    it('scores 33 and stays typed_only', () => {
      // The spec's "rows with lapses >= 2: 2, of which 1 is currently
      // review/mastered" needs one ever-weak row to itself be a
      // review/mastered row today (a lapsed-then-recovered question, 5
      // plain `review` rows plus 1 recovered) and the other still `lapsed`
      // (1 at `lapses: 2`, plus a second `lapsed` row at `lapses: 1` — below
      // `WEAK_LAPSES_THRESHOLD`, so it does not count toward `everWeakCount`
      // — to keep the total at the spec's stated `lapsed: 2`).
      const evidence: ReadinessEvidence = {
        totalQuestionsInVersion: 100,
        masteryRows: [
          ...Array(2).fill({ state: 'mastered' as const, lapses: 0 }),
          ...Array(5).fill({ state: 'review' as const, lapses: 0 }),
          { state: 'review' as const, lapses: 2 }, // recovered from a lapse — remediated
          ...Array(10).fill({ state: 'learning' as const, lapses: 0 }),
          { state: 'lapsed' as const, lapses: 2 }, // still lapsed — not remediated
          { state: 'lapsed' as const, lapses: 1 }, // still lapsed, but below the weak threshold
        ],
        recentQualifyingAttempts: [
          ...Array(14).fill({ outcome: 'correct' as const }),
          ...Array(2).fill({ outcome: 'partial' as const }),
          ...Array(4).fill({ outcome: 'incorrect' as const }),
        ],
        distinctPracticeDaysInLast14: 3,
        distinctQuestionsCorrectSpoken: 0,
        englishBestOutcomesInWindow: [],
        mockInterviewsPassed: 0,
      };

      expect(evidence.masteryRows).toHaveLength(20);

      const result = computeReadiness(evidence);

      expect(result.evidenceCounts.coverage).toEqual({
        distinctQuestionsAttempted: 20,
        totalQuestionsInVersion: 100,
      });
      expect(result.evidenceCounts.remediation).toEqual({ everWeakCount: 2, remediatedCount: 1 });

      expect(result.components.coverage.value).toBeCloseTo(0.2, 10);
      expect(result.components.recall.value).toBeCloseTo(0.75, 10);
      expect(result.components.retention.value).toBeCloseTo(0.28, 10);
      expect(result.components.consistency.value).toBeCloseTo(0.428571, 5);
      expect(result.components.remediation.value).toBeCloseTo(0.5, 10);
      expect(result.components.english.value).toBe(0);
      expect(result.components.spoken.value).toBe(0);
      expect(result.components.interview.value).toBe(0);

      expect(result.score).toBe(33);
      expect(result.capReason).toBe('typed_only');
    });
  });

  describe('Dana — Day 2 (2026-04-08)', () => {
    it('scores 50 and stays typed_only', () => {
      const evidence: ReadinessEvidence = {
        totalQuestionsInVersion: 100,
        masteryRows: [
          ...Array(8).fill({ state: 'mastered' as const, lapses: 0 }),
          ...Array(11).fill({ state: 'review' as const, lapses: 0 }),
          ...Array(3).fill({ state: 'review' as const, lapses: 2 }), // remediated ever-weak rows
          ...Array(14).fill({ state: 'learning' as const, lapses: 0 }),
          { state: 'lapsed' as const, lapses: 2 }, // still lapsed — not remediated
          ...Array(3).fill({ state: 'lapsed' as const, lapses: 1 }), // still lapsed, below the weak threshold
        ],
        recentQualifyingAttempts: [
          ...Array(18).fill({ outcome: 'correct' as const }),
          { outcome: 'partial' as const },
          { outcome: 'incorrect' as const },
        ],
        distinctPracticeDaysInLast14: 7,
        distinctQuestionsCorrectSpoken: 0,
        englishBestOutcomesInWindow: [],
        mockInterviewsPassed: 0,
      };

      expect(evidence.masteryRows).toHaveLength(40);

      const result = computeReadiness(evidence);

      expect(result.evidenceCounts.coverage.distinctQuestionsAttempted).toBe(40);
      expect(result.evidenceCounts.remediation).toEqual({ everWeakCount: 4, remediatedCount: 3 });

      expect(result.components.coverage.value).toBeCloseTo(0.4, 10);
      expect(result.components.recall.value).toBeCloseTo(0.925, 10);
      expect(result.components.retention.value).toBeCloseTo(0.41, 10);
      expect(result.components.consistency.value).toBe(1.0);
      expect(result.components.remediation.value).toBeCloseTo(0.75, 10);

      expect(result.score).toBe(50);
      expect(result.capReason).toBe('typed_only');
    });
  });

  describe('Dana — Day 3 (2026-04-10)', () => {
    it('scores 59, cap lifts to null, and retention has the greatest weighted headroom', () => {
      const evidence: ReadinessEvidence = {
        totalQuestionsInVersion: 100,
        masteryRows: [
          ...Array(12).fill({ state: 'mastered' as const, lapses: 0 }),
          ...Array(16).fill({ state: 'review' as const, lapses: 0 }),
          ...Array(4).fill({ state: 'review' as const, lapses: 2 }), // remediated ever-weak rows
          ...Array(18).fill({ state: 'learning' as const, lapses: 0 }),
          { state: 'lapsed' as const, lapses: 2 }, // still lapsed — not remediated
          ...Array(4).fill({ state: 'lapsed' as const, lapses: 1 }), // still lapsed, below the weak threshold
        ],
        recentQualifyingAttempts: [
          ...Array(19).fill({ outcome: 'correct' as const }),
          { outcome: 'incorrect' as const },
        ],
        distinctPracticeDaysInLast14: 7,
        distinctQuestionsCorrectSpoken: 0,
        englishBestOutcomesInWindow: [],
        mockInterviewsPassed: 1,
      };

      expect(evidence.masteryRows).toHaveLength(55);

      const result = computeReadiness(evidence);

      expect(result.evidenceCounts.coverage.distinctQuestionsAttempted).toBe(55);
      expect(result.evidenceCounts.remediation).toEqual({ everWeakCount: 5, remediatedCount: 4 });
      expect(result.evidenceCounts.interview).toEqual({ attempts: 1 });

      expect(result.components.coverage.value).toBeCloseTo(0.55, 10);
      expect(result.components.recall.value).toBeCloseTo(0.95, 10);
      expect(result.components.retention.value).toBeCloseTo(24 / 55, 10);
      expect(result.components.consistency.value).toBe(1.0);
      expect(result.components.remediation.value).toBeCloseTo(0.8, 10);
      expect(result.components.interview.value).toBeCloseTo(0.5, 10);

      expect(result.score).toBe(59);
      expect(result.capReason).toBeNull();

      // The five currently-earnable components' weighted headroom
      // (weight * (1 - value)) — retention has the greatest.
      const headroom = (key: 'coverage' | 'recall' | 'retention' | 'consistency' | 'remediation') =>
        result.components[key].weight * (1 - result.components[key].value);

      const greatest = (['coverage', 'recall', 'retention', 'consistency', 'remediation'] as const)
        .map((key) => ({ key, headroom: headroom(key) }))
        .sort((a, b) => b.headroom - a.headroom)[0];

      expect(greatest.key).toBe('retention');
      expect(headroom('retention')).toBeCloseTo(0.112727, 5);
    });
  });
});
