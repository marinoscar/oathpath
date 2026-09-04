import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type JourneyStage, type ReadinessSnapshot } from '@prisma/client';

import { AiDispatchService, type AiRunResult } from '../ai/ai-dispatch.service';
import { Clock } from '../common/clock/clock';
import { nextStageOnReadinessSnapshot } from '../journey/readiness-stage-transitions';
import { PrismaService } from '../prisma/prisma.service';
import { buildProgressGuidePrompt } from './progress-guide-prompt';
import {
  computeReadiness,
  type EnglishSegment,
  type EnglishSegmentOutcome,
  type ReadinessEvidence,
  type ReadinessResult,
} from './readiness-engine';
import { buildTopRecommendation, type ReadinessTopRecommendation } from './top-recommendation';
import type { ReadinessSnapshotResponse } from './dto/readiness-snapshot.dto';

// =============================================================================
// ReadinessService (issue #122, epic #55 / E6 "Readiness and Progress")
// =============================================================================
//
// `docs/specs/readiness-model.md` §5-§8. Assembles `ReadinessEvidence` from
// Prisma, calls the pure `computeReadiness` engine, decides a possible stage
// transition and the top recommendation, and persists the result as a new
// `readiness_snapshots` row.
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES A `userId` THAT CAME FROM `@CurrentUser('id')`
// -----------------------------------------------------------------------------
//
// The same posture `JourneyService`, `PracticeService` and `ProgressService`
// already take (their own file headers state it): no method here takes a
// user id from anywhere else, because `ReadinessController` has no
// parameter that could carry one. Every authenticated learner owns their
// own readiness data; no "read any learner's readiness" method exists here
// for a future controller to reach for.
//
// -----------------------------------------------------------------------------
// NOTHING IN THIS FILE CONSTRUCTS A BARE `Date`
// -----------------------------------------------------------------------------
//
// Every notion of "now" comes from the injected `Clock` — `computedAt`, and
// the 14-day consistency window. `calendarDateOf`/`dayIndexOf` below are the
// identical pure helpers `journey.service.ts` already establishes for
// reducing an INSTANT THE DATABASE HANDED US to a calendar day: they read no
// clock of their own, and the one window boundary derived from "now" is
// derived from `this.clock.now()`, never a bare `new Date()`.
//
// -----------------------------------------------------------------------------
// THE EVIDENCE SOURCES THE SCHEMA DID NOT YET SUPPORT (§10's honesty rule)
// -----------------------------------------------------------------------------
//
// THIS SECTION IS NOW EMPTY, AND THAT IS THE POINT — every one of the eight
// components is computed from rows that actually exist. It is kept, rather
// than deleted, as the record of how the two literal zeros left here by E6
// were discharged, because the discipline that produced them is the reusable
// part: a component with no evidence source reads a hardcoded `0` with a
// comment naming what would have to exist to change that, and is NEVER faked
// or inferred from a proxy in the meantime.
//
// `mockInterviewsPassed` (interview, §2.8) was the first: #133 (epic #57 /
// E8) shipped `mock_interviews`, the grouping key its literal-zero comment
// was waiting for, and it became a real count of completed, passed
// interviews. `computeInterview` did not change — it always read whatever
// number it was handed; that epic only stopped the number being hardcoded.
//
// `english` (§2.6) was the second, and it discharged differently, in a way
// worth recording: its comment said `practice_attempts` had no language
// column, so there was no honest way to say a spoken-correct attempt was in
// English, and named a future epic as the one that would add it. #141 (epic
// #59 / E10) did not add that column. It shipped `english_attempts`, a table
// measuring a DIFFERENT quantity — sentences read aloud and sentences typed
// from dictation — and `english-test.md` §6.2 rescored the component around
// that evidence instead of bending the evidence to fit the old
// `min(distinctQuestionsCorrectSpokenInEnglish / 20, 1)` formula. So the
// evidence field this service assembles changed shape too; see
// {@link assembleEvidence}. The honest-zero discipline is what made that
// possible: nothing downstream had ever been told a proxy was the real thing.
// =============================================================================

/** Milliseconds in a calendar day. Pure arithmetic on an already-resolved instant, never a clock read of its own. */
const MS_PER_DAY = 86_400_000;

/** How many calendar days back `consistency`'s (§2.4) rolling window looks, inclusive of today. */
const CONSISTENCY_WINDOW_DAYS = 14;

