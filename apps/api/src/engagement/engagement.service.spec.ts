import { Test, TestingModule } from '@nestjs/testing';

import { Clock } from '../common/clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { ATTEMPT_SECONDS_CAP, EngagementService } from './engagement.service';
import {
  FREEZE_REPLENISH_INTERVAL_DAYS,
  FREEZE_SETTLE_LOOKBACK_DAYS,
  STREAK_FREEZE_MAX,
} from './streaks/freeze-settlement';

// =============================================================================
// EngagementService — tests (issue #119, epic #56 / E7 "Habit")
// =============================================================================
//
// The decisions, not the plumbing — the same posture `practice.service.spec.ts`
// takes, and the same hand-built Prisma stub rather than `mockDeep`: every
// property this file exists to prove ("two attempts on one local day produce
// ONE row", "goal_met never flips back", "a second settlement writes nothing")
// is an assertion about which ROW a later call sees, which a `mockResolvedValue`
// cannot express at all.
//
// The clock is the REAL `Clock`, subclassed to pin `now()` — so
// `calendarDateIn` below is the shipped `Intl` derivation, not a test double's
// idea of what a local day is. That matters more here than anywhere: the local
// day IS the primary key of everything this service writes.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

const USER = 'user-1';
const OTHER_USER = 'user-2';
const SESSION = 'session-1';

/** The real `Clock`, with a settable instant — `calendarDateIn` is inherited, unmodified. */
class FixedClock extends Clock {
  constructor(private instant: Date) {
    super();
  }

  now(): Date {
    return new Date(this.instant);
  }

  set(instant: Date): void {
    this.instant = instant;
  }
}

interface DailyActivityRow {
  userId: string;
  activityDate: Date;
  tzUsed: string;
  practiceSeconds: number;
  attempts: number;
  correct: number;
  goalMet: boolean;
  freezeUsed: boolean;
}

interface ProfileRow {
  timezone: string;
  dailyGoalMinutes: number;
  streakFreezes: number;
  streakFreezesGrantedAt: Date | null;
}

const dateKey = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * A tiny in-memory stand-in for the four tables this service touches,
 * filtering on `where` for real.
 *
 * `dailyActivity.upsert` honours `{ increment }` the way Postgres does,
 * because "the second accrual call for a day increments the first row it
 * already wrote" (§2.4) is precisely what several tests below assert.
 */
class PrismaStub {
  readonly profiles = new Map<string, ProfileRow>();
  readonly activity = new Map<string, DailyActivityRow>();
  readonly sessions = new Map<string, { userId: string; startedAt: Date }>();
  readonly attempts: Array<{ sessionId: string; userId: string; answeredAt: Date }> = [];

  private key(userId: string, activityDate: Date): string {
    return `${userId}|${dateKey(activityDate)}`;
  }

  rowsFor(userId: string): DailyActivityRow[] {
    return Array.from(this.activity.values())
      .filter((row) => row.userId === userId)
      .sort((a, b) => a.activityDate.getTime() - b.activityDate.getTime());
  }

  rowOn(userId: string, date: string): DailyActivityRow | undefined {
    return this.activity.get(`${userId}|${date}`);
  }

  readonly learnerProfile = {
    findUnique: async ({ where }: any) => {
      const profile = this.profiles.get(where.userId);
      return profile ? { ...profile } : null;
    },
    update: async ({ where, data }: any) => {
      const profile = this.profiles.get(where.userId);
      if (!profile) {
        throw new Error(`no learner_profiles row for ${where.userId}`);
      }
      const next = { ...profile, ...data };
      this.profiles.set(where.userId, next);
      return { ...next };
    },
  };

