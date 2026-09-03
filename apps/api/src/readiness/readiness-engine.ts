import { WEAK_LAPSES_THRESHOLD } from '../practice/mastery/selector';
import type { MasteryState } from '../practice/mastery/scheduler';

// =============================================================================
// computeReadiness (issue #122, epic #55 / E6 "Readiness and Progress")
// =============================================================================
//
// The eight-component weighted readiness score. Pure TypeScript only — no
// NestJS, no Prisma, no `Clock`, no I/O of any kind — the identical shape
// `practice/mastery/scheduler.ts`'s `nextSchedule` and
// `journey/stage-transitions.ts`'s `nextStageOnMasteryEvent` already
// establish for a rule that must produce the same output for the same input
// forever, and must be directly unit-testable, table of cases and all, with
// no database in the loop. `docs/specs/readiness-model.md` §5 is this file's
// exact, already-approved contract; every constant and formula below is
// implemented verbatim from that document, not redesigned.
//
// `WEAK_LAPSES_THRESHOLD` is imported from `practice/mastery/selector.ts`,
// never redeclared — §2.5's own instruction, and the identical one-source-
// of-truth reason every registry in this codebase gives for not maintaining
// a second copy of a number that must never drift. `MasteryState` is
// imported from `practice/mastery/scheduler.ts` for the same reason.
//
// -----------------------------------------------------------------------------
// THE CALLER ASSEMBLES THE EVIDENCE; THIS FUNCTION ONLY SCORES IT
// -----------------------------------------------------------------------------
//
// `ReadinessService` is responsible for querying Prisma and assembling
// `ReadinessEvidence`, exactly as `PracticeService` assembles a
// `MasteryRecord` before ever calling `nextSchedule`. This function never
// sees a `userId`, a Prisma client, or a test-version code — it sees eight
// already-resolved numbers (well, seven numbers and one array of mastery
// rows and one array of attempt outcomes) and returns a result that is, by
// construction, reproducible from those inputs alone.
//
// -----------------------------------------------------------------------------
// THE STRUCTURAL CAP (§2.9) — NO SECOND CLAMP, ANYWHERE, EVER
// -----------------------------------------------------------------------------
//
// `english` (0.05) + `spoken` (0.10) + `interview` (0.10) sum to 0.25 of the
// total weight, and all three are mathematically 0 for a learner with no
// evidence for any of them. The weighted score can therefore never exceed 75
// for a typed-only learner — a fact that falls directly out of the weights
// table below, and NOT a `min(score, 75)` step added on top of it. A second,
// hand-maintained ceiling constant is exactly the "two things that must
// agree but are not derived from each other" category of bug
// `journey-shell.md` and `ai-model-roles.ts` both already argue against —
// see §2.9/§11 for the rejected alternative, recorded there so a later
// reader does not "fix" this file by adding one back.
// =============================================================================

/**
 * The eight readiness components, in the exact order §2's table declares
 * them. The order is load-bearing beyond readability: it is the tie-break
 * order §8's top recommendation reads when two components have identical
 * weighted headroom, and it is the order `evidenceCounts`/`components` are
 * expected to iterate in on any client that renders them as a list.
 */
export type ReadinessComponentKey =
  | 'coverage'
  | 'recall'
  | 'retention'
  | 'consistency'
  | 'remediation'
  | 'english'
  | 'spoken'
  | 'interview';

/** §2's table, in `ReadinessComponentKey` order — the sole place a weight is declared. */
export const READINESS_COMPONENT_KEYS: readonly ReadinessComponentKey[] = [
  'coverage',
  'recall',
  'retention',
  'consistency',
  'remediation',
  'english',
  'spoken',
  'interview',
];

const READINESS_WEIGHTS: Record<ReadinessComponentKey, number> = {
  coverage: 0.15,
  recall: 0.2,
  retention: 0.2,
  consistency: 0.1,
  remediation: 0.1,
  english: 0.05,
  spoken: 0.1,
  interview: 0.1,
};

/** The two outcomes `recall` (§2.2) reads other than `correct`/`skipped`. */
type QualifyingOutcome = 'correct' | 'partial' | 'incorrect' | 'skipped';

