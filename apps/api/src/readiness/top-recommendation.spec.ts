import { computeReadiness, type ReadinessEvidence } from './readiness-engine';
import { buildTopRecommendation } from './top-recommendation';

// =============================================================================
// buildTopRecommendation — english joins the earnable set (issue #141), then
// points at a real screen (#144/#147, epic #59 / E10 "Reading and writing
// tests")
// =============================================================================
//
// No DB and no fabricated `ReadinessResult`: every case below is built by
// running the real `computeReadiness` over evidence, so the recommendation is
// tested against numbers the engine actually produces rather than a
// hand-written result object that could drift from it. `english-test.md` §6.4
// is the first change under test — `EARNABLE_COMPONENT_KEYS` gained a sixth
// entry — and the segment pick below is the second: now that
// `/practice/reading` and `/practice/writing` are both mounted, the card
// names one of them, chosen by which segment has the greater headroom.
//
// The segment cases are deliberately built from OUTCOMES rather than counts,
// because credit-over-target is the thing being asserted: six missed reading
// sentences are six sentences and zero evidence at the same time, and only
// one of those two numbers may decide where a learner is sent.
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

  it('sends a learner with no English evidence at all to the reading screen', () => {
    // Both segment values are 0, which is a tie, and a tie keeps the
    // first-declared segment. The assertion that matters is the stability, not
    // the preference: the same input must not alternate between two screens.
    const recommendation = buildTopRecommendation(computeReadiness(strongExceptEnglish()));
    const again = buildTopRecommendation(computeReadiness(strongExceptEnglish()));

    expect(recommendation.path).toBe('/practice/reading');
    expect(again.path).toBe('/practice/reading');
  });

  it('sends a learner to the segment with the most room left — reading', () => {
    // reading 1/6 = 0.167, writing 1.5/4 = 0.375. Reading is the lower value,
    // so reading is the greater headroom of the two equal shares.
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
    expect(recommendation.path).toBe('/practice/reading');
    expect(recommendation.reason).toContain('reading is the half with the most room left');
  });

  it('sends a learner to the segment with the most room left — writing', () => {
    // reading 3/6 = 0.5, writing 1/4 = 0.25. The mirror of the case above, and
    // the reason the copy is chosen in the same three lines as the path: the
    // sentence names writing only where the link goes to writing.
    const result = computeReadiness(
      strongExceptEnglish({
        englishBestOutcomesInWindow: [
          { kind: 'reading', outcome: 'correct' },
          { kind: 'reading', outcome: 'correct' },
          { kind: 'reading', outcome: 'correct' },
          { kind: 'writing', outcome: 'correct' },
        ],
      }),
    );
    const recommendation = buildTopRecommendation(result);

    expect(recommendation.componentKey).toBe('english');
    expect(recommendation.path).toBe('/practice/writing');
    expect(recommendation.reason).toContain('writing is the half with the most room left');
  });

  it('picks the segment by credit against its own target, not by raw sentence count', () => {
    // Six reading sentences, all missed: reading 0/6 = 0, writing 1/4 = 0.25.
    // The learner has done SIX TIMES as much reading as writing and still
    // belongs on the reading screen, because none of it earned credit — and
    // the copy must not tell them they have done less writing.
    const result = computeReadiness(
      strongExceptEnglish({
        englishBestOutcomesInWindow: [
          ...Array.from({ length: 6 }, () => ({
            kind: 'reading' as const,
            outcome: 'incorrect' as const,
          })),
          { kind: 'writing', outcome: 'correct' },
        ],
      }),
    );
    const recommendation = buildTopRecommendation(result);

    expect(recommendation.path).toBe('/practice/reading');
    expect(recommendation.reason).toContain('6 reading sentences and 1 writing sentence');
  });

  it('names the missing evidence when there is none, rather than a bare zero', () => {
    const recommendation = buildTopRecommendation(computeReadiness(strongExceptEnglish()));

    expect(recommendation.reason).toContain('last 30 days');
    expect(recommendation.reason).toMatch(/haven’t practiced reading or writing/);
    // Still says the interview asks for both, even though it can only link to
    // one of the two screens.
    expect(recommendation.reason).toContain('interview asks for both');
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