/**
 * `english`'s trailing window (`english-test.md` §6.1). THE WINDOW IS THE
 * DECAY: there is no half-life curve, no stored freshness value, and no
 * "ever" fallback — an attempt older than this simply stops counting, exactly
 * as a practice day ages out of `consistency`'s 14.
 *
 * WHY 30 AND NOT `consistency`'s 14, since the two sit three lines apart and
 * the difference will otherwise look arbitrary: a Quick 5 touches five civics
 * questions in one sitting, while a reading or writing segment is a much
 * smaller, more occasional slice of a learner's routine. At 14 days this
 * would zero out a learner who did solid English practice three weeks ago and
 * has been on civics review since — a claim that they cannot currently
 * produce this evidence, which would be false; the evidence exists, it is
 * merely outside an unnecessarily tight window. 30 is still ROLLING, not
 * "ever": one English session six months ago earns nothing today.
 *
 * MEASURED IN INSTANTS, NOT CALENDAR DAYS, unlike `consistency` — and that is
 * a real difference, not an inconsistency to tidy up. `consistency` COUNTS
 * DISTINCT DAYS, so it must know which local day an instant fell on and needs
 * the learner's timezone to say. `english` counts distinct SENTENCES and
 * never buckets anything by day, so a plain 30×24h boundary off `Clock.now()`
 * is the whole of the window arithmetic it needs; introducing a timezone here
 * would add a moving part with nothing to move.
 */
const ENGLISH_WINDOW_DAYS = 30;

/**
 * "Best" for §6.2's best-in-window reduction, as an explicit total order.
 *
 * Ordinal rather than a chain of comparisons so the rule is one line to read
 * and one line to change: `correct` beats `partial` beats `incorrect`, which
 * is the same ordering the credit table in `computeEnglish` assigns values to
 * — but this is a ranking, not a copy of those values, and must not be
 * "simplified" into reusing them. Credit is what an outcome is worth to the
 * score; rank is only which of two outcomes is the better one. They agree
 * today and are free to stop agreeing (a fourth outcome, a re-weighted
 * partial) without either one silently changing the other.
 */
const ENGLISH_OUTCOME_RANK: Record<EnglishSegmentOutcome, number> = {
  incorrect: 0,
  partial: 1,
  correct: 2,
};

/**
 * The role the Progress Guide narrative (issue #134, §9) spends the
 * learner's key on.
 *
 * `tutor`, matching `civics-explain.service.ts`'s own `TUTOR_ROLE` — a short,
 * personal explanatory paragraph is exactly that role's job, and a
 * REGISTRY KEY (`ai/ai-model-roles.ts`) persisted on every `ai_usage_events`
 * row is what lets an admin tell narrative spend from explanation spend
 * apart on that table.
 */
const PROGRESS_GUIDE_ROLE = 'tutor' as const;

/**
 * The generation cap for one Progress Guide paragraph.
 *
 * A COST CEILING, NOT THE SHAPE OF THE ANSWER — see
 * `civics-explain.service.ts`'s own `EXPLAIN_MAX_TOKENS` for the identical
 * reasoning. This paragraph is shorter by design (three to five sentences,
 * §9's own prompt), so the cap is tighter too: generous enough that a
 * well-behaved model never brushes against it, tight enough to bound the bill
 * on one that does.
 */
const PROGRESS_GUIDE_MAX_TOKENS = 400;

/** A generous buffer added to the 14-day query bound so a timezone offset near the edge can never clip a real day out of the window before the exact, timezone-aware filter runs in JS. */
const CONSISTENCY_QUERY_BUFFER_DAYS = 3;

/**
 * An instant as the calendar day it fell on in `timeZone`, `YYYY-MM-DD`.
 *
 * Pure function of the instant handed to it — always a value Postgres
 * returned (`practice_attempts.answered_at`), never one this module made
 * up. The identical construction `journey.service.ts`'s own `calendarDateOf`
 * uses, for the identical reason: it reads no clock at all, so it lives
 * beside its one caller rather than on `Clock` itself.
 */
function calendarDateOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    /* istanbul ignore next -- Intl always emits the parts we requested */
    if (!found) {
      throw new Error(`Intl did not return a "${type}" part for ${timeZone}`);
    }
    return found.value;
  };

  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** A `YYYY-MM-DD` string as a day number: days since the Unix epoch. Pure. */
