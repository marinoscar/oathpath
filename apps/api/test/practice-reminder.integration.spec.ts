import { randomUUID } from 'node:crypto';

import { clockOverrideStorage } from '../src/common/clock/clock';
import { DEFAULT_STUDY_REMINDER_HOUR } from '../src/common/schemas/user-settings-namespaces.schema';
import type { UserSettingsValue } from '../src/common/types/settings.types';
import {
  PracticeReminderTask,
  type PracticeReminderRunSummary,
} from '../src/engagement/tasks/practice-reminder.task';
import { NotificationsService } from '../src/notifications/notifications.service';
import { closeTestApp, createTestApp, TestContext } from './helpers/test-app.helper';
import { setupBaseMocks } from './fixtures/mock-setup.helper';
import { prismaMock, resetPrismaMock } from './mocks/prisma.mock';

// =============================================================================
// PracticeReminderTask (integration) — epic #56 / E7 "Habit"
// =============================================================================
//
// `docs/specs/habit-streaks.md` §6, driven the way §6's own test requirement
// asks for: the task is INVOKED DIRECTLY, with the clock pinned, against a
// small in-memory Prisma store.
//
// -----------------------------------------------------------------------------
// WHY THE TASK IS CALLED DIRECTLY AND NOT LEFT TO THE SCHEDULER
// -----------------------------------------------------------------------------
//
// `@Cron(EVERY_HOUR)` fires at the top of the hour of whatever machine the
// suite happens to run on. A test that waited for it would either sleep for up
// to an hour or assert nothing; a test that called `CronJob.fireOnTick` would
// be testing `@nestjs/schedule`. What is worth testing is the SELECTION — and
// that is `run()`, which is public precisely so this file can call it.
//
// -----------------------------------------------------------------------------
// WHY THE CLOCK IS PINNED, AND WHY THREE TIMEZONES
// -----------------------------------------------------------------------------
//
// The entire justification for an hourly cron is that "9am their time" is a
// different UTC instant per learner. A single-timezone test cannot tell a
// correct implementation from one that compares against the SERVER's hour and
// happens to be right in CI's zone. So every assertion below runs three
// learners — Tokyo (UTC+9), Berlin (UTC+1 in January), Los Angeles (UTC-8) —
// through the same three firings, and each learner must be selected at exactly
// one of them.
//
// -----------------------------------------------------------------------------
// THE REAL NotificationsService, NOT A STUB
// -----------------------------------------------------------------------------
//
// `notify` is spied on (and left running) rather than replaced, because two of
// the properties this file has to prove live BELOW the task: a learner who
// muted the event receives nothing, and `streak.at_risk`'s `defaultEnabled:
// false` means an untouched account is not sent it. Both are decisions the
// dispatcher makes after the task has already called `notify`, so a stubbed
// `notify` would report them as delivered. What actually went out is read off
// `notification_deliveries` — the same table §6.3's "already reminded today"
// query reads, which is what makes the repeat-run test meaningful rather than
// circular.
//
// No test in this repository touches a database (docs/TESTING.md).
// =============================================================================

/** One learner in the in-memory world. */
interface Learner {
  userId: string;
  email: string;
  timezone: string;
  dailyGoalMinutes: number;
  streakFreezes: number;
  settings?: UserSettingsValue;
  days: { date: string; goalMet: boolean; freezeUsed: boolean }[];
  mastery: {
    state: string;
    dueAt: Date | null;
    lapses: number;
    correctStreak: number;
    lastAttemptAt: Date | null;
  }[];
}

interface DeliveryRow {
  id: string;
  eventKey: string;
  userId: string | null;
  recipient: string;
  channel: string;
  status: string;
  createdAt: Date;
}

// Three zones, three offsets, one January day. January is chosen so that none
// of the three is inside a DST transition — the offsets below are stable for
// the whole day, which keeps these instants readable.
const TOKYO = 'Asia/Tokyo'; // UTC+9  -> 09:00 local at 00:00Z
const BERLIN = 'Europe/Berlin'; // UTC+1  -> 09:00 local at 08:00Z
const LOS_ANGELES = 'America/Los_Angeles'; // UTC-8 -> 09:00 local at 17:00Z