/**
 * §2.2's evidence floor: below this many qualifying attempts, `recall`'s
 * value is `0` rather than a percentage finer than this floor's own
 * `0.5`-weighted partial credit can honestly produce. Exported so a reader
 * of `evidenceCounts.recall.qualifyingAttempts` elsewhere (the Progress
 * Guide prompt, issue #134) can render the identical "not enough evidence
 * yet" reading this engine already applies, rather than a second
 * hand-copied `5`.
 */
export const RECALL_MIN_QUALIFYING_ATTEMPTS = 5;

/**
 * Everything `computeReadiness` needs, already resolved from Prisma by the
 * caller. §5's exact shape.
 */
export interface ReadinessEvidence {
  totalQuestionsInVersion: number;

  /** One per `question_mastery` row for this user+version. */
  masteryRows: Array<{ state: MasteryState; lapses: number }>;

  /**
   * The most recent 20 `practice_attempts` rows where `hintUsed = false AND
   * revealed = false`, already limited and filtered by the caller — this
   * function applies neither the limit nor the filter itself (§5).
   */
  recentQualifyingAttempts: Array<{ outcome: QualifyingOutcome }>;

  distinctPracticeDaysInLast14: number;
  distinctQuestionsCorrectSpoken: number;
  distinctQuestionsCorrectSpokenInEnglish: number;
  mockInterviewsPassed: number;
}

export interface ReadinessComponentResult {
  /** Normalized [0, 1] — §2's formula column. */
  value: number;
  /** This component's weight — §2's weight column, copied onto the result so a reader never has to cross-reference the table. */
  weight: number;
  /** `value * weight` — what this component actually added to the score. */
  contribution: number;
}

/** §3 — becomes `'typed_only'` the instant both `spoken` and `interview` evidence read zero attempts. */
export type CapReason = 'typed_only' | null;

/** §5's `evidenceCounts` shape — the raw counts each component's `value` was computed from. */
export interface ReadinessEvidenceCounts {
  coverage: { distinctQuestionsAttempted: number; totalQuestionsInVersion: number };
  recall: {
    qualifyingAttempts: number;
    correctCount: number;
    partialCount: number;
    incorrectCount: number;
    skippedCount: number;
  };
  retention: { masteredCount: number; reviewCount: number; totalAttemptedQuestions: number };
  consistency: { distinctPracticeDaysInLast14: number };
  remediation: { everWeakCount: number; remediatedCount: number };
  english: { distinctQuestionsCorrectSpokenInEnglish: number };
  spoken: { attempts: number };
  interview: { attempts: number };
}

export interface ReadinessResult {
  /** 0-100, `round(sum(contribution) * 100)`. */
  score: number;
  components: Record<ReadinessComponentKey, ReadinessComponentResult>;
  evidenceCounts: ReadinessEvidenceCounts;
  capReason: CapReason;
}

/** `numerator / denominator`, or `0` when the denominator is `0` — never `NaN`. */
function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function toResult(key: ReadinessComponentKey, value: number): ReadinessComponentResult {
  const weight = READINESS_WEIGHTS[key];
  return { value, weight, contribution: value * weight };
}

/**
 * §2.1 — how much of the bank this learner has even touched. "Attempted"
 * means "has a `question_mastery` row" — a question with no row has never
 * produced a schedulable outcome, per `memory-model.md`'s own
 * absence-is-the-default idiom.
 */
function computeCoverage(evidence: ReadinessEvidence): {
  result: ReadinessComponentResult;
  counts: ReadinessEvidenceCounts['coverage'];
} {
  const distinctQuestionsAttempted = evidence.masteryRows.length;
  const value = safeRatio(distinctQuestionsAttempted, evidence.totalQuestionsInVersion);
  return {
    result: toResult('coverage', value),
    counts: {
      distinctQuestionsAttempted,
      totalQuestionsInVersion: evidence.totalQuestionsInVersion,
    },
  };
}

