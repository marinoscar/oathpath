/**
 * The pure readiness helpers — `components/progress/readiness.ts`.
 *
 * Issue #139, epic #55 / E6.
 */

import { describe, it, expect } from 'vitest';

import {
  READINESS_COMPONENT_ORDER,
  UNWIRED_READINESS_COMPONENTS,
  readinessHasNoEvidence,
  readinessEnglishSentencesAttempted,
  readinessTrendText,
  findPreviousReadinessScore,
} from '../../../components/progress/readiness';
import {
  readinessSnapshot,
  cappedReadinessSnapshot,
  englishPractisedReadinessSnapshot,
  legacyEnglishReadinessSnapshot,
} from '../../utils/readiness-fixtures';
import type { ReadinessEvidenceCounts } from '../../../types';

describe('READINESS_COMPONENT_ORDER', () => {
  it("matches docs/specs/readiness-model.md §2's declared order", () => {
    expect(READINESS_COMPONENT_ORDER).toEqual([
      'coverage',
      'recall',
      'retention',
      'consistency',
      'remediation',
      'english',
      'spoken',
      'interview',
    ]);
  });
});

describe('readinessHasNoEvidence', () => {
  const zeroCounts: ReadinessEvidenceCounts = cappedReadinessSnapshot().evidenceCounts;
  const someCounts: ReadinessEvidenceCounts = readinessSnapshot().evidenceCounts;

  it('is true for english/spoken/interview when their evidence counts are zero', () => {
    for (const key of UNWIRED_READINESS_COMPONENTS) {
      expect(readinessHasNoEvidence(key, zeroCounts)).toBe(true);
    }
  });

  it('is false the instant credited evidence exists, even one attempt', () => {
    // The Day 3 fixture has one credited interview; `interview` alone stops
    // reading as "no evidence" while `spoken`/`english` (still 0) do not.
    expect(readinessHasNoEvidence('interview', someCounts)).toBe(false);
    expect(readinessHasNoEvidence('spoken', someCounts)).toBe(true);
    expect(readinessHasNoEvidence('english', someCounts)).toBe(true);
  });

  it('is always false for a currently-earnable component, regardless of its value', () => {
    for (const key of ['coverage', 'recall', 'retention', 'consistency', 'remediation'] as const) {
      expect(readinessHasNoEvidence(key, zeroCounts)).toBe(false);
    }
  });

  it('separates "practised and missed" from "no practice yet" for english', () => {
    // Both score `english` at 0 credit. Only the second is an absence of
    // evidence; telling the first learner "No evidence yet" would deny four
    // sentences they actually attempted (`english-test.md` §6.2).
    const practised = englishPractisedReadinessSnapshot().evidenceCounts;

    expect(readinessHasNoEvidence('english', practised)).toBe(false);
    expect(readinessHasNoEvidence('english', zeroCounts)).toBe(true);
  });

  it("reads a pre-E10 history row's legacy english shape as no evidence", () => {
    // `GET /api/readiness/history` never recomputes, so this shape is still
    // served for snapshots written before E10 — and it only ever counted
    // civics answers spoken in English, always 0.
    const legacy = legacyEnglishReadinessSnapshot().evidenceCounts;

    expect(readinessHasNoEvidence('english', legacy)).toBe(true);
  });
});

describe('readinessEnglishSentencesAttempted', () => {
  it('sums reading and writing sentences, credit-independently', () => {
    expect(
      readinessEnglishSentencesAttempted(englishPractisedReadinessSnapshot().evidenceCounts.english),
    ).toBe(4);
    expect(
      readinessEnglishSentencesAttempted(readinessSnapshot().evidenceCounts.english),
    ).toBe(0);
  });

  it('resolves the legacy shape to 0 rather than NaN or a crash', () => {
    expect(
      readinessEnglishSentencesAttempted(legacyEnglishReadinessSnapshot().evidenceCounts.english),
    ).toBe(0);
  });
});

describe('readinessTrendText', () => {
  it('returns null with no prior score — never a fabricated single-point trend', () => {
    expect(readinessTrendText(65, null)).toBeNull();
    expect(readinessTrendText(65, undefined)).toBeNull();
  });

  it('reports an increase', () => {
    expect(readinessTrendText(65, 59)).toBe('Up 6 points since your last check.');
  });

  it('reports a decrease', () => {
    expect(readinessTrendText(50, 59)).toBe('Down 9 points since your last check.');
  });

  it('reports no change, honestly, rather than omitting it', () => {
    expect(readinessTrendText(59, 59)).toBe('No change since your last check.');
  });

  it('singularizes exactly one point', () => {
    expect(readinessTrendText(60, 59)).toBe('Up 1 point since your last check.');
    expect(readinessTrendText(58, 59)).toBe('Down 1 point since your last check.');
  });
});

describe('findPreviousReadinessScore', () => {
  it('finds the first history row that is not the current snapshot', () => {
    const current = readinessSnapshot({ id: 'current', score: 65 });
    const previous = readinessSnapshot({ id: 'previous', score: 59 });

    expect(findPreviousReadinessScore(current, [current, previous])).toBe(59);
    expect(findPreviousReadinessScore(current, [previous])).toBe(59);
  });

  it('returns null when the current snapshot is the only history row', () => {
    const current = readinessSnapshot({ id: 'current', score: 65 });

    expect(findPreviousReadinessScore(current, [current])).toBeNull();
    expect(findPreviousReadinessScore(current, [])).toBeNull();
  });
});