const TOKYO_9AM = new Date('2026-01-15T00:00:00.000Z');
const BERLIN_9AM = new Date('2026-01-15T08:00:00.000Z');
const LOS_ANGELES_9AM = new Date('2026-01-15T17:00:00.000Z');

/** A settings value carrying only what a given test cares about. */
function settings(partial: Partial<UserSettingsValue>): UserSettingsValue {
  return {
    theme: 'system',
    profile: { useProviderImage: true },
    ...partial,
  };
}

describe('PracticeReminderTask (hourly practice reminders)', () => {
  let ctx: TestContext;
  let task: PracticeReminderTask;
  let notifications: NotificationsService;
  let notifySpy: jest.SpyInstance;

  /** The in-memory world, rebuilt per test. */
  let learners: Learner[];
  let deliveries: DeliveryRow[];
  /** The instant the current run is pinned to; the delivery store stamps with it. */
  let pinned: Date;

  beforeAll(async () => {
    ctx = await createTestApp({ useMockDatabase: true });
    task = ctx.module.get(PracticeReminderTask);
    notifications = ctx.module.get(NotificationsService);
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    learners = [];
    deliveries = [];
    pinned = TOKYO_9AM;

    notifySpy = jest.spyOn(notifications, 'notify');

    const find = (userId: string): Learner | undefined =>
      learners.find((learner) => learner.userId === userId);

    // --- learner_profiles ---------------------------------------------------
    (prismaMock.learnerProfile.findMany as jest.Mock).mockImplementation(
      async () =>
        learners.map((learner) => ({
          userId: learner.userId,
          timezone: learner.timezone,
          dailyGoalMinutes: learner.dailyGoalMinutes,
          streakFreezes: learner.streakFreezes,
        })),
    );

    // --- user_settings ------------------------------------------------------
    (prismaMock.userSettings.findMany as jest.Mock).mockImplementation(
      async ({ where }: any) => {
        const ids: string[] = where?.userId?.in ?? [];
        return learners
          .filter(
            (learner) =>
              ids.includes(learner.userId) && learner.settings !== undefined,
          )
          .map((learner) => ({
            userId: learner.userId,
            value: learner.settings,
          }));
      },
    );

    // --- daily_activity -----------------------------------------------------
    (prismaMock.dailyActivity.findMany as jest.Mock).mockImplementation(
      async ({ where }: any) =>
        (find(where.userId)?.days ?? []).map((day) => ({
          activityDate: new Date(`${day.date}T00:00:00.000Z`),
          goalMet: day.goalMet,
          freezeUsed: day.freezeUsed,
        })),
    );

    // --- question_mastery ---------------------------------------------------
    (prismaMock.questionMastery.findMany as jest.Mock).mockImplementation(
      async ({ where }: any) => find(where.userId)?.mastery ?? [],
    );

    // --- users (the dispatcher's recipient lookup) --------------------------
    (prismaMock.user.findUnique as jest.Mock).mockImplementation(
      async ({ where }: any) => {
        const learner = find(where.id);
        if (!learner) return null;
        return {
          id: learner.userId,
          email: learner.email,
          userSettings: learner.settings ? { value: learner.settings } : null,
        };
      },
    );

    // --- notification_deliveries -------------------------------------------
    //
    // A real little store rather than a canned return, because §6.3's filter
    // is precisely "is there a row in this learner's local day", and a
    // `mockResolvedValue(null)` would make the repeat-run assertion pass for
    // an implementation that never queried at all.
    (prismaMock.notificationDelivery.create as jest.Mock).mockImplementation(
      async ({ data }: any) => {
        const row: DeliveryRow = {
          id: randomUUID(),
          eventKey: data.eventKey,
          userId: data.userId ?? null,
          recipient: data.recipient,
          channel: data.channel,
          status: data.status ?? 'queued',
          createdAt: new Date(pinned),
        };
        deliveries.push(row);
        return row;
      },
    );

    (prismaMock.notificationDelivery.update as jest.Mock).mockImplementation(
      async ({ where, data }: any) => {
        const row = deliveries.find((delivery) => delivery.id === where.id);
        if (row && typeof data.status === 'string') {
          row.status = data.status;
        }
        return row ?? null;
      },
    );

    (prismaMock.notificationDelivery.findFirst as jest.Mock).mockImplementation(
      async ({ where }: any) => {
        const keys: string[] = where.eventKey?.in ?? [];
        const gte: Date = where.createdAt.gte;
        const lt: Date = where.createdAt.lt;

        const row = deliveries.find(
          (delivery) =>
            delivery.userId === where.userId &&
            keys.includes(delivery.eventKey) &&
            delivery.createdAt.getTime() >= gte.getTime() &&
            delivery.createdAt.getTime() < lt.getTime(),
        );

        return row ? { id: row.id } : null;
      },
    );

    // The browser channel's inbox row. Its content is asserted by that
    // channel's own suite; here it only has to exist so a delivery can succeed.
    (prismaMock.notification.create as jest.Mock).mockImplementation(
      async ({ data }: any) => ({
        id: randomUUID(),
        readAt: null,
        // Stamped with the pinned instant, and present because the channel
        // serialises the row it just wrote onto the stream. A row without it
        // makes every browser delivery a caught, recorded failure — which the
        // task would survive, and which would quietly stop this suite from
        // exercising the browser half at all.
        createdAt: new Date(pinned),
        ...data,
      }),
    );
  });

  afterEach(() => {
    notifySpy.mockRestore();
  });

  /** Add a learner to the world, with sensible empty defaults. */
  function addLearner(over: Partial<Learner> & { timezone: string }): Learner {
    const learner: Learner = {
      userId: randomUUID(),
      email: `learner-${learners.length}@example.com`,
      dailyGoalMinutes: 5,
      streakFreezes: 2,
      days: [],
      mastery: [],
      ...over,
    };
    learners.push(learner);
    return learner;
  }

  /**
   * Run the task at `instant`, then wait for every detached dispatch it
   * scheduled — so the delivery rows exist before anything is asserted.
   */
  async function runAt(instant: Date): Promise<PracticeReminderRunSummary> {
    pinned = instant;
    const summary = await clockOverrideStorage.run({ now: instant }, () =>
      task.run(),
    );
    await notifications.flush();
    return summary;
  }

  /** Which (userId, eventKey) pairs the task decided to raise. */
  function raised(): { userId: string; eventKey: string }[] {
    return notifySpy.mock.calls.map(([eventKey, userId]) => ({
      userId: userId as string,
      eventKey: eventKey as string,
    }));
  }

  /** Event keys actually recorded as delivered (any channel) for one learner. */
  function deliveredTo(userId: string): string[] {
    return [
      ...new Set(
        deliveries
          .filter((delivery) => delivery.userId === userId)
          .map((delivery) => delivery.eventKey),
      ),
    ];
  }

  // ===========================================================================
  // §6.1 step 2 — each learner's OWN local hour
  // ===========================================================================

  describe('local hour selection across three timezones', () => {
    it('reminds each learner at their own 9am, and at nobody else\'s', async () => {
      const tokyo = addLearner({ timezone: TOKYO });
      const berlin = addLearner({ timezone: BERLIN });
      const la = addLearner({ timezone: LOS_ANGELES });

      await runAt(TOKYO_9AM);
      expect(raised()).toEqual([
        { userId: tokyo.userId, eventKey: 'practice.daily_reminder' },
      ]);

      notifySpy.mockClear();
      await runAt(BERLIN_9AM);
      expect(raised()).toEqual([
        { userId: berlin.userId, eventKey: 'practice.daily_reminder' },
      ]);

      notifySpy.mockClear();
      await runAt(LOS_ANGELES_9AM);
      expect(raised()).toEqual([
        { userId: la.userId, eventKey: 'practice.daily_reminder' },
      ]);
    });

    it('sends nothing at an hour that is nobody\'s reminder hour', async () => {
      addLearner({ timezone: TOKYO });
      addLearner({ timezone: BERLIN });
      addLearner({ timezone: LOS_ANGELES });

      // 03:00Z: 12:00 in Tokyo, 04:00 in Berlin, 19:00 the previous day in
      // Los Angeles. None of the three is at hour 9.
      const summary = await runAt(new Date('2026-01-15T03:00:00.000Z'));

      expect(summary.reminded).toBe(0);
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('honours a chosen reminderHour instead of the built-in default', async () => {
      const early = addLearner({
        timezone: BERLIN,
        settings: settings({ study: { reminderHour: 6 } }),
      });

      // 06:00 Berlin is 05:00Z — an hour the default-9 learner beside them is
      // not selected at.
      addLearner({ timezone: BERLIN });

      const summary = await runAt(new Date('2026-01-15T05:00:00.000Z'));

      expect(summary.reminded).toBe(1);
      expect(raised()).toEqual([
        { userId: early.userId, eventKey: 'practice.daily_reminder' },
      ]);
    });

    it('treats an absent `study` namespace as the built-in default hour', async () => {
      // The sparse contract, asserted rather than assumed: nothing is written
      // to `user_settings` to make an untouched account eligible.
      const learner = addLearner({ timezone: TOKYO });
      expect(DEFAULT_STUDY_REMINDER_HOUR).toBe(9);

      await runAt(TOKYO_9AM);

      expect(raised()).toEqual([
        { userId: learner.userId, eventKey: 'practice.daily_reminder' },
      ]);
    });
  });

  // ===========================================================================
  // §6.2 — the ladder
  // ===========================================================================

  describe('the ladder picks exactly one event per learner', () => {
    it('streak.at_risk for an active streak with no freeze left', async () => {
      const learner = addLearner({
        timezone: TOKYO,
        streakFreezes: 0,
        days: [
          { date: '2026-01-13', goalMet: true, freezeUsed: false },
          { date: '2026-01-14', goalMet: true, freezeUsed: false },
        ],
        // Opted IN explicitly: `streak.at_risk` is `defaultEnabled: false`, so
        // an untouched account is not sent it at all (asserted below).
        settings: settings({
          notifications: {
            email: { 'streak.at_risk': true },
            browser: { 'streak.at_risk': true },
          },
        }),
      });

      await runAt(TOKYO_9AM);

      expect(raised()).toEqual([
        { userId: learner.userId, eventKey: 'streak.at_risk' },
      ]);
      expect(deliveredTo(learner.userId)).toEqual(['streak.at_risk']);
    });

    it('never sends streak.at_risk to a learner who never asked for it', async () => {
      // Same evidence as above, no stored preference. The task still SELECTS
      // the event — the ladder is about what is true, not about what is
      // enabled — and the dispatcher then drops it, writing no delivery row.
      // That split is deliberate: the "which message" decision and the "may we
      // send it" decision have one owner each.
      const learner = addLearner({
        timezone: TOKYO,
        streakFreezes: 0,
        days: [
          { date: '2026-01-13', goalMet: true, freezeUsed: false },
          { date: '2026-01-14', goalMet: true, freezeUsed: false },
        ],
      });

      await runAt(TOKYO_9AM);

      expect(raised()).toEqual([
        { userId: learner.userId, eventKey: 'streak.at_risk' },
      ]);
      expect(deliveredTo(learner.userId)).toEqual([]);
    });

    it('practice.review_due when a freeze still covers the streak', async () => {
      // Same streak, but a freeze in hand — so rung 1 does not apply, and the
      // learner has due questions waiting.
      const learner = addLearner({
        timezone: TOKYO,
        streakFreezes: 1,
        days: [
          { date: '2026-01-13', goalMet: true, freezeUsed: false },
          { date: '2026-01-14', goalMet: true, freezeUsed: false },
        ],
        mastery: [
          {
            state: 'review',
            dueAt: new Date('2026-01-14T00:00:00.000Z'),
            lapses: 0,
            correctStreak: 3,
            lastAttemptAt: new Date('2026-01-14T00:00:00.000Z'),
          },
          {
            state: 'lapsed',
            dueAt: new Date('2026-02-01T00:00:00.000Z'),
            lapses: 3,
            correctStreak: 0,
            lastAttemptAt: new Date('2026-01-10T00:00:00.000Z'),
          },
        ],
      });

      await runAt(TOKYO_9AM);

      expect(raised()).toEqual([
        { userId: learner.userId, eventKey: 'practice.review_due' },
      ]);
      // The count in the payload is `due + weak` — one of each above.
      expect(notifySpy.mock.calls[0]?.[2]).toMatchObject({ reviewCount: 2 });
    });

    it('practice.daily_reminder when there is nothing specific to name', async () => {
      const learner = addLearner({
        timezone: TOKYO,
        dailyGoalMinutes: 15,
        mastery: [
          // A question that is neither due nor weak: not a review candidate.
          {
            state: 'review',
            dueAt: new Date('2026-02-20T00:00:00.000Z'),
            lapses: 0,
            correctStreak: 4,
            lastAttemptAt: new Date('2026-01-10T00:00:00.000Z'),
          },
        ],
      });

      await runAt(TOKYO_9AM);

      expect(raised()).toEqual([
        { userId: learner.userId, eventKey: 'practice.daily_reminder' },
      ]);
      // The learner's OWN goal travels in the payload, never a constant.
      expect(notifySpy.mock.calls[0]?.[2]).toMatchObject({
        dailyGoalMinutes: 15,
      });
    });

    it('sends exactly one event to a learner every rung could claim', async () => {
      // Streak at risk AND questions due AND no practice today. Three rungs
      // are true; one message goes out.
      const learner = addLearner({
        timezone: TOKYO,
        streakFreezes: 0,
        days: [
          { date: '2026-01-13', goalMet: true, freezeUsed: false },
          { date: '2026-01-14', goalMet: true, freezeUsed: false },
        ],
        mastery: [
          {
            state: 'review',
            dueAt: new Date('2026-01-01T00:00:00.000Z'),
            lapses: 0,
            correctStreak: 2,
            lastAttemptAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
        settings: settings({
          notifications: {
            email: { 'streak.at_risk': true },
            browser: { 'streak.at_risk': true },
          },
        }),
      });

      const summary = await runAt(TOKYO_9AM);

      expect(notifySpy).toHaveBeenCalledTimes(1);
      expect(summary.reminded).toBe(1);
      expect(raised()[0]).toEqual({
        userId: learner.userId,
        eventKey: 'streak.at_risk',
      });
    });
  });

  // ===========================================================================
  // §6.1 steps 1, 3 and 4 — the exclusions
  // ===========================================================================

  describe('exclusions', () => {
    it('says nothing to a learner who already met today\'s goal', async () => {
      addLearner({
        timezone: TOKYO,
        days: [{ date: '2026-01-15', goalMet: true, freezeUsed: false }],
      });

      const summary = await runAt(TOKYO_9AM);

      expect(summary.reminded).toBe(0);
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('still reminds a learner who has practised today but not met the goal', async () => {
      // The filter is `goalMet !== true`, not "has a row today" — a learner
      // two minutes into a five-minute goal has not finished.
      const learner = addLearner({
        timezone: TOKYO,
        days: [{ date: '2026-01-15', goalMet: false, freezeUsed: false }],
      });

      await runAt(TOKYO_9AM);

      expect(raised()).toEqual([
        { userId: learner.userId, eventKey: 'practice.daily_reminder' },
      ]);
    });

    it('says nothing to a learner who set study.reminderEnabled to false', async () => {
      const learner = addLearner({
        timezone: TOKYO,
        settings: settings({ study: { reminderEnabled: false } }),
      });

      const summary = await runAt(TOKYO_9AM);

      expect(summary.reminded).toBe(0);
      expect(notifySpy).not.toHaveBeenCalled();
      expect(deliveredTo(learner.userId)).toEqual([]);
    });

    it('delivers nothing to a learner who muted the event on every channel', async () => {
      // §7.1's other control: the cron still considers them (their habit
      // reminders are on), the ladder still picks an event, and the dispatcher
      // refuses to deliver it. No delivery row at all — a muted event is not
      // recorded as a failed send.
      const learner = addLearner({
        timezone: TOKYO,
        settings: settings({
          notifications: {
            email: { 'practice.daily_reminder': false },
            browser: { 'practice.daily_reminder': false },
          },
        }),
      });

      await runAt(TOKYO_9AM);

      expect(raised()).toEqual([
        { userId: learner.userId, eventKey: 'practice.daily_reminder' },
      ]);
      expect(deliveredTo(learner.userId)).toEqual([]);
    });

    it('reminds a learner only once per local day, however often the task runs', async () => {
      // §6.3. The second firing is the same instant — the DST fall-back case,
      // and the retry case — and the delivery rows the first firing wrote are
      // what excludes the learner from it.
      const learner = addLearner({ timezone: TOKYO });

      const first = await runAt(TOKYO_9AM);
      expect(first.reminded).toBe(1);
      expect(deliveredTo(learner.userId)).toEqual(['practice.daily_reminder']);

      notifySpy.mockClear();
      const second = await runAt(TOKYO_9AM);

      expect(second.reminded).toBe(0);
      expect(notifySpy).not.toHaveBeenCalled();
      // Still exactly the one day's worth of rows.
      expect(deliveredTo(learner.userId)).toEqual(['practice.daily_reminder']);
    });

    it('reminds again the next local day', async () => {
      // The other half of the same rule: yesterday's row must not silence
      // today. The bounds are the learner's own local day, not 24 hours.
      const learner = addLearner({ timezone: TOKYO });

      await runAt(TOKYO_9AM);
      notifySpy.mockClear();

      const nextDay = await runAt(new Date('2026-01-16T00:00:00.000Z'));

      expect(nextDay.reminded).toBe(1);
      expect(raised()).toEqual([
        { userId: learner.userId, eventKey: 'practice.daily_reminder' },
      ]);
    });

    it("one learner's yesterday is another learner's today", async () => {
      // The reason §6.3's bounds are per-learner: at 00:00Z on Jan 15 it is
      // already Jan 15 in Tokyo but still Jan 14 in Los Angeles. A UTC-day
      // window would have to be wrong for one of them.
      const tokyo = addLearner({ timezone: TOKYO });
      const la = addLearner({ timezone: LOS_ANGELES });

      await runAt(TOKYO_9AM); // 09:00 Jan 15 in Tokyo
      notifySpy.mockClear();

      // 17:00Z on Jan 14 is 09:00 Jan 14 in Los Angeles — a different local
      // day from Tokyo's, and one Tokyo's delivery row must not close.
      await runAt(new Date('2026-01-14T17:00:00.000Z'));

      expect(raised()).toEqual([
        { userId: la.userId, eventKey: 'practice.daily_reminder' },
      ]);
      expect(deliveredTo(tokyo.userId)).toEqual(['practice.daily_reminder']);
      expect(deliveredTo(la.userId)).toEqual(['practice.daily_reminder']);
    });
  });

  // ===========================================================================
  // Containment
  // ===========================================================================

  describe('one learner cannot end the run', () => {
    it('skips a learner whose stored timezone is not a real zone and reminds the rest', async () => {
      addLearner({ timezone: 'Mars/Olympus_Mons' });
      const tokyo = addLearner({ timezone: TOKYO });

      const summary = await runAt(TOKYO_9AM);

      expect(summary.errors).toBe(1);
      expect(summary.reminded).toBe(1);
      expect(raised()).toEqual([
        { userId: tokyo.userId, eventKey: 'practice.daily_reminder' },
      ]);
    });

    it('handleCron sends the same reminders run() decides on', async () => {
      // The scheduled entry point is thin, but "thin" is a claim worth
      // checking: a `@Cron` method that forgot to await its own work would
      // still pass every other test in this file.
      const learner = addLearner({ timezone: TOKYO });

      pinned = TOKYO_9AM;
      await clockOverrideStorage.run({ now: TOKYO_9AM }, () => task.handleCron());
      await notifications.flush();

      expect(raised()).toEqual([
        { userId: learner.userId, eventKey: 'practice.daily_reminder' },
      ]);
    });

    it('handleCron never rejects, even when the run itself cannot start', async () => {
      // A rejected promise out of a `@Cron` method is an unhandled rejection
      // with nothing naming the job that produced it.
      (prismaMock.learnerProfile.findMany as jest.Mock).mockRejectedValue(
        new Error('database is down'),
      );

      await expect(
        clockOverrideStorage.run({ now: TOKYO_9AM }, () => task.handleCron()),
      ).resolves.toBeUndefined();
    });

    it('does nothing at all when no learner has a profile', async () => {
      const summary = await runAt(TOKYO_9AM);

      expect(summary).toMatchObject({ candidates: 0, reminded: 0, errors: 0 });
      expect(prismaMock.userSettings.findMany).not.toHaveBeenCalled();
    });
  });
});
