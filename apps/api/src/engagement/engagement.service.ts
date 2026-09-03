import { Injectable, Logger } from '@nestjs/common';
import type { PracticeOutcome } from '@prisma/client';

import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import type { EngagementSummaryResponse } from './dto/engagement-summary.dto';
import {
  FREEZE_SETTLE_LOOKBACK_DAYS,
  STREAK_FREEZE_MAX,
  settleStreakFreezes,
} from './streaks/freeze-settlement';
import { computeStreak, type StreakDay } from './streaks/streak-engine';

// =============================================================================
// EngagementService (issue #119, epic #56 / E7 "Habit")
// =============================================================================
//
// `docs/specs/habit-streaks.md` §2-§4. Three jobs, and no fourth:
//
//   1. ACCRUAL — turn a graded attempt and a completed session into one
//      `daily_activity` row per LOCAL day (§2).
//   2. SETTLEMENT — replenish the freeze budget and spend it on the gaps
//      worth protecting, persisting each as a real row (§4.3-§4.5).
//   3. THE SUMMARY — the one read surface (§4.6).
//
// -----------------------------------------------------------------------------
// THIS SERVICE IS NOT AN INPUT TO READINESS, AND NEVER WILL BE (§1)
// -----------------------------------------------------------------------------
//
// `ReadinessEvidence` (`readiness/readiness-engine.ts`) has no field a
// `daily_activity` row, a streak count or a freeze balance could even be
// assigned to, and this file never calls into the readiness module at all.
// `PRD.md` makes the separation explicit — "Points, streaks, achievements, and
// challenges encourage the journey. They must never artificially increase the
// user's Readiness Score" — and it is kept structurally, by the absence of a
// wire, not by a filter applied at read time.
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES A `userId` THAT CAME FROM `@CurrentUser('id')`
// -----------------------------------------------------------------------------
//
// The same posture `JourneyService`, `PracticeService`, `ProgressService` and
// `ReadinessService` already take: no method here accepts a user id from
// anywhere else, because `EngagementController` has no parameter that could
// carry one. The two accrual methods are called by `PracticeService` with the
// id IT resolved the same way, for the learner whose own attempt it just
// recorded.
//
// -----------------------------------------------------------------------------
// NOTHING IN THIS FILE CONSTRUCTS A BARE `new Date()`
// -----------------------------------------------------------------------------
//
// Every notion of "now" comes from the injected `Clock` (CLAUDE.md, "Using the
// Clock") — the local day through `clock.calendarDateIn(timezone)`, the
// replenishment interval through `clock.now()`. The `Date` values built below
// are conversions of an already-resolved `YYYY-MM-DD` into the midnight-UTC
// instant a Prisma `@db.Date` column round-trips, never a reading of the wall
// clock.
// =============================================================================

/**
 * The per-event ceiling on measured practice time, in seconds (§2.3).
 *
 * A learner who leaves a tab open overnight did not practise for nine hours.
 * Without this cap a single forgotten tab would flip `goal_met` for days no
 * real practice happened on, and would make the streak trivially gameable by
 * doing nothing. 120 seconds is generous against a real exchange — read a
 * question, type an answer, see feedback — while bounding the damage of any
 * single unmeasured gap to a number too small to fabricate a day out of.
 */
export const ATTEMPT_SECONDS_CAP = 120;

/** How many local days `recentDays` reports (§4.6). */
export const RECENT_DAYS_WINDOW = 14;

/** Milliseconds in a calendar day. Pure arithmetic on resolved instants. */
const MS_PER_DAY = 86_400_000;

/** The `learner_profiles` facts engagement reads — nothing wider. */
interface EngagementProfile {
  /**
   * False when the learner has no `learner_profiles` row yet (it is created
   * lazily, on the first `GET /api/journey/profile`). Every value below is
   * then the column's own schema default, and no profile WRITE is attempted:
   * there is no row to update, and a learner who has never had a profile has
   * never practised either, so there is no streak for a freeze to protect.
   */
  exists: boolean;
  timezone: string;
  dailyGoalMinutes: number;
  streakFreezes: number;
  streakFreezesGrantedAt: Date | null;
}