  readonly dailyActivity = {
    upsert: async ({ where, create, update }: any) => {
      const { userId, activityDate } = where.userId_activityDate;
      const key = this.key(userId, activityDate);
      const existing = this.activity.get(key);

      if (!existing) {
        const row: DailyActivityRow = {
          goalMet: false,
          freezeUsed: false,
          practiceSeconds: 0,
          attempts: 0,
          correct: 0,
          ...create,
        };
        this.activity.set(key, row);
        return { ...row };
      }

      const next = { ...existing };
      for (const [field, value] of Object.entries(update as Record<string, any>)) {
        (next as any)[field] =
          value && typeof value === 'object' && 'increment' in value
            ? (next as any)[field] + value.increment
            : value;
      }
      this.activity.set(key, next);
      return { ...next };
    },

    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const [key, row] of this.activity) {
        if (row.userId !== where.userId) continue;
        if (where.activityDate && dateKey(row.activityDate) !== dateKey(where.activityDate)) continue;
        if (where.goalMet !== undefined && row.goalMet !== where.goalMet) continue;
        if (
          where.practiceSeconds?.gte !== undefined &&
          row.practiceSeconds < where.practiceSeconds.gte
        ) {
          continue;
        }
        this.activity.set(key, { ...row, ...data });
        count += 1;
      }
      return { count };
    },

    findMany: async ({ where }: any) => this.rowsFor(where.userId).map((row) => ({ ...row })),
  };

  readonly practiceSession = {
    findFirst: async ({ where }: any) => {
      const session = this.sessions.get(where.id);
      return session && session.userId === where.userId ? { startedAt: session.startedAt } : null;
    },
  };

  readonly practiceAttempt = {
    findFirst: async ({ where }: any) => {
      const rows = this.attempts
        .filter(
          (row) =>
            row.sessionId === where.sessionId &&
            row.userId === where.userId &&
            (where.answeredAt?.lt === undefined ||
              row.answeredAt.getTime() < where.answeredAt.lt.getTime()),
        )
        .sort((a, b) => b.answeredAt.getTime() - a.answeredAt.getTime());
      return rows[0] ? { answeredAt: rows[0].answeredAt } : null;
    },
  };
}

