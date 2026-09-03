import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type JourneyStage, type ReadinessSnapshot } from '@prisma/client';

import { AiDispatchService, type AiRunResult } from '../ai/ai-dispatch.service';
import { Clock } from '../common/clock/clock';
import { nextStageOnReadinessSnapshot } from '../journey/readiness-stage-transitions';
import { PrismaService } from '../prisma/prisma.service';
import { buildProgressGuidePrompt } from './progress-guide-prompt';
import {
  computeReadiness,
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
// THE EVIDENCE SOURCES THE SCHEMA DOES NOT YET SUPPORT (§10's honesty rule)
// -----------------------------------------------------------------------------
//
// `distinctQuestionsCorrectSpokenInEnglish` (english, §2.6) is always `0`
// today — see {@link assembleEvidence}'s own comment for exactly why, and
// which future epic (E11) is expected to add the column that would let this
// service compute a real value. Never faked, never inferred from a proxy.
//
// `mockInterviewsPassed` (interview, §2.8) WAS the second of these and is not
// any more: #133 (epic #57 / E8) shipped `mock_interviews`, the grouping key
// its own literal-zero comment was waiting for, and it is now a real count of
// completed, passed interviews. `computeInterview` did not change — it always
// read whatever number it was handed; this epic only stopped that number being
// hardcoded.
// =============================================================================

/** Milliseconds in a calendar day. Pure arithmetic on an already-resolved instant, never a clock read of its own. */
const MS_PER_DAY = 86_400_000;

/** How many calendar days back `consistency`'s (§2.4) rolling window looks, inclusive of today. */
const CONSISTENCY_WINDOW_DAYS = 14;

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
    const recentQualifyingAttemptRows = await this.prisma.practiceAttempt.findMany({
      where: { userId, hintUsed: false, revealed: false },
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

    // `english` (§2.6) — LITERAL 0, always, for now. `practice_attempts` has
    // no language column at all today (only `inputMode`/`promptMode`), so
    // there is no honest way to say a spoken-correct attempt was IN
    // ENGLISH specifically. E11 is the epic that will need to add whatever
    // column carries that fact; inventing a proxy for it here (e.g.
    // treating every spoken-correct row as English) would be exactly the
    // faked evidence §5/§10 rule out.
    const distinctQuestionsCorrectSpokenInEnglish = 0;

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
      distinctPracticeDaysInLast14,
      distinctQuestionsCorrectSpoken,
      distinctQuestionsCorrectSpokenInEnglish,
      mockInterviewsPassed,
    };
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