/** One accrual event's effect on the day's counters, before the write. */
interface AccrualDelta {
  sessionId: string;
  /** The event's instant: the attempt's `answeredAt`, or the completion timestamp. */
  at: Date;
  attempts: number;
  correct: number;
}

/** A `YYYY-MM-DD` local day as the midnight-UTC instant a `@db.Date` column round-trips. */
function toDateColumn(calendarDate: string): Date {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}

/** A `@db.Date` value back to `YYYY-MM-DD`. Prisma hands these back as midnight-UTC instants. */
function fromDateColumn(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → days since the Unix epoch. Pure; the same construction the streak engine uses. */
function dayIndexOf(calendarDate: string): number {
  const [year, month, day] = calendarDate.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/** Days since the Unix epoch → `YYYY-MM-DD`. */
function calendarDateOfIndex(dayIndex: number): string {
  return new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10);
}

@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------------------
  // Accrual (§2)
  // ---------------------------------------------------------------------------

  /**
   * ACCRUAL EVENT (a) — one graded attempt (§2.1).
   *
   * Called once per recorded attempt, INCLUDING a `skipped` one: a skip is
   * "not evidence of recall in either direction" for mastery scheduling, but
   * it is still a real interaction with the product, and excluding it would
   * undercount genuine engagement for the identical reason `memory-model.md`
   * §3.2 gives for scheduling a skip as `incorrect` rather than ignoring it.
   *
   * `correct` counts the LEDGER row's own `PracticeOutcome` — never the
   * narrower mastery-scheduling union, whose `correct_self_marked` is a
   * scheduling-only distinction that does not exist on this column (§2.2).
   */
  async recordAttemptActivity(
    userId: string,
    input: { sessionId: string; answeredAt: Date; outcome: PracticeOutcome },
  ): Promise<void> {
    await this.accrue(userId, {
      sessionId: input.sessionId,
      at: input.answeredAt,
      attempts: 1,
      correct: input.outcome === 'correct' ? 1 : 0,
    });
  }

  /**
   * ACCRUAL EVENT (b) — one session completion (§2.1).
   *
   * The same time accrual by the identical formula, with `now` = the
   * completion timestamp — closing the one gap no attempt event ever closes:
   * the seconds between the last attempt (or, for a session completed with
   * zero attempts, the session's own `startedAt`) and the moment the learner
   * actually finished.
   *
   * `attempts` and `correct` are deliberately UNTOUCHED here (§2.2): nothing
   * was answered at completion itself, and crediting it would double-count
   * against whichever attempt event already ran.
   */
  async recordSessionCompletionActivity(
    userId: string,
    input: { sessionId: string; completedAt: Date },
  ): Promise<void> {
    await this.accrue(userId, {
      sessionId: input.sessionId,
      at: input.completedAt,
      attempts: 0,
      correct: 0,
    });
  }

  /**
   * The one write both accrual events share.
   *
   * Two statements, and the split is the point:
   *
   *  1. An UPSERT keyed on `@@unique([userId, activityDate])`, incrementing
   *     the counters. Two events on the same local day therefore never produce
   *     two rows — the second simply increments the first (§2.4) — and the
   *     increments are atomic rather than a read-modify-write this service
   *     could lose a race on.
   *  2. A CONDITIONAL promotion of `goal_met`, expressed entirely as a `where`
   *     clause: `goalMet: false` AND `practiceSeconds >= goal`. This is the
   *     ONLY statement in this file that writes `goal_met`, and it can only
   *     ever write `true` — which is how §2.3's monotonicity ("a day that was
   *     earned stays earned") is structural rather than a rule a later edit
   *     could forget. A learner who met a 5-minute goal at 8am and raises it
   *     to 15 minutes at noon did not retroactively fail that morning; the
   *     goal they cleared was the goal that existed when they cleared it.
   */
  private async accrue(userId: string, delta: AccrualDelta): Promise<void> {
    const profile = await this.loadProfile(userId);
    const activityDate = this.clock.calendarDateIn(profile.timezone);
    const seconds = await this.sliceSeconds(userId, delta.sessionId, delta.at);

    const key = {
      userId_activityDate: { userId, activityDate: toDateColumn(activityDate) },
    };

    await this.prisma.dailyActivity.upsert({
      where: key,
      create: {
        userId,
        activityDate: toDateColumn(activityDate),
        // Stored, never re-derived at read time (§3.1): a learner who later
        // moves keeps every past row's day exactly as it was computed on the
        // day it was written.
        tzUsed: profile.timezone,
        practiceSeconds: seconds,
        attempts: delta.attempts,
        correct: delta.correct,
      },
      update: {
        practiceSeconds: { increment: seconds },
        attempts: { increment: delta.attempts },
        correct: { increment: delta.correct },
      },
    });

    await this.prisma.dailyActivity.updateMany({
      where: {
        userId,
        activityDate: toDateColumn(activityDate),
        goalMet: false,
        practiceSeconds: { gte: profile.dailyGoalMinutes * 60 },
      },
      data: { goalMet: true },
    });
  }

  /**
   * §2.3's formula, verbatim:
   *
   *     slice = min(now - max(session.startedAt, previousEventTimestamp), ATTEMPT_SECONDS_CAP)
   *
   * DERIVED SERVER-SIDE FROM TIMESTAMPS, NEVER FROM A CLIENT-SUPPLIED
   * DURATION. `practice_attempts.durationMs` already exists as per-question UI
   * telemetry and is exactly this untrusted: nothing stops a client reporting
   * an hour for a 30-second session, and unlike a graded response — which
   * still has to be RIGHT to help the learner — a duration has no downstream
   * check that would catch the lie. This method reads that column not at all.
   *
   * `previousEventTimestamp` is the prior attempt's `answeredAt` in this
   * session if one exists, else the session's own `startedAt`. The `lt` bound
   * is what excludes the attempt this accrual is FOR: accrual runs after that
   * row has already committed (§2.1), so the just-written attempt is visible
   * to this query and must not be mistaken for its own predecessor.
   *
   * A negative interval (a clock the caller pinned backwards, a session row
   * that outran its attempt) floors at zero rather than subtracting time a
   * learner never spent.
   */
  private async sliceSeconds(userId: string, sessionId: string, at: Date): Promise<number> {
    const [session, previous] = await Promise.all([
      this.prisma.practiceSession.findFirst({
        where: { id: sessionId, userId },
        select: { startedAt: true },
      }),
      this.prisma.practiceAttempt.findFirst({
        where: { sessionId, userId, answeredAt: { lt: at } },
        orderBy: { answeredAt: 'desc' },
        select: { answeredAt: true },
      }),
    ]);

    const startedAt = session?.startedAt ?? at;
    const base = previous
      ? new Date(Math.max(startedAt.getTime(), previous.answeredAt.getTime()))
      : startedAt;

    const elapsed = Math.floor((at.getTime() - base.getTime()) / 1000);
    return Math.min(Math.max(elapsed, 0), ATTEMPT_SECONDS_CAP);
  }

  // ---------------------------------------------------------------------------
  // The summary (§4.6)
  // ---------------------------------------------------------------------------

  /**
   * Everything the goal ring, the streak badge and the session-end
   * celebration need, for the caller and nobody else.
   *
   * SETTLEMENT RUNS ONCE, AT THE TOP, before the streak is computed —
   * §4.6's single recompute trigger, deliberately unlike readiness's two.
   * Engagement needs no cron of its own: nothing here decays the moment
   * nobody looks the way `consistency`'s rolling window does, and there is no
   * trend-line consumer requiring a fresh row to exist before anyone asks.
   * A streak nobody has looked at today simply has stale settlement waiting
   * for the next `GET`, which is correct — the learner has not been shown a
   * wrong number, because they have not been shown any number.
   *
   * A read path that writes is already this codebase's established shape:
   * `GET /api/readiness` lazily computes and persists a snapshot for exactly
   * the same reason (`readiness-model.md` §6, cited by §4.4).
   */
  async getSummary(userId: string): Promise<EngagementSummaryResponse> {
    const profile = await this.loadProfile(userId);
    const today = this.clock.calendarDateIn(profile.timezone);

    const settled = await this.settle(userId, profile, today);
    const days = settled.days;

    const streak = computeStreak({ today, days: days.map(toStreakDay) });

    const byDate = new Map(days.map((row) => [row.date, row]));
    const todayRow = byDate.get(today);

    const todayIndex = dayIndexOf(today);
    const recentDays: EngagementSummaryResponse['recentDays'] = [];
    for (let offset = RECENT_DAYS_WINDOW - 1; offset >= 0; offset -= 1) {
      const date = calendarDateOfIndex(todayIndex - offset);
      const row = byDate.get(date);
      recentDays.push({
        date,
        goalMet: row?.goalMet ?? false,
        freezeUsed: row?.freezeUsed ?? false,
        practiceSeconds: row?.practiceSeconds ?? 0,
      });
    }

    return {
      dailyGoalMinutes: profile.dailyGoalMinutes,
      // Present even with no row yet, with honest zeros — see the DTO.
      today: {
        date: today,
        practiceSeconds: todayRow?.practiceSeconds ?? 0,
        attempts: todayRow?.attempts ?? 0,
        correct: todayRow?.correct ?? 0,
        goalMet: todayRow?.goalMet ?? false,
      },
      streak,
      freezes: { remaining: settled.streakFreezes, max: STREAK_FREEZE_MAX },
      timezone: profile.timezone,
      recentDays,
    };
  }

  // ---------------------------------------------------------------------------
  // Settlement (§4.3-§4.5)
  // ---------------------------------------------------------------------------

  /**
   * Replenish the budget, spend it on the gaps worth protecting, and hand back
   * the learner's day rows as they stand afterwards.
   *
   * The DECISION is `settleStreakFreezes` — pure, table-tested, no database in
   * the loop. This method does the I/O the plan describes and nothing else.
   *
   * CONSUMPTION IS PERSISTED, not recomputed on every read (§4.4): each
   * covered day becomes a real `daily_activity` row with `freezeUsed: true`
   * and zeroed counters. Three reasons, all load-bearing — the unique key
   * makes a second settlement pass a no-op, the learner's history stays
   * auditable, and a freeze that is only CHECKED and never SPENT is not a
   * budget of two at all, because nothing about checking it ever reduces what
   * is available for the next gap.
   *
   * Idempotent by construction: a second call finds the freeze rows already
   * written (so they qualify and the walk passes straight over them) and
   * `streakFreezesGrantedAt` freshly stamped (so no second grant is due), and
   * writes nothing at all.
   */
  private async settle(
    userId: string,
    profile: EngagementProfile,
    today: string,
  ): Promise<{ days: DailyActivityRow[]; streakFreezes: number }> {
    const days = await this.loadDays(userId);

    // Nothing to settle against and nothing to settle ON: with no
    // `learner_profiles` row there is no balance to decrement and no row to
    // stamp, and a learner who has never had a profile has never practised.
    if (!profile.exists) {
      return { days, streakFreezes: profile.streakFreezes };
    }

    const plan = settleStreakFreezes({
      today,
      days: days.map(toStreakDay),
      streakFreezes: profile.streakFreezes,
      daysSinceLastGrant: this.daysSince(profile.streakFreezesGrantedAt),
    });

    if (!plan.grantFreeze && plan.freezeDays.length === 0) {
      return { days, streakFreezes: profile.streakFreezes };
    }

    for (const date of plan.freezeDays) {
      await this.prisma.dailyActivity.upsert({
        where: { userId_activityDate: { userId, activityDate: toDateColumn(date) } },
        create: {
          userId,
          activityDate: toDateColumn(date),
          tzUsed: profile.timezone,
          practiceSeconds: 0,
          attempts: 0,
          correct: 0,
          goalMet: false,
          freezeUsed: true,
        },
        // A row already there was written by an earlier pass (or by accrual
        // between this pass's read and its write) and is left exactly as it
        // is — the empty update is what makes a repeated settlement a no-op
        // rather than a double-consumed freeze (§4.4, reason 1).
        update: {},
      });
    }

    await this.prisma.learnerProfile.update({
      where: { userId },
      data: {
        streakFreezes: plan.streakFreezesAfter,
        ...(plan.grantFreeze ? { streakFreezesGrantedAt: this.clock.now() } : {}),
      },
    });

    this.logger.log(
      {
        userId,
        granted: plan.grantFreeze,
        freezeDays: plan.freezeDays,
        streakFreezes: plan.streakFreezesAfter,
        lookbackDays: FREEZE_SETTLE_LOOKBACK_DAYS,
      },
      'Settled streak freezes',
    );

    return { days: await this.loadDays(userId), streakFreezes: plan.streakFreezesAfter };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Every `daily_activity` row this learner has, oldest first.
   *
   * The WHOLE history, deliberately, not a bounded recent window (§4.2):
   * `longest` is defined over all of it, and a window would silently cap
   * `longest` at the window size the first time an account is old enough to
   * exceed it. The row count is bounded by the number of distinct calendar
   * days since the account existed, and `@@unique([userId, activityDate])`
   * makes this a single ordered range scan.
   */
  private async loadDays(userId: string): Promise<DailyActivityRow[]> {
    const rows = await this.prisma.dailyActivity.findMany({
      where: { userId },
      orderBy: { activityDate: 'asc' },
      select: {
        activityDate: true,
        practiceSeconds: true,
        attempts: true,
        correct: true,
        goalMet: true,
        freezeUsed: true,
      },
    });

    return rows.map((row) => ({
      date: fromDateColumn(row.activityDate),
      practiceSeconds: row.practiceSeconds,
      attempts: row.attempts,
      correct: row.correct,
      goalMet: row.goalMet,
      freezeUsed: row.freezeUsed,
    }));
  }

  /**
   * The four `learner_profiles` columns engagement reads.
   *
   * A missing row falls back to the schema's own defaults rather than
   * throwing — the same tolerance `ReadinessService.assembleEvidence` already
   * shows for the same table (`profile?.timezone ?? 'UTC'`). `UTC` is the
   * honest "nobody has told us yet" value, and `exists: false` is what stops
   * settlement from attempting a write against a row that is not there.
   */
  private async loadProfile(userId: string): Promise<EngagementProfile> {
    const profile = await this.prisma.learnerProfile.findUnique({
      where: { userId },
      select: {
        timezone: true,
        dailyGoalMinutes: true,
        streakFreezes: true,
        streakFreezesGrantedAt: true,
      },
    });

    return {
      exists: profile !== null,
      timezone: profile?.timezone ?? 'UTC',
      dailyGoalMinutes: profile?.dailyGoalMinutes ?? 5,
      streakFreezes: profile?.streakFreezes ?? STREAK_FREEZE_MAX,
      streakFreezesGrantedAt: profile?.streakFreezesGrantedAt ?? null,
    };
  }

  /**
   * Whole days between `instant` and now, or `null` for "never" — the shape
   * `settleStreakFreezes` wants, so the pure module never sees a `Date`.
   */
  private daysSince(instant: Date | null): number | null {
    if (instant === null) {
      return null;
    }
    return Math.floor((this.clock.now().getTime() - instant.getTime()) / MS_PER_DAY);
  }
}

/** A `daily_activity` row as this service carries it: a LOCAL day plus its counters. */
interface DailyActivityRow {
  date: string;
  practiceSeconds: number;
  attempts: number;
  correct: number;
  goalMet: boolean;
  freezeUsed: boolean;
}

/** The three facts the pure streak/settlement modules take, and nothing else. */
function toStreakDay(row: DailyActivityRow): StreakDay {
  return { date: row.date, goalMet: row.goalMet, freezeUsed: row.freezeUsed };
}
