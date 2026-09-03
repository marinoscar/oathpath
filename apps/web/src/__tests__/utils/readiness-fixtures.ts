/**
 * Readiness snapshot fixtures (issues #139/#142, epic #55 / E6 "Readiness
 * and Progress").
 *
 * Shaped from `apps/api/src/readiness/dto/readiness-snapshot.dto.ts` and
 * Dana's Day 3 worked example (`docs/specs/readiness-model.md` §12) rather
 * than invented, so a suite that passes here is exercising numbers that are
 * arithmetically checked against the spec itself.
 */

import type {
  ReadinessHistoryResponse,
  ReadinessSnapshotResponse,
} from '../../types';

/**
 * §12's Day 3 snapshot: capped lifted (one passed mock interview),
 * `retention` the top recommendation. The default success fixture for every
 * suite that does not care about the specific numbers.
 */
export function readinessSnapshot(
  overrides: Partial<ReadinessSnapshotResponse> = {},
): ReadinessSnapshotResponse {
  return {
    id: 'snapshot-day-3',
    computedAt: '2026-04-10T12:00:00.000Z',
    score: 59,
    stage: 'practicing',
    components: {
      coverage: { value: 0.55, weight: 0.15, contribution: 0.0825 },
      recall: { value: 0.95, weight: 0.2, contribution: 0.19 },
      retention: { value: 0.436364, weight: 0.2, contribution: 0.0872727 },
      consistency: { value: 1.0, weight: 0.1, contribution: 0.1 },
      remediation: { value: 0.8, weight: 0.1, contribution: 0.08 },
      english: { value: 0, weight: 0.05, contribution: 0 },
      spoken: { value: 0, weight: 0.1, contribution: 0 },
      interview: { value: 0.5, weight: 0.1, contribution: 0.05 },
    },
    evidenceCounts: {
      coverage: { distinctQuestionsAttempted: 55, totalQuestionsInVersion: 100 },
      recall: {
        qualifyingAttempts: 20,
        correctCount: 19,
        partialCount: 0,
        incorrectCount: 1,
        skippedCount: 0,
      },
      retention: { masteredCount: 12, reviewCount: 20, totalAttemptedQuestions: 55 },
      consistency: { distinctPracticeDaysInLast14: 7 },
      remediation: { everWeakCount: 5, remediatedCount: 4 },
      english: { distinctQuestionsCorrectSpokenInEnglish: 0 },
      spoken: { attempts: 0 },
      interview: { attempts: 1 },
    },
    capReason: null,
    topRecommendation: {
      componentKey: 'retention',
      title: 'Turn more of your review questions into mastered ones',
      reason:
        'Converting your review-state questions to mastered is the single largest lever left on your score.',
      path: '/practice',
    },
    narrative: null,
    narrativeGeneratedAt: null,
    ...overrides,
  };
}

/**
 * §12's Day 1 snapshot: still capped, no spoken or interview evidence at
 * all. `topRecommendation` carries §3's fixed cap sentence verbatim,
 * `componentKey: null` — exactly what `ReadinessController`'s own docs say
 * the cap message is (§8.2).
 */
export function cappedReadinessSnapshot(
  overrides: Partial<ReadinessSnapshotResponse> = {},
): ReadinessSnapshotResponse {
  return readinessSnapshot({
    id: 'snapshot-day-1',
    computedAt: '2026-04-06T12:00:00.000Z',
    score: 33,
    stage: 'remembering',
    components: {
      coverage: { value: 0.2, weight: 0.15, contribution: 0.03 },
      recall: { value: 0.75, weight: 0.2, contribution: 0.15 },
      retention: { value: 0.28, weight: 0.2, contribution: 0.056 },
      consistency: { value: 0.428571, weight: 0.1, contribution: 0.0428571 },
      remediation: { value: 0.5, weight: 0.1, contribution: 0.05 },
      english: { value: 0, weight: 0.05, contribution: 0 },
      spoken: { value: 0, weight: 0.1, contribution: 0 },
      interview: { value: 0, weight: 0.1, contribution: 0 },
    },
    evidenceCounts: {
      coverage: { distinctQuestionsAttempted: 20, totalQuestionsInVersion: 100 },
      recall: {
        qualifyingAttempts: 20,
        correctCount: 14,
        partialCount: 2,
        incorrectCount: 4,
        skippedCount: 0,
      },
      retention: { masteredCount: 2, reviewCount: 6, totalAttemptedQuestions: 20 },
      consistency: { distinctPracticeDaysInLast14: 3 },
      remediation: { everWeakCount: 2, remediatedCount: 1 },
      english: { distinctQuestionsCorrectSpokenInEnglish: 0 },
      spoken: { attempts: 0 },
      interview: { attempts: 0 },
    },
    capReason: 'typed_only',
    topRecommendation: {
      componentKey: null,
      title: 'Get real interview practice',
      reason:
        'Your civics knowledge is strong, but you have limited interview practice. Completing two mock interviews is the best way to strengthen your readiness now.',
      path: '/practice',
    },
    ...overrides,
  });
}

/** Wrap snapshots in `GET /api/readiness/history`'s flat pagination envelope. */
export function readinessHistoryResponse(
  items: ReadinessSnapshotResponse[],
  overrides: Partial<ReadinessHistoryResponse> = {},
): ReadinessHistoryResponse {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 30,
    totalPages: 1,
    ...overrides,
  };
}
