import { computeReadiness, type ReadinessEvidence } from './readiness-engine';
import { buildTopRecommendation } from './top-recommendation';

// =============================================================================
// buildTopRecommendation — english joins the earnable set (issue #141,
// epic #59 / E10 "Reading and writing tests")
// =============================================================================
//
// No DB and no fabricated `ReadinessResult`: every case below is built by
// running the real `computeReadiness` over evidence, so the recommendation is
// tested against numbers the engine actually produces rather than a
// hand-written result object that could drift from it. `english-test.md` §6.4
// is the change under test — `EARNABLE_COMPONENT_KEYS` gained a sixth entry.
// =============================================================================

function baseEvidence(overrides: Partial<ReadinessEvidence> = {}): ReadinessEvidence {
  return {
    totalQuestionsInVersion: 100,
    masteryRows: [],
    recentQualifyingAttempts: [],
    englishBestOutcomesInWindow: [],
    distinctPracticeDaysInLast14: 0,
    distinctQuestionsCorrectSpoken: 0,
    mockInterviewsPassed: 0,
    ...overrides,
  };
}

/**
 * A learner strong enough everywhere else that `english`'s 0.05 headroom is
 * the greatest one left, and uncapped (one spoken answer) so a component is
 * picked at all rather than the fixed cap card.
 */
function strongExceptEnglish(overrides: Partial<ReadinessEvidence> = {}): ReadinessEvidence {
  return baseEvidence({
    totalQuestionsInVersion: 10,
    masteryRows: Array.from({ length: 10 }, () => ({ state: 'mastered' as const, lapses: 0 })),
    recentQualifyingAttempts: Array(20).fill({ outcome: 'correct' as const }),
    distinctPracticeDaysInLast14: 14,
    distinctQuestionsCorrectSpoken: 1,
    ...overrides,
  });
}

describe('buildTopRecommendation', () => {
  it('recommends english when it is the weakest earnable component', () => {
    const result = computeReadiness(strongExceptEnglish());
    const recommendation = buildTopRecommendation(result);

    expect(recommendation.componentKey).toBe('english');
  });

  it('points at a route that exists today, never an invented one', () => {
    // The reading and writing screens are #144/#147 and are not built. A
    // recommendation whose one action 404s is worse than one that lands on
    // the general practice page — see `top-recommendation.ts`'s header, and
    // re-point this when those screens land.
    const recommendation = buildTopRecommendation(computeReadiness(strongExceptEnglish()));

    expect(recommendation.path).toBe('/practice');
  });

  it('names the missing evidence when there is none, rather than a bare zero', () => {
    const recommendation = buildTopRecommendation(computeReadiness(strongExceptEnglish()));

    expect(recommendation.reason).toContain('last 30 days');
    expect(recommendation.reason).toMatch(/haven’t practiced reading or writing/);
  });

  it('grounds its copy in the snapshot’s own counts once evidence exists', () => {
    const result = computeReadiness(
      strongExceptEnglish({
        englishBestOutcomesInWindow: [
          { kind: 'reading', outcome: 'correct' },
          { kind: 'writing', outcome: 'partial' },
          { kind: 'writing', outcome: 'correct' },
        ],
      }),
    );
    const recommendation = buildTopRecommendation(result);

    expect(recommendation.componentKey).toBe('english');
    // Singular/plural agreement matters here only because the numbers are
    // read straight off `evidenceCounts` — nothing is hand-templated.
    expect(recommendation.reason).toContain('1 reading sentence ');
    expect(recommendation.reason).toContain('2 writing sentences');
  });

  it('still yields to a larger headroom elsewhere — english does not jump the queue', () => {
    // Coverage at 0.2 -> headroom 0.15 * 0.8 = 0.12, far above english's
    // maximum possible 0.05. The sixth key competes on the same arithmetic as
    // the other five; it is not special-cased.
    const result = computeReadiness(
      baseEvidence({
        totalQuestionsInVersion: 100,
        masteryRows: Array.from({ length: 20 }, () => ({ state: 'mastered' as const, lapses: 0 })),
        recentQualifyingAttempts: Array(20).fill({ outcome: 'correct' as const }),
        distinctPracticeDaysInLast14: 14,
        distinctQuestionsCorrectSpoken: 1,
      }),
    );

    expect(buildTopRecommendation(result).componentKey).toBe('coverage');
  });

  it('a capped learner still gets the fixed cap card, however weak english is', () => {
    // §6.3 again, from the recommendation's side: English evidence neither
    // lifts the cap nor competes with the cap message while it stands.
    const result = computeReadiness(
      baseEvidence({ distinctQuestionsCorrectSpoken: 0, mockInterviewsPassed: 0 }),
    );

    expect(result.capReason).toBe('typed_only');
    expect(buildTopRecommendation(result)).toEqual({
      componentKey: null,
      title: 'Limited interview practice',
      reason: expect.stringContaining('two mock interviews'),
      path: '/practice/interviews',
    });
  });
});
