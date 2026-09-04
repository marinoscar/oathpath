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
// sees a `userId`, a Prisma client, or a test-version code — it sees four
// already-resolved numbers and three arrays (mastery rows, recent attempt
// outcomes, and — since #141 — one entry per distinct English sentence
// attempted in the trailing window) and returns a result that is, by
// construction, reproducible from those inputs alone.
//
// `englishBestOutcomesInWindow` is the newest member of that contract and
// takes the SAME shape as `recentQualifyingAttempts` for the same reason:
// the window, the distinct-sentence grouping and the best-of reduction are
// all QUERY concerns the caller owns, while the credit table and the two
// denominators below are SCORING concerns this file owns. Neither half can
// be tested without a database if they are mixed.
//
// -----------------------------------------------------------------------------
// THE STRUCTURAL CAP (§2.9) — NO SECOND CLAMP, ANYWHERE, EVER
// -----------------------------------------------------------------------------
//
// `english` (0.05) + `spoken` (0.10) + `interview` (0.10) sum to 0.25 of the
// total weight, and all three are mathematically 0 for a learner with no
// evidence for any of them. The weighted score can therefore never exceed 75
// FOR A LEARNER WITH NONE OF THE THREE — §2.9's own wording, and worth
// keeping exactly, because since #141 that is no longer the same set of
// people as "a learner whose `capReason` is `typed_only`". English evidence
// is earnable without ever speaking a civics answer, so a capped learner who
// has it tops out at 75 + english's own 0.05 = 80, not 75. That is the
// weights table talking, not a leak: `english` is a real, continuously
// contributing component, and §6.3's instruction was to leave `capReason`
// alone, NOT to withhold the 0.05 a learner earned. A fact that falls
// directly out of the weights table below, and NOT a `min(score, 75)` step
// added on top of it. A second,
// hand-maintained ceiling constant is exactly the "two things that must
// agree but are not derived from each other" category of bug
// `journey-shell.md` and `ai-model-roles.ts` both already argue against —
// see §2.9/§11 for the rejected alternative, recorded there so a later
// reader does not "fix" this file by adding one back.
//
// `english` HAS REAL EVIDENCE SINCE #141 (epic #59 / E10) AND STILL DOES NOT
// LIFT THE CAP, which is the one thing about that epic most likely to be
// "corrected" by a later reader who notices the asymmetry and thinks it is an
// oversight. It is not: `english-test.md` §6.3 rules it out by name. Reading
// and writing English sentences is not evidence that a learner can answer a
// CIVICS question aloud, and the cap exists specifically to withhold a high
// score from a learner who has never done that. `capReason` below therefore
// still reads exactly two paths — `spoken` and `interview` — and E10 changed
// neither of them. What English evidence moves is `english`'s own 0.05
// weight, and nothing else.
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
 * What a `partial` response is worth, anywhere in this engine.
 *
 * ONE CONSTANT, TWO COMPONENTS, ON PURPOSE. `recall` (§2.2) has weighted a
 * partial at half a correct since E6; `english` (`english-test.md` §6.2)
 * credits a `partial` sentence the same, and that document is explicit that
 * the number is REUSED rather than independently chosen: both are answering
 * the identical underlying question ("how much should a not-quite-right-but-
 * not-wrong response count for"), and two components silently settling on two
 * different answers to it is exactly the drift this codebase's registries and
 * shared constants exist to prevent. Declaring it once makes that claim
 * structurally true rather than merely asserted in a comment.
 */
export const PARTIAL_ANSWER_CREDIT = 0.5;

/**
 * The two English segments (`english-test.md` §5.2), as a local string union
 * rather than Prisma's `EnglishSegmentKind` — this file imports no Prisma,
 * ever, exactly as `QualifyingOutcome` above restates `PracticeOutcome`'s
 * values instead of importing them.
 */
export type EnglishSegment = 'reading' | 'writing';

/** `english_attempts.outcome`'s three values (§5.1), restated for the same reason. */
export type EnglishSegmentOutcome = 'correct' | 'partial' | 'incorrect';

/**
 * `english-test.md` §6.2's two target denominators — how many sentences'
 * worth of credit, per segment, count as a full `1.0` for that segment.
 *
 * THEY DIFFER ON PURPOSE, AND THE DIFFERENCE IS THE DESIGN. A reading pass is
 * scored against a recogniser's transcript — a learner-confirmed one, but
 * still one imperfect step between what the learner said and what was scored
 * — while a writing pass is scored against exactly the characters the learner
 * typed, with no intermediate transformation at all. One reading pass is
 * therefore weaker evidence of the underlying skill than one writing pass, so
 * more of them are needed to reach the same confidence. §6.2's own worked
 * arithmetic, reproduced because it is the thing a reader will otherwise
 * mistake for a bug: three all-correct reading passes give
 * `min(3/6, 1) = 0.5` → `0.25` of `english`, while three all-correct WRITING
 * passes give `min(3/4, 1) = 0.75` → `0.375`. Same raw count, different
 * contribution, because the two kinds of evidence are deliberately not
 * interchangeable. Do not "fix" this into one shared denominator.
 */
export const ENGLISH_READING_TARGET = 6;
export const ENGLISH_WRITING_TARGET = 4;

/**
 * How the two segment values combine into `english` (§6.2:
 * `0.5 * readingValue + 0.5 * writingValue`) — an even split, so a learner
 * who has only ever done one segment tops out at half the component no matter
 * how much of that segment they do. Reading and writing are two separate
 * requirements of the real test, not two interchangeable ways of clearing one.
 */
const ENGLISH_SEGMENT_SHARE = 0.5;

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

  /**
   * One entry per DISTINCT `english_sentences` row this learner attempted
   * inside the trailing `ENGLISH_WINDOW_DAYS` window (`english-test.md`
   * §6.1), carrying that sentence's BEST in-window outcome — a sentence
   * attempted three times in the window, twice `incorrect` and once
   * `correct`, appears exactly once, as `correct` (§6.2).
   *
   * The caller applies the window, the distinct-sentence grouping and the
   * best-of reduction; this function applies none of the three — the same
   * division of labour `recentQualifyingAttempts` above already states for
   * its own limit and filter. An empty array is the ordinary case for most
   * learners and means `english = 0`, never "unmeasured": unlike `recall`,
   * `english` has never had a second meaning for `0` to be confused with
   * (§6.2's own closing paragraph).
   */
  englishBestOutcomesInWindow: Array<{ kind: EnglishSegment; outcome: EnglishSegmentOutcome }>;

  distinctPracticeDaysInLast14: number;
  distinctQuestionsCorrectSpoken: number;
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
  english: {
    /** Distinct sentences of each segment with any attempt in the window — the count that separates "no practice" from "practised and missed". */
    readingSentences: number;
    writingSentences: number;
    /** The credited totals §6.2's two ratios were actually taken over. Fractional by construction: a `partial` sentence adds `PARTIAL_ANSWER_CREDIT`. */
    readingCredit: number;
    writingCredit: number;
  };
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
      : safeRatio(correctCount + PARTIAL_ANSWER_CREDIT * partialCount, qualifyingAttempts);

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
 * `english-test.md` §6.2 — REAL EVIDENCE SINCE #141 (epic #59 / E10). This was
 * `min(distinctQuestionsCorrectSpokenInEnglish / 20, 1)` over a number
 * `ReadinessService` hardcoded to `0`, with `readiness-model.md` §2.6's own
 * table naming a later epic as the one that would supply it. E10 supplied it,
 * and it is not that number: `english_attempts` measures reading and writing
 * ENGLISH SENTENCES, which is a different quantity from "civics questions
 * answered aloud in English" and cannot be dressed up as one, so the formula
 * this component is scored by changed with the evidence rather than the
 * evidence being bent to fit the old formula.
 *
 * Credit each distinct in-window sentence once, at its best in-window
 * outcome — `correct` = 1, `partial` = `PARTIAL_ANSWER_CREDIT`, `incorrect` =
 * 0 — then:
 *
 *   readingValue = min(readingCredit / ENGLISH_READING_TARGET, 1)
 *   writingValue = min(writingCredit / ENGLISH_WRITING_TARGET, 1)
 *   english      = 0.5 * readingValue + 0.5 * writingValue
 *
 * A learner with no in-window attempts of either kind scores `0` with both
 * `readingSentences` and `writingSentences` reporting a true `0`, which is
 * what lets a renderer say WHICH evidence is missing ("no reading or writing
 * practice in the last 30 days") instead of showing a bare, unexplained 0%.
 * Note the two counts are what distinguishes that case from a learner who
 * practised and missed everything: both score `0`, and they are not the same
 * fact about a person.
 *
 * THIS DOES NOT LIFT THE STRUCTURAL CAP — see the file header and §6.3.
 */
function computeEnglish(evidence: ReadinessEvidence): {
  result: ReadinessComponentResult;
  counts: ReadinessEvidenceCounts['english'];
} {
  let readingSentences = 0;
  let writingSentences = 0;
  let readingCredit = 0;
  let writingCredit = 0;

  for (const sentence of evidence.englishBestOutcomesInWindow) {
    const credit =
      sentence.outcome === 'correct'
        ? 1
        : sentence.outcome === 'partial'
          ? PARTIAL_ANSWER_CREDIT
          : 0;

    if (sentence.kind === 'reading') {
      readingSentences += 1;
      readingCredit += credit;
    } else {
      writingSentences += 1;
      writingCredit += credit;
    }
  }

  const readingValue = Math.min(readingCredit / ENGLISH_READING_TARGET, 1);
  const writingValue = Math.min(writingCredit / ENGLISH_WRITING_TARGET, 1);
  const value = ENGLISH_SEGMENT_SHARE * readingValue + ENGLISH_SEGMENT_SHARE * writingValue;

  return {
    result: toResult('english', value),
    counts: { readingSentences, writingSentences, readingCredit, writingCredit },
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
  //
  // TWO PATHS, NOT THREE. `evidenceCounts.english` is deliberately absent
  // from this expression even though it now carries real counts
  // (`english-test.md` §6.3): a learner could read and write every sentence
  // in the bank perfectly and still have never once spoken a civics answer,
  // which is the exact learner the cap exists to hold under 75.
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
