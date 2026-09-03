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
  readinessTrendText,
  findPreviousReadinessScore,
} from '../../../components/progress/readiness';
import { readinessSnapshot, cappedReadinessSnapshot } from '../../utils/readiness-fixtures';
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