/**
 * §2.2 — the evidence floor. Over the caller's already-filtered, already-
 * limited most-recent-20 unassisted attempts: `(correctCount +
 * 0.5·partialCount) / qualifyingCount`. **If fewer than 5 qualifying
 * attempts exist, the value is `0`, but `evidenceCounts.recall
 * .qualifyingAttempts` still reports the true, low count** — never `0`
 * standing in for "unmeasured".
 */
function computeRecall(evidence: ReadinessEvidence): {
  result: ReadinessComponentResult;
  counts: ReadinessEvidenceCounts['recall'];
} {
  let correctCount = 0;
  let partialCount = 0;
  let incorrectCount = 0;
  let skippedCount = 0;

  for (const attempt of evidence.recentQualifyingAttempts) {
    switch (attempt.outcome) {
      case 'correct':
        correctCount += 1;
        break;
      case 'partial':
        partialCount += 1;
        break;
      case 'incorrect':
        incorrectCount += 1;
        break;
      case 'skipped':
        skippedCount += 1;
        break;
    }
  }

  const qualifyingAttempts = evidence.recentQualifyingAttempts.length;
  const value =
    qualifyingAttempts < RECALL_MIN_QUALIFYING_ATTEMPTS
      ? 0
      : safeRatio(correctCount + 0.5 * partialCount, qualifyingAttempts);

  return {
    result: toResult('recall', value),
    counts: { qualifyingAttempts, correctCount, partialCount, incorrectCount, skippedCount },
  };
}

/**
 * §2.3 — how much of what's been touched has actually stuck:
 * `(masteredCount·1.0 + reviewCount·0.6) / totalAttemptedQuestions`, over
 * `question_mastery` rows only. `lapsed` and `learning` rows contribute `0`
 * to the numerator (still counted in the denominator, via
 * `totalAttemptedQuestions`) — a `lapsed` row is a *former* `review`/
 * `mastered` row that regressed, and crediting it here would let a
 * once-forgotten question still count toward "how much has stuck".
 */
function computeRetention(evidence: ReadinessEvidence): {
  result: ReadinessComponentResult;
  counts: ReadinessEvidenceCounts['retention'];
} {
  let masteredCount = 0;
  let reviewCount = 0;

  for (const row of evidence.masteryRows) {
    if (row.state === 'mastered') masteredCount += 1;
    else if (row.state === 'review') reviewCount += 1;
  }

  const totalAttemptedQuestions = evidence.masteryRows.length;
  const value = safeRatio(masteredCount * 1.0 + reviewCount * 0.6, totalAttemptedQuestions);

  return {
    result: toResult('retention', value),
    counts: { masteredCount, reviewCount, totalAttemptedQuestions },
  };
}

/**
 * §2.4 — `min(distinctPracticeDaysInLast14, 7) / 7`, a rolling 14-day
 * window read only from `practice_attempts.answeredAt` — never from
 * `daily_activity`, a streak counter, or a points total, per
 * `ROADMAP.md` §7's "Engagement never moves readiness" rule.
 */
function computeConsistency(evidence: ReadinessEvidence): {
  result: ReadinessComponentResult;
  counts: ReadinessEvidenceCounts['consistency'];
} {
  const value = Math.min(evidence.distinctPracticeDaysInLast14, 7) / 7;
  return {
    result: toResult('consistency', value),
    counts: { distinctPracticeDaysInLast14: evidence.distinctPracticeDaysInLast14 },
  };
}

/**
 * §2.5 — `remediatedCount / everWeakCount`, over every `question_mastery`
 * row that has ever had `lapses >= WEAK_LAPSES_THRESHOLD` (imported, never
 * redeclared). "Remediated" means the row's *current* `state` is `review`
 * or `mastered`. **If `everWeakCount === 0`, the value is `1.0`** — full
 * credit, not `0`: there is nothing to remediate, so there is nothing to be
 * penalized for not having remediated.
 */