describe('EngagementService', () => {
  let prisma: PrismaStub;
  let clock: FixedClock;
  let service: EngagementService;

  /** A day, in UTC, that every default fixture below sits inside. */
  const SESSION_START = new Date('2026-04-10T12:00:00.000Z');

  beforeEach(async () => {
    prisma = new PrismaStub();
    clock = new FixedClock(SESSION_START);

    prisma.profiles.set(USER, {
      timezone: 'UTC',
      dailyGoalMinutes: 5,
      streakFreezes: STREAK_FREEZE_MAX,
      streakFreezesGrantedAt: null,
    });
    prisma.sessions.set(SESSION, { userId: USER, startedAt: SESSION_START });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EngagementService,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
      ],
    }).compile();

    service = module.get(EngagementService);
  });

  /**
   * Record one attempt the way `PracticeService.recordAttempt` does: the row
   * is committed FIRST (so `sliceSeconds`' "previous attempt" lookup can see
   * it), then accrual runs.
   */
  async function attemptAt(
    at: string,
    outcome: 'correct' | 'incorrect' | 'partial' | 'skipped' = 'correct',
  ): Promise<void> {
    const answeredAt = new Date(at);
    clock.set(answeredAt);
    prisma.attempts.push({ sessionId: SESSION, userId: USER, answeredAt });
    await service.recordAttemptActivity(USER, { sessionId: SESSION, answeredAt, outcome });
  }

  // ===========================================================================
  // Accrual — one row per LOCAL day (§2.4)
  // ===========================================================================

  describe('accrual is idempotent per local day', () => {
    it('two attempts on the same local day increment ONE row, never write a second', async () => {
      await attemptAt('2026-04-10T12:00:30.000Z');
      await attemptAt('2026-04-10T12:01:00.000Z');

      const rows = prisma.rowsFor(USER);
      expect(rows).toHaveLength(1);
      expect(rows[0].attempts).toBe(2);
      expect(rows[0].correct).toBe(2);
      // 30s from the session start, then 30s from the previous attempt.
      expect(rows[0].practiceSeconds).toBe(60);
    });

    it('an attempt on the next local day opens a second row, leaving the first untouched', async () => {
      await attemptAt('2026-04-10T12:00:30.000Z');
      await attemptAt('2026-04-11T12:00:30.000Z');

      const rows = prisma.rowsFor(USER);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => dateKey(row.activityDate))).toEqual(['2026-04-10', '2026-04-11']);
      expect(rows[0].attempts).toBe(1);
      expect(rows[1].attempts).toBe(1);
    });

    it('counts only `correct` toward `correct` — a skip still counts as an attempt', async () => {
      await attemptAt('2026-04-10T12:00:10.000Z', 'skipped');
      await attemptAt('2026-04-10T12:00:20.000Z', 'incorrect');
      await attemptAt('2026-04-10T12:00:30.000Z', 'correct');

      const row = prisma.rowsFor(USER)[0];
      expect(row.attempts).toBe(3);
      expect(row.correct).toBe(1);
    });

    it('a session completion adds time but never `attempts` or `correct` (§2.2)', async () => {
      await attemptAt('2026-04-10T12:00:30.000Z');

      const completedAt = new Date('2026-04-10T12:01:10.000Z');
      clock.set(completedAt);
      await service.recordSessionCompletionActivity(USER, { sessionId: SESSION, completedAt });

      const row = prisma.rowsFor(USER)[0];
      expect(row.attempts).toBe(1);
      expect(row.correct).toBe(1);
      // 30s to the attempt, then 40s from that attempt to the completion.
      expect(row.practiceSeconds).toBe(70);
    });
  });

  // ===========================================================================
  // `tz_used` (§3.1)
  // ===========================================================================

  describe('tz_used', () => {
    it('is written from the learner’s own profile timezone, and fixes the local day', async () => {
      prisma.profiles.set(USER, {
        timezone: 'America/Los_Angeles',
        dailyGoalMinutes: 5,
        streakFreezes: STREAK_FREEZE_MAX,
        streakFreezesGrantedAt: null,
      });

      // 23:30 in Los Angeles — already the NEXT calendar day in UTC.
      await attemptAt('2026-04-11T06:30:00.000Z');

      const row = prisma.rowsFor(USER)[0];
      expect(row.tzUsed).toBe('America/Los_Angeles');
      expect(dateKey(row.activityDate)).toBe('2026-04-10');
    });

    it('a later timezone change never rewrites an existing row — new rows use the new zone', async () => {
      await attemptAt('2026-04-10T12:00:30.000Z');

      prisma.profiles.set(USER, {
        timezone: 'Europe/Madrid',
        dailyGoalMinutes: 5,
        streakFreezes: STREAK_FREEZE_MAX,
        streakFreezesGrantedAt: null,
      });
      await attemptAt('2026-04-11T12:00:30.000Z');

      const rows = prisma.rowsFor(USER);
      expect(rows[0].tzUsed).toBe('UTC');
      expect(dateKey(rows[0].activityDate)).toBe('2026-04-10');
      expect(rows[1].tzUsed).toBe('Europe/Madrid');
    });
  });

  // ===========================================================================
  // `goal_met` is monotonic (§2.3)
  // ===========================================================================

  describe('goal_met', () => {
    it('flips true the first time the day’s seconds reach the goal', async () => {
      prisma.profiles.set(USER, {
        timezone: 'UTC',
        dailyGoalMinutes: 1,
        streakFreezes: STREAK_FREEZE_MAX,
        streakFreezesGrantedAt: null,
      });

      await attemptAt('2026-04-10T12:00:30.000Z');
      expect(prisma.rowsFor(USER)[0].goalMet).toBe(false);

      await attemptAt('2026-04-10T12:01:00.000Z');
      expect(prisma.rowsFor(USER)[0].practiceSeconds).toBe(60);
      expect(prisma.rowsFor(USER)[0].goalMet).toBe(true);
    });

    it('does NOT flip back when the learner later raises their daily goal', async () => {
      prisma.profiles.set(USER, {
        timezone: 'UTC',
        dailyGoalMinutes: 1,
        streakFreezes: STREAK_FREEZE_MAX,
        streakFreezesGrantedAt: null,
      });

      await attemptAt('2026-04-10T12:01:00.000Z');
      expect(prisma.rowsFor(USER)[0].goalMet).toBe(true);

      // Noon: the learner raises the bar to 15 minutes. The morning they
      // already earned is not retroactively failed.
      prisma.profiles.set(USER, {
        timezone: 'UTC',
        dailyGoalMinutes: 15,
        streakFreezes: STREAK_FREEZE_MAX,
        streakFreezesGrantedAt: null,
      });

      await attemptAt('2026-04-10T12:01:30.000Z');

      const row = prisma.rowsFor(USER)[0];
      expect(row.practiceSeconds).toBeLessThan(15 * 60);
      expect(row.goalMet).toBe(true);
    });

    it('a completion can be the event that earns the day', async () => {
      prisma.profiles.set(USER, {
        timezone: 'UTC',
        dailyGoalMinutes: 1,
        streakFreezes: STREAK_FREEZE_MAX,
        streakFreezesGrantedAt: null,
      });

      await attemptAt('2026-04-10T12:00:30.000Z');
      expect(prisma.rowsFor(USER)[0].goalMet).toBe(false);

      const completedAt = new Date('2026-04-10T12:01:00.000Z');
      clock.set(completedAt);
      await service.recordSessionCompletionActivity(USER, { sessionId: SESSION, completedAt });

      expect(prisma.rowsFor(USER)[0].goalMet).toBe(true);
    });
  });

  // ===========================================================================
  // ATTEMPT_SECONDS_CAP (§2.3)
  // ===========================================================================

  describe('ATTEMPT_SECONDS_CAP', () => {
    it('caps a single event’s slice — a tab left open overnight is not nine hours of practice', async () => {
      await attemptAt('2026-04-10T21:00:00.000Z');

      expect(prisma.rowsFor(USER)[0].practiceSeconds).toBe(ATTEMPT_SECONDS_CAP);
    });

    it('caps each event independently, measuring from the previous attempt', async () => {
      await attemptAt('2026-04-10T21:00:00.000Z');
      await attemptAt('2026-04-10T22:00:00.000Z');

      expect(prisma.rowsFor(USER)[0].practiceSeconds).toBe(ATTEMPT_SECONDS_CAP * 2);
    });

    it('never subtracts time: a backwards interval floors at zero', async () => {
      const answeredAt = new Date('2026-04-10T11:59:00.000Z'); // before the session started
      clock.set(answeredAt);
      await service.recordAttemptActivity(USER, {
        sessionId: SESSION,
        answeredAt,
        outcome: 'correct',
      });

      expect(prisma.rowsFor(USER)[0].practiceSeconds).toBe(0);
    });

    it('reads no client-supplied duration — only server timestamps (§2.3)', async () => {
      // There is no field on either accrual method a client duration could
      // reach; this asserts the shape rather than a value.
      await attemptAt('2026-04-10T12:00:45.000Z');
      expect(prisma.rowsFor(USER)[0].practiceSeconds).toBe(45);
    });
  });

  // ===========================================================================
  // Settlement — replenishment (§4.3)
  // ===========================================================================

  describe('freeze replenishment', () => {
    beforeEach(() => {
      prisma.profiles.set(USER, {
        timezone: 'UTC',
        dailyGoalMinutes: 5,
        streakFreezes: 0,
        streakFreezesGrantedAt: null,
      });
    });

    it('grants at most one per interval, and never a second inside the same interval', async () => {
      const first = await service.getSummary(USER);
      expect(first.freezes.remaining).toBe(1);
      expect(prisma.profiles.get(USER)!.streakFreezesGrantedAt).toEqual(SESSION_START);

      const second = await service.getSummary(USER);
      expect(second.freezes.remaining).toBe(1);

      clock.set(new Date('2026-04-16T12:00:00.000Z')); // six days later
      const third = await service.getSummary(USER);
      expect(third.freezes.remaining).toBe(1);
    });

    it('grants the next one once the interval has elapsed', async () => {
      await service.getSummary(USER);

      const later = new Date(SESSION_START.getTime() + FREEZE_REPLENISH_INTERVAL_DAYS * 86_400_000);
      clock.set(later);

      expect((await service.getSummary(USER)).freezes.remaining).toBe(STREAK_FREEZE_MAX);
    });

    it('stops at the ceiling', async () => {
      clock.set(new Date('2026-06-01T12:00:00.000Z'));
      expect((await service.getSummary(USER)).freezes.remaining).toBe(1);

      clock.set(new Date('2026-08-01T12:00:00.000Z'));
      expect((await service.getSummary(USER)).freezes.remaining).toBe(STREAK_FREEZE_MAX);

      clock.set(new Date('2026-10-01T12:00:00.000Z'));
      expect((await service.getSummary(USER)).freezes.remaining).toBe(STREAK_FREEZE_MAX);
      expect(prisma.profiles.get(USER)!.streakFreezes).toBe(STREAK_FREEZE_MAX);
    });
  });

  // ===========================================================================
  // Settlement — consumption, and its bound (§4.4-§4.5)
  // ===========================================================================

  describe('freeze settlement', () => {
    /** A day the learner met their goal on, written straight into the store. */
    function seedMetDay(date: string): void {
      prisma.activity.set(`${USER}|${date}`, {
        userId: USER,
        activityDate: new Date(`${date}T00:00:00.000Z`),
        tzUsed: 'UTC',
        practiceSeconds: 600,
        attempts: 5,
        correct: 5,
        goalMet: true,
        freezeUsed: false,
      });
    }

    it('covers a missed day inside a real streak by WRITING a row, and spends a freeze for it', async () => {
      seedMetDay('2026-04-07');
      seedMetDay('2026-04-08');

      const summary = await service.getSummary(USER);

      const freezeRow = prisma.rowOn(USER, '2026-04-09');
      expect(freezeRow).toBeDefined();
      expect(freezeRow).toMatchObject({
        freezeUsed: true,
        goalMet: false,
        attempts: 0,
        correct: 0,
        practiceSeconds: 0,
      });
      expect(summary.freezes.remaining).toBe(STREAK_FREEZE_MAX - 1);
      expect(prisma.profiles.get(USER)!.streakFreezes).toBe(STREAK_FREEZE_MAX - 1);
      // And the streak it protected is whole: 07, 08, 09 (frozen).
      expect(summary.streak.current).toBe(3);
    });

    it('is bounded by the look-back — a learner back after a month gets no month of protection', async () => {
      seedMetDay('2026-03-01');
      prisma.profiles.set(USER, {
        timezone: 'UTC',
        dailyGoalMinutes: 5,
        // Deliberately far above the ceiling, so the LOOK-BACK is the only
        // thing that can stop the walk.
        streakFreezes: 99,
        streakFreezesGrantedAt: SESSION_START,
      });

      await service.getSummary(USER);

      const frozen = prisma
        .rowsFor(USER)
        .filter((row) => row.freezeUsed)
        .map((row) => dateKey(row.activityDate));

      expect(frozen).toHaveLength(FREEZE_SETTLE_LOOKBACK_DAYS);
      expect(frozen[0]).toBe('2026-04-03');
      expect(frozen[frozen.length - 1]).toBe('2026-04-09');
      expect(prisma.rowOn(USER, '2026-04-02')).toBeUndefined();
    });

    it('spends nothing before the learner’s first-ever active day', async () => {
      const summary = await service.getSummary(USER);

      expect(prisma.rowsFor(USER)).toHaveLength(0);
      expect(summary.freezes.remaining).toBe(STREAK_FREEZE_MAX);
      expect(summary.streak).toEqual({ current: 0, longest: 0 });
    });

    it('is idempotent: a second call writes nothing and reports the same balance', async () => {
      seedMetDay('2026-04-07');
      seedMetDay('2026-04-08');
      // A recent grant, so replenishment is not due and this test is about
      // CONSUMPTION alone: the property at stake is §4.4's first reason — a
      // repeated settlement pass over the same gap day must never spend a
      // second freeze on it.
      prisma.profiles.set(USER, {
        timezone: 'UTC',
        dailyGoalMinutes: 5,
        streakFreezes: STREAK_FREEZE_MAX,
        streakFreezesGrantedAt: SESSION_START,
      });

      const first = await service.getSummary(USER);
      const rowsAfterFirst = prisma.rowsFor(USER).map((row) => ({ ...row }));
      const profileAfterFirst = { ...prisma.profiles.get(USER)! };

      const second = await service.getSummary(USER);

      expect(prisma.rowsFor(USER)).toEqual(rowsAfterFirst);
      expect(prisma.profiles.get(USER)).toEqual(profileAfterFirst);
      expect(second.freezes.remaining).toBe(first.freezes.remaining);
      expect(second.streak).toEqual(first.streak);
    });

    it('never touches TODAY — that row belongs to accrual', async () => {
      seedMetDay('2026-04-08');
      seedMetDay('2026-04-09');

      await service.getSummary(USER);

      expect(prisma.rowOn(USER, '2026-04-10')).toBeUndefined();
    });
  });

  // ===========================================================================
  // The summary itself (§4.6)
  // ===========================================================================

  describe('getSummary', () => {
    it('reports honest zeros for a day with no row yet, and never a null `today`', async () => {
      const summary = await service.getSummary(USER);

      expect(summary.today).toEqual({
        date: '2026-04-10',
        practiceSeconds: 0,
        attempts: 0,
        correct: 0,
        goalMet: false,
      });
      expect(summary.dailyGoalMinutes).toBe(5);
      expect(summary.timezone).toBe('UTC');
      expect(summary.freezes.max).toBe(STREAK_FREEZE_MAX);
    });

    it('reflects the day accrual just wrote', async () => {
      await attemptAt('2026-04-10T12:00:45.000Z');
      clock.set(new Date('2026-04-10T13:00:00.000Z'));

      const summary = await service.getSummary(USER);

      expect(summary.today).toMatchObject({
        date: '2026-04-10',
        practiceSeconds: 45,
        attempts: 1,
        correct: 1,
      });
    });

    it('returns exactly 14 recent days, oldest first, ending today', async () => {
      const summary = await service.getSummary(USER);

      expect(summary.recentDays).toHaveLength(14);
      expect(summary.recentDays[0].date).toBe('2026-03-28');
      expect(summary.recentDays[13].date).toBe('2026-04-10');
    });

    it('reports only the caller’s own data', async () => {
      prisma.activity.set(`${OTHER_USER}|2026-04-10`, {
        userId: OTHER_USER,
        activityDate: new Date('2026-04-10T00:00:00.000Z'),
        tzUsed: 'UTC',
        practiceSeconds: 999,
        attempts: 9,
        correct: 9,
        goalMet: true,
        freezeUsed: false,
      });

      const summary = await service.getSummary(USER);

      expect(summary.today.practiceSeconds).toBe(0);
      expect(summary.today.goalMet).toBe(false);
      expect(summary.streak.current).toBe(0);
    });

    it('a learner with no learner_profiles row still gets an honest summary, and no write is attempted', async () => {
      prisma.profiles.delete(USER);

      const summary = await service.getSummary(USER);

      expect(summary.timezone).toBe('UTC');
      expect(summary.today.goalMet).toBe(false);
      expect(prisma.rowsFor(USER)).toHaveLength(0);
    });
  });
});