function dayIndexOf(calendarDate: string): number {
  const [year, month, day] = calendarDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

export interface ReadinessPage {
  items: ReadinessSnapshotResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * A `readiness_snapshots` Prisma row → the wire shape
 * `readiness-snapshot.dto.ts` declares. `components`/`evidenceCounts`/
 * `topRecommendation` are cast straight through: the engine and
 * `buildTopRecommendation` already produced exactly this shape before this
 * row was ever written (`recomputeSnapshot` below), so there is no second
 * derivation here — only the `Json` columns' loosened Prisma type is
 * narrowed back to the concrete shape this service knows they hold.
 */
function toSnapshotResponse(snapshot: ReadinessSnapshot): ReadinessSnapshotResponse {
  return {
    id: snapshot.id,
    computedAt: snapshot.computedAt.toISOString(),
    score: snapshot.score,
    stage: snapshot.stage,
    components: snapshot.components as unknown as ReadinessSnapshotResponse['components'],
    evidenceCounts:
      snapshot.evidenceCounts as unknown as ReadinessSnapshotResponse['evidenceCounts'],
    capReason: snapshot.capReason as ReadinessSnapshotResponse['capReason'],
    topRecommendation:
      snapshot.topRecommendation as unknown as ReadinessSnapshotResponse['topRecommendation'],
    narrative: snapshot.narrative,
    narrativeGeneratedAt: snapshot.narrativeGeneratedAt
      ? snapshot.narrativeGeneratedAt.toISOString()
      : null,
  };
}

/**
 * A `readiness_snapshots` Prisma row → the `ReadinessResult` shape
 * `buildProgressGuidePrompt` (§9) reads. The identical cast
 * `toSnapshotResponse` above already performs on the same three `Json`/
 * nullable columns — this is a second, narrower reader of the same row for a
 * different consumer, not a second derivation: the values themselves were
 * produced once, by `computeReadiness`, before this row was ever written.
 */
function toReadinessResultForPrompt(snapshot: ReadinessSnapshot): ReadinessResult {
  return {
    score: snapshot.score,
    components: snapshot.components as unknown as ReadinessResult['components'],
    evidenceCounts: snapshot.evidenceCounts as unknown as ReadinessResult['evidenceCounts'],
    capReason: snapshot.capReason as ReadinessResult['capReason'],
  };
}

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    // The Progress Guide narrative's one door (issue #134, §9). Reached ONLY
    // from `ensureNarrative`, which is reached ONLY from the request-path
    // `getLatestOrRecompute` — never from `recomputeAllActiveUsers`/the
    // nightly cron. See that method's own header for why.
    private readonly dispatch: AiDispatchService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * The caller's latest snapshot, computing and persisting one first if none
   * exists yet, or the latest is stale — an existing snapshot older than the
   * caller's most recent `practice_attempts.answeredAt` (§6). A snapshot the
   * nightly cron just produced is never stale by this rule: it reflects
   * every attempt that existed at the moment it ran, so a `GET` immediately
   * after finds nothing newer to react to.
   */
  async getLatestOrRecompute(userId: string): Promise<ReadinessSnapshotResponse> {
    const latest = await this.prisma.readinessSnapshot.findFirst({
      where: { userId },
      orderBy: { computedAt: 'desc' },
    });

    if (!latest) {
      const snapshot = await this.computeAndPersistSnapshot(userId);
      return toSnapshotResponse(await this.ensureNarrative(snapshot));
    }

    const mostRecentAttempt = await this.prisma.practiceAttempt.findFirst({
      where: { userId },
      orderBy: { answeredAt: 'desc' },
      select: { answeredAt: true },
    });

    const isStale =
      mostRecentAttempt !== null &&
      mostRecentAttempt.answeredAt.getTime() > latest.computedAt.getTime();

    const snapshot = isStale ? await this.computeAndPersistSnapshot(userId) : latest;

    // §9: attempted on EVERY request-path read whose snapshot has no
    // narrative yet — not only a freshly recomputed one. A snapshot an
    // earlier request already found `unavailable` for (no key configured
    // then) is exactly the "a client can re-request the same snapshot a
    // moment later once it's populated" case the spec names; `ensureNarrative`
    // itself is the only gate (`narrative === null`), so this is a no-op read
    // the instant a narrative already exists.
    return toSnapshotResponse(await this.ensureNarrative(snapshot));
  }

  /** Paginated snapshot history, newest first — the same `page`/`pageSize` shape `PracticeService.listSessions` already uses. */
  async getHistory(
    userId: string,
    pagination: { page: number; pageSize: number },
  ): Promise<ReadinessPage> {
    const { page, pageSize } = pagination;

    const [rows, total] = await Promise.all([
      this.prisma.readinessSnapshot.findMany({
        where: { userId },
        orderBy: { computedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.readinessSnapshot.count({ where: { userId } }),
    ]);

    return {
      items: rows.map(toSnapshotResponse),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Assemble this caller's evidence, score it, decide a possible stage
   * transition and the top recommendation, and persist a new snapshot row.
   *
   * The snapshot write and the (possible) `learner_profiles.stage` write
   * happen inside one `$transaction`: a snapshot recorded without its stage
   * consequence reaching the learner's own journey state would be exactly
   * the gap `PracticeService.scheduleMastery`'s own header already refuses
   * for E5's per-attempt transition, and the reasoning applies identically
   * here.
   */
  async recomputeSnapshot(userId: string): Promise<ReadinessSnapshotResponse> {
    const snapshot = await this.computeAndPersistSnapshot(userId);
    return toSnapshotResponse(snapshot);
  }

  /**
   * The raw Prisma row half of {@link recomputeSnapshot} — everything that
   * method does, minus the final conversion to the wire shape.
   *
   * SPLIT OUT SPECIFICALLY so `getLatestOrRecompute` can hand the row it just
   * wrote (or the existing latest row it read) to {@link ensureNarrative}
   * before ever converting to `ReadinessSnapshotResponse` — `narrative` and
   * `narrativeGeneratedAt` are columns on the row, not fields
   * `toSnapshotResponse` could patch in after the fact without a second
   * Prisma shape to reconcile. `recomputeSnapshot` (this method's only other
   * caller — the public API and the nightly cron) is otherwise unchanged: it
   * still never touches AI.
   */
  private async computeAndPersistSnapshot(userId: string): Promise<ReadinessSnapshot> {
    const profile = await this.prisma.learnerProfile.findUnique({
      where: { userId },
      select: { stage: true },
    });

    const currentStage: JourneyStage = profile?.stage ?? 'uncertain';

    const evidence = await this.assembleEvidence(userId);
    const result = computeReadiness(evidence);
    const nextStage = nextStageOnReadinessSnapshot(currentStage, result.score, result.capReason);
    const topRecommendation: ReadinessTopRecommendation = buildTopRecommendation(result);
    const computedAt = this.clock.now();

    const snapshot = await this.prisma.$transaction(async (tx) => {
      const created = await tx.readinessSnapshot.create({
        data: {
          userId,
          computedAt,
          score: result.score,
          stage: nextStage ?? currentStage,
          components: result.components as unknown as Prisma.InputJsonValue,
          evidenceCounts: result.evidenceCounts as unknown as Prisma.InputJsonValue,
          capReason: result.capReason,
          topRecommendation: topRecommendation as unknown as Prisma.InputJsonValue,
        },
      });

      // Guarded on the row existing (and only attempted at all when
      // `nextStage` is genuinely new) for the same reason
      // `scheduleMastery`'s identical guard states: a profile-less user can
      // never produce a non-null transition in the first place, since
      // `nextStageOnReadinessSnapshot` only ever fires from `remembering`,
      // `practicing` or `performing` — none of which `currentStage`'s
      // `?? 'uncertain'` fallback can be.
      if (nextStage !== null && nextStage !== currentStage) {
        await tx.learnerProfile.update({
          where: { userId },
          data: { stage: nextStage },
        });
      }

      return created;
    });

    this.logger.log(
      { userId, score: result.score, stage: snapshot.stage, capReason: result.capReason },
      'Readiness snapshot computed',
    );

    return snapshot;
  }

  // ---------------------------------------------------------------------------
  // Progress Guide narrative (issue #134, §9)
  // ---------------------------------------------------------------------------

  /**
   * Fill in a snapshot's `narrative`/`narrativeGeneratedAt` when it has none
   * yet, on the calling user's own AI key. NEVER THROWS, and NEVER BLOCKS the
   * `GET /api/readiness` response it is called from — every path out of this
   * method returns a `ReadinessSnapshot`, whether or not a narrative was
   * actually produced.
   *
   * REQUEST-PATH ONLY. Called from `getLatestOrRecompute` alone —
   * `computeAndPersistSnapshot`/`recomputeAllActiveUsers` (the nightly cron's
   * own entry point, §7(b)) never call this, because a user's BYOK key is not
   * available outside a request from that user (`ROADMAP.md` §7, quoted in
   * `readiness-recompute.task.ts`'s own header). Widening that boundary is a
   * design change to make deliberately, not a refactor to fall into.
   *
   * A NO-OP THE INSTANT A NARRATIVE ALREADY EXISTS — the one gate this method
   * itself enforces, so a caller never has to check `narrative === null`
   * before reaching for it.
   */
  async ensureNarrative(snapshot: ReadinessSnapshot): Promise<ReadinessSnapshot> {
    if (snapshot.narrative !== null) {
      return snapshot;
    }

    let run: AiRunResult;
    try {
      const messages = buildProgressGuidePrompt(toReadinessResultForPrompt(snapshot));
      run = await this.dispatch.run(snapshot.userId, PROGRESS_GUIDE_ROLE, {
        messages,
        maxTokens: PROGRESS_GUIDE_MAX_TOKENS,
      });
    } catch (error) {
      // DEFENSIVE ONLY. `AiDispatchService.run` never throws for an AI
      // reason (`CLAUDE.md`'s "Adding an AI feature", step 3) — this catch
      // exists purely so a genuinely unexpected error in this file's own
      // prompt-building or in the dispatcher's plumbing can never turn a
      // narrative attempt into a 500 on `GET /api/readiness`. The snapshot
      // itself is a complete, useful row with or without a narrative (§4),
      // so the honest response here is the one the caller already had.
      this.logger.warn(
        {
          userId: snapshot.userId,
          snapshotId: snapshot.id,
          error: error instanceof Error ? error.message : error,
        },
        'Progress Guide narrative generation threw unexpectedly; snapshot returned without one',
      );
      return snapshot;
    }

    switch (run.status) {
      case 'ok':
        return this.prisma.readinessSnapshot.update({
          where: { id: snapshot.id },
          data: { narrative: run.text, narrativeGeneratedAt: this.clock.now() },
        });

      case 'unavailable':
        // NOT LOGGED. An administrator who has not finished configuring AI,
        // or a learner with no personal key, is the common, expected state of
        // most deployments and most learners today — logging it here would
        // be noise on every `GET /api/readiness` a keyless learner ever
        // makes. `narrative` stays `null`, absent without complaint, exactly
        // as §4/§9 describe.
        return snapshot;

      case 'failed':
        // LOGGED, deliberately — a real failure worth knowing about in ops,
        // unlike `unavailable`. `warn`, matching `AiDispatchService`'s own
        // level for a provider failure, not `error`: the request still
        // succeeds and the learner is unaffected beyond a missing paragraph.
        this.logger.warn(
          { userId: snapshot.userId, snapshotId: snapshot.id, errorCode: run.errorCode },
          'Progress Guide narrative generation failed',
        );
        return snapshot;
    }
  }

  /**
   * The nightly cron's own entry point (§7(b)): recompute every user who has
   * ever engaged with the journey — the same "has a `learner_profiles` row"
   * signal `JourneyService` already treats as that fact, rather than a
   * second definition of "active" invented here. One user's failure is
   * logged and never aborts the batch — a bad row must not block everyone
   * else's nightly recompute.
   */
  async recomputeAllActiveUsers(): Promise<{ recomputed: number }> {
    const profiles = await this.prisma.learnerProfile.findMany({ select: { userId: true } });

    let recomputed = 0;

    for (const { userId } of profiles) {
      try {
        await this.recomputeSnapshot(userId);
        recomputed += 1;
      } catch (error) {
        this.logger.error(
          { userId, error: error instanceof Error ? error.message : error },
          'Readiness snapshot recompute failed for one user; continuing the batch',
        );
      }
    }

    return { recomputed };
  }

  // ---------------------------------------------------------------------------
  // Evidence assembly
  // ---------------------------------------------------------------------------

  /**
   * Every Prisma read `computeReadiness` needs, resolved for one caller.
   * `computeReadiness` itself never sees a `userId` or a Prisma client — see
   * `readiness-engine.ts`'s own header.
   */
  private async assembleEvidence(userId: string): Promise<ReadinessEvidence> {
    const profile = await this.prisma.learnerProfile.findUnique({
      where: { userId },
      select: { testVersionCode: true, timezone: true },
    });

    const testVersionCode = profile?.testVersionCode ?? null;
    const timezone = profile?.timezone ?? 'UTC';

    // `coverage` (§2.1) and `retention` (§2.5) both read `question_mastery`
    // rows "for this user+version's questions" (readiness-engine.ts's own
    // `ReadinessEvidence.masteryRows` comment) — scoped through the
    // version's question ids, the same bounded-`IN`-list pattern
    // `ProgressService.loadMasteryStateByQuestionId` already uses, rather
    // than `where: { userId }` alone, which would drag in mastery rows from
    // every OTHER test version the learner has ever touched.
    let totalQuestionsInVersion = 0;
    let masteryRows: ReadinessEvidence['masteryRows'] = [];

    if (testVersionCode !== null) {
      const questions = await this.prisma.civicsQuestion.findMany({
        where: { testVersionCode },
        select: { id: true },
      });
      totalQuestionsInVersion = questions.length;

      if (questions.length > 0) {
        const rows = await this.prisma.questionMastery.findMany({
          where: { userId, questionId: { in: questions.map((q) => q.id) } },
          select: { state: true, lapses: true },
        });
        masteryRows = rows.map((row) => ({ state: row.state, lapses: row.lapses }));
      }
    }

    // `recall` (§2.2) — the most recent 20 unassisted attempts, ACROSS every
    // test version the learner has ever practiced under: recall is a
    // recency-scoped recall signal, not a bank-scoped one, so it is read
    // exactly like `journey.service.ts`'s own `hasPractisedOn` reads the
    // caller's attempts — by `userId` alone.
    //
    // -----------------------------------------------------------------------
    // TWO EXCLUSIONS BEYOND `hintUsed`/`revealed` (issue #244, epic #58 / E9)
    // -----------------------------------------------------------------------
    //
    // `recall` and `question_mastery` are THE TWO PLACES A MISHEARING COULD BE
    // CHARGED TO THE LEARNER, and both now refuse it. The other half is the
    // guard in `PracticeService.recordAttempt` (`!misheard` on the
    // `scheduleMastery` call) — read them together; neither is sufficient
    // alone, because they are penalties of different kinds. Mastery is the
    // permanent one (`correctStreak` reset, `lapses` incremented, `dueAt`
    // pulled in); this one decays as the window slides, but while it lasts it
    // is a fifth of the readiness score (`COMPONENT_WEIGHTS.recall` = 0.2)
    // saying the learner is less ready than they are.
    //
    // 1. `failureCause: 'misheard'`. The recogniser reported it was unsure of
    //    the TEXT (`PracticeService.isMisheardAttempt` — all three of its
    //    conditions), so the row is not evidence about recall in either
    //    direction, and `recall` is a claim about recall specifically. Counting
    //    it turns an accent or a noisy mic into a wrong-answer data point
    //    indistinguishable from not knowing the material (`voice.md` §5).
    //
    // 2. Superseded rows — `retries: { none: {} }`, i.e. no later attempt
    //    points at this one through `retryOfAttemptId`. This is NOT redundant
    //    with (1), and the tempting argument that it is deserves stating so it
    //    is not "simplified" back out: `requireRetryTarget`
    //    (`practice.service.ts`) admits a retry on FOUR conditions — the
    //    target exists and is the caller's, it is in this session and at this
    //    question, it is not itself a retry, and nothing already supersedes it
    //    — and being MISHEARD IS NOT AMONG THEM. `record-attempt.dto.ts` says
    //    as much outright ("NOT restricted to a spoken attempt"). So an
    //    ordinary wrong answer can be superseded, and without this clause the
    //    original and its correction would read here as one wrong plus one
    //    right for a question the learner answered once. The two exclusions
    //    are independent in both directions: a misheard attempt the learner
    //    declined to retry is caught only by (1), and a superseded attempt
    //    that was never misheard only by (2).
    //
    // BOTH ARE `where` CLAUSES RATHER THAN A `.filter()` ON THE RESULT, and
    // that placement is the substantive decision, not a style one. Prisma
    // applies `where` before `take`, so the window means "the 20 most recent
    // attempts THAT CARRY RECALL EVIDENCE" — it slides past an excluded row to
    // an older qualifying one. Filtering after `take: 20` would mean "the last
    // 20 attempts, some of which we ignore", which costs the learner a slot per
    // mishearing and silently shrinks the denominator toward
    // `RECALL_MIN_QUALIFYING_ATTEMPTS` — a learner with a bad microphone could
    // drop under the evidence floor and score `recall: 0` for having been
    // misheard often enough. A mishearing must cost nothing at all, a slot
    // included.
    //
    // `readiness-engine.ts` is unchanged and must stay so: its
    // `recentQualifyingAttempts` contract says the rows arrive "already limited
    // and filtered by the caller — this function applies neither the limit nor
    // the filter itself (§5)". This IS that caller, and this is that filter.
    // Both columns are indexed for it (`@@index([retryOfAttemptId])`).
    //
    // -----------------------------------------------------------------------
    // WHY (1) IS AN EXPLICIT `OR ... IS NULL` AND NOT `{ not: 'misheard' }`
    // -----------------------------------------------------------------------
    //
    // DO NOT "SIMPLIFY" THIS TO `failureCause: { not: 'misheard' }`. It reads
    // as the same condition and is not, because `failure_cause` is NULLABLE
    // and NULL is its overwhelmingly common value — every deterministically
    // graded attempt has one (`practice.service.ts`: the three AI columns are
    // omitted entirely when no grader ran).
    //
    // Prisma compiles `{ not: 'misheard' }` to a bare `failure_cause <>
    // 'misheard'`, and `NULL <> 'misheard'` is NULL, not TRUE — so SQL's
    // three-valued logic DROPS every null-cause row. The `NOT: { failureCause:
    // 'misheard' }` spelling is no better: it compiles to `NOT (failure_cause =
    // 'misheard')`, which is NULL for the same rows and drops them too. Both
    // were checked against the generated SQL, not assumed.
    //
    // The failure that would cause is silent and severe rather than loud: the
    // recall window would keep ONLY ai-graded attempts, most learners would
    // fall under `RECALL_MIN_QUALIFYING_ATTEMPTS` (5), and `computeRecall`
    // would return a well-formed `0` — a fifth of the readiness score reading
    // "no recall evidence" for a learner with hundreds of correct answers, with
    // nothing throwing and no row missing from any table to point at.
    const recentQualifyingAttemptRows = await this.prisma.practiceAttempt.findMany({
      where: {
        userId,
        hintUsed: false,
        revealed: false,
        OR: [{ failureCause: null }, { failureCause: { not: 'misheard' } }],
        retries: { none: {} },
      },
      orderBy: { answeredAt: 'desc' },
      take: 20,
      select: { outcome: true },
    });
    const recentQualifyingAttempts = recentQualifyingAttemptRows.map((row) => ({
      outcome: row.outcome,
    }));

    const distinctPracticeDaysInLast14 = await this.countDistinctPracticeDaysInLast14(
      userId,
      timezone,
    );

    // `spoken` (§2.7) — real, and computed for real: `inputMode: 'spoken'`
    // already exists on `practice_attempts` (E9 is what will ever WRITE it,
    // but nothing stops reading it honestly today). Distinct `questionId`
    // among `outcome: 'correct'` rows.
    const spokenCorrectRows = await this.prisma.practiceAttempt.findMany({
      where: { userId, inputMode: 'spoken', outcome: 'correct' },
      select: { questionId: true },
      distinct: ['questionId'],
    });
    const distinctQuestionsCorrectSpoken = spokenCorrectRows.length;

    // `english` — REAL, since #141 (epic #59 / E10). This was a literal `0`
    // with a comment saying `practice_attempts` had no language column, so
    // there was no honest way to say a spoken-correct attempt had been IN
    // ENGLISH specifically, and naming a later epic as the one that would add
    // that column.
    //
    // E10 did not add it. It shipped `english_attempts` — sentences read
    // aloud and sentences typed from dictation — which measures a different
    // quantity, so `english-test.md` §6.2 rescored the component around the
    // evidence that now exists rather than bending that evidence into the old
    // formula's shape. This is the query the old comment was waiting for.
    const englishBestOutcomesInWindow = await this.collectEnglishBestOutcomesInWindow(userId);

    // `interview` (§2.8) — REAL, since #133 (epic #57 / E8). This was a
    // literal `0` with a comment saying `practice_attempts` rows carrying
    // `source: 'mock_interview'` had `sessionId: null` and therefore no
    // grouping key that could turn a set of attempt rows into discrete
    // interviews a pass/fail could be judged against; it named E8 as the
    // epic that would have to supply one.
    //
    // E8 supplied it: `mock_interviews` is that grouping key, and this is
    // the count the old comment was waiting for — this user's rows with
    // `status: 'completed'` AND `passedCivics: true`. Not attempts, not
    // questions: whole interviews the learner finished and passed the
    // civics section of, which is the unit `computeInterview`'s
    // `min(mockInterviewsPassed / 2, 1)` and `PRD.md`'s own "completing two
    // mock interviews" are both stated in.
    //
    // NO HEURISTIC GROUPING over `practice_attempts` by elapsed time or any
    // other proxy — the "invented-session-concept" §10 rules out and the old
    // comment specifically refused. The table is real now, so nothing has to
    // be inferred.
    //
    // READ DIRECTLY THROUGH PRISMA, exactly as this service already reads
    // `practice_attempts` and `question_mastery`. `ReadinessModule` does NOT
    // import `InterviewsModule` and must not: `InterviewsModule` imports
    // THIS one (its `completeInterview` calls `recomputeSnapshot`
    // synchronously, §7(a)), so a back-import would be a cycle for a
    // dependency this service does not have. It needs one count, and the
    // `[userId, status, passedCivics]` composite index on `mock_interviews`
    // exists for precisely this query — an equality filter on all three
    // columns, no sort.
    const mockInterviewsPassed = await this.prisma.mockInterview.count({
      where: { userId, status: 'completed', passedCivics: true },
    });

    return {
      totalQuestionsInVersion,
      masteryRows,
      recentQualifyingAttempts,
      englishBestOutcomesInWindow,
      distinctPracticeDaysInLast14,
      distinctQuestionsCorrectSpoken,
      mockInterviewsPassed,
    };
  }

  /**
   * `english`'s evidence (`english-test.md` §6.1-§6.2): one entry per
   * DISTINCT sentence attempted in the trailing 30 days, carrying that
   * sentence's BEST in-window outcome.
   *
   * THE BEST-OF REDUCTION IS THE WHOLE REASON THIS IS NOT A `count`. §6.2
   * credits a sentence once, at its best in-window outcome — "twice
   * `incorrect` and once `correct` counts once, at `correct`'s credit" — so a
   * learner cannot inflate the component by re-attempting one sentence they
   * already got right, and equally is not held down by the failed tries that
   * preceded a success. Doing it in JS over a small per-user row set (rather
   * than a `DISTINCT ON` or a `groupBy` with a max) keeps the rule readable
   * beside the sentence of spec it implements, and the volume is bounded by
   * how many sentences one person can attempt in a month.
   *
   * NO NEGATIVE FILTER ON A NULLABLE COLUMN ANYWHERE IN THIS QUERY, and that
   * is deliberate rather than incidental — see `assembleEvidence`'s own
   * `failureCause` comment for the full account of why `{ not: x }` on a
   * nullable column silently drops every null row. All four columns touched
   * here (`userId`, `answeredAt`, `sentenceId`, `kind`, `outcome`) are NOT
   * NULL in the schema, and every clause is a positive one; the only nullable
   * column on `english_attempts` is `asrConfidence`, which this query neither
   * selects nor filters on.
   */
  private async collectEnglishBestOutcomesInWindow(
    userId: string,
  ): Promise<ReadinessEvidence['englishBestOutcomesInWindow']> {
    // `Clock`, never a bare `new Date()` — CLAUDE.md's "Using the Clock"
    // rule, and what lets an integration test pin the window boundary with
    // `X-Test-Clock` instead of writing rows dated relative to the real wall
    // clock and hoping.
    const windowFloor = new Date(this.clock.now().getTime() - ENGLISH_WINDOW_DAYS * MS_PER_DAY);

    const rows = await this.prisma.englishAttempt.findMany({
      where: { userId, answeredAt: { gte: windowFloor } },
      select: { sentenceId: true, kind: true, outcome: true },
    });

    // Keyed by sentence id alone would be enough — a sentence belongs to
    // exactly one segment (`english-test.md` §1.4: a reading sentence draws
    // only from the reading vocabulary) — but the kind is in the key anyway
    // so that this reduction stays correct on its own terms rather than on a
    // content invariant enforced somewhere else entirely.
    const bestBySentence = new Map<
      string,
      { kind: EnglishSegment; outcome: EnglishSegmentOutcome }
    >();

    for (const row of rows) {
      const key = `${row.kind}:${row.sentenceId}`;
      const current = bestBySentence.get(key);
      const isBetter =
        current === undefined ||
        ENGLISH_OUTCOME_RANK[row.outcome] > ENGLISH_OUTCOME_RANK[current.outcome];

      if (isBetter) {
        bestBySentence.set(key, { kind: row.kind, outcome: row.outcome });
      }
    }

    return [...bestBySentence.values()];
  }

  /**
   * `consistency`'s (§2.4) rolling 14-calendar-day count, in the learner's
   * own timezone. Queried with a generous buffer beyond 14 days (so a
   * timezone offset near the window edge can never clip a real day out
   * before the exact filter runs), then reduced to a `Set` of calendar-day
   * strings and counted precisely by `dayIndexOf` distance from today —
   * the identical two-step "cheap Prisma bound, exact JS comparison"
   * shape `journey.service.ts`'s own window-arithmetic comment argues for.
   */
  private async countDistinctPracticeDaysInLast14(
    userId: string,
    timezone: string,
  ): Promise<number> {
    const now = this.clock.now();
    const queryFloor = new Date(
      now.getTime() - (CONSISTENCY_WINDOW_DAYS + CONSISTENCY_QUERY_BUFFER_DAYS) * MS_PER_DAY,
    );

    const rows = await this.prisma.practiceAttempt.findMany({
      where: { userId, answeredAt: { gte: queryFloor } },
      select: { answeredAt: true },
    });

    if (rows.length === 0) {
      return 0;
    }

    const today = dayIndexOf(calendarDateOf(now, timezone));
    const distinctDays = new Set<string>();

    for (const row of rows) {
      const calendarDate = calendarDateOf(row.answeredAt, timezone);
      const daysAgo = today - dayIndexOf(calendarDate);
      if (daysAgo >= 0 && daysAgo < CONSISTENCY_WINDOW_DAYS) {
        distinctDays.add(calendarDate);
      }
    }

    return distinctDays.size;
  }
}