function computeRemediation(evidence: ReadinessEvidence): {
  result: ReadinessComponentResult;
  counts: ReadinessEvidenceCounts['remediation'];
} {
  let everWeakCount = 0;
  let remediatedCount = 0;

  for (const row of evidence.masteryRows) {
    if (row.lapses >= WEAK_LAPSES_THRESHOLD) {
      everWeakCount += 1;
      if (row.state === 'review' || row.state === 'mastered') {
        remediatedCount += 1;
      }
    }
  }

  const value = everWeakCount === 0 ? 1.0 : remediatedCount / everWeakCount;

  return {
    result: toResult('remediation', value),
    counts: { everWeakCount, remediatedCount },
  };
}

/**
 * §2.6 — declared now, zero evidence until E11. `min(distinctQuestions
 * CorrectSpokenInEnglish / 20, 1)`.
 */
function computeEnglish(evidence: ReadinessEvidence): {
  result: ReadinessComponentResult;
  counts: ReadinessEvidenceCounts['english'];
} {
  const value = Math.min(evidence.distinctQuestionsCorrectSpokenInEnglish / 20, 1);
  return {
    result: toResult('english', value),
    counts: {
      distinctQuestionsCorrectSpokenInEnglish: evidence.distinctQuestionsCorrectSpokenInEnglish,
    },
  };
}

/**
 * §2.7 — declared now, zero evidence until E9 wires `inputMode: 'spoken'`.
 * `min(distinctQuestionsCorrectSpoken / 20, 1)`.
 */
function computeSpoken(evidence: ReadinessEvidence): {
  result: ReadinessComponentResult;
  counts: ReadinessEvidenceCounts['spoken'];
} {
  const value = Math.min(evidence.distinctQuestionsCorrectSpoken / 20, 1);
  return {
    result: toResult('spoken', value),
    counts: { attempts: evidence.distinctQuestionsCorrectSpoken },
  };
}

/**
 * §2.8 — declared now, zero evidence until E8 wires `source: 'mock_interview'`.
 * `min(mockInterviewsPassed / 2, 1)` — the `2` is `PRD.md`'s own worked
 * example, not this engine's choice.
 */
function computeInterview(evidence: ReadinessEvidence): {
  result: ReadinessComponentResult;
  counts: ReadinessEvidenceCounts['interview'];
} {
  const value = Math.min(evidence.mockInterviewsPassed / 2, 1);
  return {
    result: toResult('interview', value),
    counts: { attempts: evidence.mockInterviewsPassed },
  };
}

/**
 * The eight-component weighted readiness score (`docs/specs/
 * readiness-model.md` §2, §5). PURE: same inputs, same output, forever.
 */
export function computeReadiness(evidence: ReadinessEvidence): ReadinessResult {
  const coverage = computeCoverage(evidence);
  const recall = computeRecall(evidence);
  const retention = computeRetention(evidence);
  const consistency = computeConsistency(evidence);
  const remediation = computeRemediation(evidence);
  const english = computeEnglish(evidence);
  const spoken = computeSpoken(evidence);
  const interview = computeInterview(evidence);

  const components: Record<ReadinessComponentKey, ReadinessComponentResult> = {
    coverage: coverage.result,
    recall: recall.result,
    retention: retention.result,
    consistency: consistency.result,
    remediation: remediation.result,
    english: english.result,
    spoken: spoken.result,
    interview: interview.result,
  };

  const evidenceCounts: ReadinessEvidenceCounts = {
    coverage: coverage.counts,
    recall: recall.counts,
    retention: retention.counts,
    consistency: consistency.counts,
    remediation: remediation.counts,
    english: english.counts,
    spoken: spoken.counts,
    interview: interview.counts,
  };

  const weightedSum = READINESS_COMPONENT_KEYS.reduce(
    (sum, key) => sum + components[key].contribution,
    0,
  );

  // §3 — the cap lifts the instant EITHER kind of evidence is credited at
  // all, even once. Read from the two `evidenceCounts` paths named
  // `attempts` specifically so a reader can find the cap's own inputs
  // without also knowing which components they happen to feed.
  const capReason: CapReason =
    evidenceCounts.spoken.attempts === 0 && evidenceCounts.interview.attempts === 0
      ? 'typed_only'
      : null;

  return {
    score: Math.round(weightedSum * 100),
    components,
    evidenceCounts,
    capReason,
  };
}
