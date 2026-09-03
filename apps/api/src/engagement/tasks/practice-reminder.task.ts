import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { Clock } from '../../common/clock/clock';
import {
  DEFAULT_STUDY_REMINDER_ENABLED,
  DEFAULT_STUDY_REMINDER_HOUR,
  type StudyValue,
} from '../../common/schemas/user-settings-namespaces.schema';
import type { UserSettingsValue } from '../../common/types/settings.types';
import type {
  PracticeDailyReminderEmailData,
  PracticeReviewDueEmailData,
  StreakAtRiskEmailData,
} from '../../email';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  classifyMasteryBucket,
  type QuestionMasterySnapshot,
} from '../../practice/mastery/selector';
import { PrismaService } from '../../prisma/prisma.service';
import { computeStreak, type StreakDay } from '../streaks/streak-engine';

// =============================================================================
// PracticeReminderTask (epic #56 / E7 "Habit")
// =============================================================================
//
// `docs/specs/habit-streaks.md` §6. The one trigger behind all three reminder
// events, and the only place in this application that decides a learner should
// hear from us about their study habit.
//
// The shape is `apps/api/src/auth/tasks/token-cleanup.task.ts`'s exactly —
// `@Injectable()` plus `@Cron(CronExpression...)`, registered in its own
// feature module's `providers` array, with no "tasks module" anywhere — and it
// sits beside `readiness/tasks/readiness-recompute.task.ts`, which made the
// same choice one epic earlier.
//
// -----------------------------------------------------------------------------
// WHY HOURLY, WHEN EVERY OTHER CRON IN THIS APPLICATION IS DAILY
// -----------------------------------------------------------------------------
//
// `token-cleanup.task.ts` and `readiness-recompute.task.ts` both run
// `EVERY_DAY_AT_3AM` — one fixed UTC instant, which reaches a Tokyo learner at
// noon and a Los Angeles learner at 7pm the evening before. That is fine for
// housekeeping and fatal for a reminder: "remind me at 9am" is a DIFFERENT UTC
// instant for every zone this application's learners are in, so no single
// daily expression can express it for more than one of them at a time.
//
// An hourly firing sidesteps the problem rather than approximating it. On each
// run the question is "whose local hour, right now, equals the hour they
// chose" — which is answerable for every zone at once, twenty-four times a day.
//
// -----------------------------------------------------------------------------
// EVERY NOTION OF "NOW" IN THIS FILE COMES FROM `Clock` — grep it for the bare
// `Date` constructor and the result is empty, comments included
// -----------------------------------------------------------------------------
//
// CLAUDE.md, "Using the Clock", and `apps/api/src/journey/` is the worked
// example this file follows: the local hour through `clock.localHourIn`, the
// local day through `clock.calendarDateIn`, that day's UTC bounds through
// `clock.localDayRangeIn`, and the instant the mastery buckets are classified
// against through `clock.now()`.
//
// Reading the host's clock directly — `getHours()` off a freshly constructed
// date — would report the API container's hour rather than the learner's, and
// would be unpinnable by `X-Test-Clock`, which is what makes the
// three-timezone integration test possible at all.
//
// -----------------------------------------------------------------------------
// THIS TASK NEVER SETTLES FREEZES, AND THAT IS DELIBERATE
// -----------------------------------------------------------------------------
//
// It reads `daily_activity` and calls the SAME pure engine
// `EngagementService.getSummary` calls (`computeStreak`) — never a second
// derivation of a streak — but it does not call `getSummary` itself, because
// that method settles freezes at the top and settlement WRITES (§4.4). §4.6
// fixes `GET /api/engagement/summary` as engagement's sole recompute trigger,
// deliberately unlike readiness's two; an hourly cron quietly becoming a
// second one would spend learners' freeze budgets in the background, on a
// schedule nobody asked for, for learners who never opened the app.
//
// The consequence is honest and bounded: this task sees the streak as it
// stands BEFORE any freeze that has not been settled yet. A learner still
// holding a freeze is excluded from `streak.at_risk` by the ladder anyway
// (§6.2), which is the only rung a stale settlement could affect.
// =============================================================================

/**
 * The three events this task can raise — the exact set §6.3's "already
 * reminded today" query looks for.
 *
 * ONE ARRAY, TWO USES, and they must not drift: if the ladder could send an
 * event this list omits, that event would not count as "already reminded" and
 * a learner could receive two reminders in one local day, which is the single
 * thing §6.2 exists to prevent.
 */
export const PRACTICE_REMINDER_EVENT_KEYS = [
  'practice.daily_reminder',
  'practice.review_due',
  'streak.at_risk',
] as const;

export type PracticeReminderEventKey =
  (typeof PRACTICE_REMINDER_EVENT_KEYS)[number];

/** What one firing did, for the log line and for a test to assert on. */
export interface PracticeReminderRunSummary {
  /** Learner profiles considered — every learner with a `learner_profiles` row. */
  candidates: number;
  /** Learners who survived all four of §6.1's filters and were sent something. */
  reminded: number;
  /** How many of each event went out. Keys are always all three, zeros included. */
  byEvent: Record<PracticeReminderEventKey, number>;
  /** Learners skipped because their own timezone or settings could not be read. */
  errors: number;
}

/** One learner's decision, made during the read pass and sent during the send pass. */
interface ReminderDecision {
  userId: string;
  eventKey: PracticeReminderEventKey;
  data:
    | PracticeDailyReminderEmailData
    | PracticeReviewDueEmailData
    | StreakAtRiskEmailData;
}

/** The `learner_profiles` columns this task reads — nothing wider. */
interface ReminderProfile {
  userId: string;
  timezone: string;
  dailyGoalMinutes: number;
  streakFreezes: number;
}

@Injectable()
export class PracticeReminderTask {
  private readonly logger = new Logger(PracticeReminderTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The scheduled entry point.
   *
   * Thin on purpose: everything below is in {@link run}, which returns a
   * summary rather than logging one, so an integration test can invoke the
   * task directly with a pinned clock and assert on what it decided — the
   * shape §6's own test requirement asks for.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleCron(): Promise<void> {
    try {
      const summary = await this.run();

      this.logger.log(
        { ...summary },
        `Practice reminder run completed: ${summary.reminded} reminder(s) sent to ${summary.candidates} candidate profile(s)`,
      );
    } catch (error) {
      // NOTHING ESCAPES A SCHEDULED METHOD. `run()` already contains every
      // per-learner failure, so reaching here means the run itself could not
      // proceed — the profile query failed, most plausibly. Rejecting out of a
      // `@Cron` method surfaces as an unhandled rejection with no context
      // about which job produced it; a named error line is what an operator
      // can act on, and the next firing is an hour away regardless.
      this.logger.error(
        { error: error instanceof Error ? error.message : error },
        'Practice reminder run failed before any learner was selected',
      );
    }
  }

  /**
   * One firing: select, decide, then send.
   *
   * THE THREE PHASES ARE SEPARATE AND ORDERED, and the order is §6.1's own
   * discipline extended from one request to a batch:
   *
   *   1. TWO BULK READS for every learner at once (profiles, settings), so
   *      the per-learner work below is not N round trips for a fact that is
   *      the same shape for all of them.
   *   2. A PER-LEARNER READ PASS for the ones whose local hour matches,
   *      deciding each learner's event and adding it to a list. Nothing is
   *      sent here.
   *   3. A SEND PASS over that list.
   *
   * `notify()` is therefore called after every read for this firing is
   * complete, and outside any transaction — never interleaving a read for
   * learner N+1 with a still-pending write for learner N, and never asking
   * `notify` (which is detached by design) to join a transaction it must not
   * be part of.
   */
  async run(): Promise<PracticeReminderRunSummary> {
    const summary: PracticeReminderRunSummary = {
      candidates: 0,
      reminded: 0,
      byEvent: {
        'practice.daily_reminder': 0,
        'practice.review_due': 0,
        'streak.at_risk': 0,
      },
      errors: 0,
    };

    // EVERY learner with a profile, exactly as the nightly readiness recompute
    // enumerates every profile. The set is bounded by the number of accounts,
    // and the two columns' worth of data per account is small; the expensive
    // per-learner reads below happen only for the ~1/24 of them whose local
    // hour matches on this firing.
    const profiles = (await this.prisma.learnerProfile.findMany({
      select: {
        userId: true,
        timezone: true,
        dailyGoalMinutes: true,
        streakFreezes: true,
      },
    })) as ReminderProfile[];

    summary.candidates = profiles.length;

    if (profiles.length === 0) {
      return summary;
    }

    const studyByUserId = await this.loadStudySettings(
      profiles.map((profile) => profile.userId),
    );

    const appUrl = this.resolveAppUrl();
    const decisions: ReminderDecision[] = [];

    for (const profile of profiles) {
      try {
        const decision = await this.decideFor(
          profile,
          studyByUserId.get(profile.userId),
          appUrl,
        );

        if (decision) {
          decisions.push(decision);
        }
      } catch (error) {
        // ONE LEARNER'S BAD DATA MUST NOT END THE RUN. The realistic cause is
        // a `learner_profiles.timezone` `Intl` refuses (`Clock` throws
        // `RangeError` rather than quietly falling back to UTC, precisely so
        // this is visible) — a single unreachable learner, not a reason to
        // leave everybody else unreminded until the next hour.
        summary.errors += 1;
        this.logger.warn(
          {
            userId: profile.userId,
            error: error instanceof Error ? error.message : error,
          },
          'Practice reminder selection failed for one learner; continuing the run',
        );
      }
    }

    // ---------------------------------------------------------------------
    // The send pass. Every read above has completed.
    // ---------------------------------------------------------------------
    for (const decision of decisions) {
      try {
        await this.notifications.notify(
          decision.eventKey,
          decision.userId,
          decision.data,
        );
        summary.reminded += 1;
        summary.byEvent[decision.eventKey] += 1;
      } catch (error) {
        // `notify` is documented never to reject — it schedules and returns —
        // so this branch should be unreachable. It exists anyway because the
        // cost of being wrong about that is every learner after this one going
        // unreminded, and a cron that stops halfway through leaves no trace of
        // the learners it never reached.
        summary.errors += 1;
        this.logger.warn(
          {
            userId: decision.userId,
            eventKey: decision.eventKey,
            error: error instanceof Error ? error.message : error,
          },
          'Raising a practice reminder failed for one learner; continuing the run',
        );
      }
    }

    return summary;
  }

  // ---------------------------------------------------------------------------
  // Selection (§6.1) and the ladder (§6.2)
  // ---------------------------------------------------------------------------

  /**
   * §6.1's four filters and §6.2's ladder, for one learner.
   *
   * Returns `null` the moment any filter excludes them — the filters are in
   * the spec's own order, cheapest first, so a learner who is not in this
   * hour's cohort costs two map lookups and no query at all.
   */
  private async decideFor(
    profile: ReminderProfile,
    study: StudyValue | undefined,
    appUrl: string | undefined,
  ): Promise<ReminderDecision | null> {
    // FILTER 1 — reminders switched off entirely. Absent means enabled (§7):
    // only an explicit `false` excludes, so an account that has never touched
    // the namespace is a candidate.
    if ((study?.reminderEnabled ?? DEFAULT_STUDY_REMINDER_ENABLED) === false) {
      return null;
    }

    // FILTER 2 — is it their hour, on their own clock? This is the one filter
    // that makes an hourly cron necessary; see the header.
    const reminderHour = study?.reminderHour ?? DEFAULT_STUDY_REMINDER_HOUR;
    if (this.clock.localHourIn(profile.timezone) !== reminderHour) {
      return null;
    }

    // FILTER 3 — today's goal already met. A learner who has practised is not
    // reminded to practise; the celebration surface is a different message on
    // a different trigger.
    const today = this.clock.calendarDateIn(profile.timezone);
    const days = await this.loadDays(profile.userId);
    const todayRow = days.find((day) => day.date === today);

    if (todayRow?.goalMet === true) {
      return null;
    }

    // FILTER 4 — already reminded today (§6.3).
    if (await this.alreadyRemindedToday(profile.userId, profile.timezone)) {
      return null;
    }

    // ---------------------------------------------------------------------
    // THE LADDER (§6.2), evaluated top to bottom. Exactly one event.
    // ---------------------------------------------------------------------

    // RUNG 1 — a real streak with nothing left to protect it.
    //
    // `streakFreezes === 0` is the whole of "no freeze available to cover
    // today": a learner still holding one is already protected against today
    // lapsing their streak even if they never open the app, so naming the risk
    // to them would be inaccurate as well as unnecessary pressure.
    //
    // The streak comes from `computeStreak` — the same pure engine the summary
    // endpoint uses — over the rows just read. Never a second derivation.
    const streak = computeStreak({ today, days });

    if (streak.current >= 2 && profile.streakFreezes === 0) {
      const data: StreakAtRiskEmailData = {
        streakDays: streak.current,
        ...(appUrl ? { appUrl } : {}),
      };
      return { userId: profile.userId, eventKey: 'streak.at_risk', data };
    }

    // RUNG 2 — questions actually waiting. The count is `due + weak`, the same
    // sum `GET /api/practice/queue` reports and `study-coach.ts` calls
    // `reviewCount`, so the number in the message is always the number that
    // made the message appear.
    const reviewCount = await this.reviewCountFor(profile.userId);

    if (reviewCount > 0) {
      const data: PracticeReviewDueEmailData = {
        reviewCount,
        ...(appUrl ? { appUrl } : {}),
      };
      return { userId: profile.userId, eventKey: 'practice.review_due', data };
    }

    // RUNG 3 — nothing specific to name, so the generic five-minutes nudge.
    const data: PracticeDailyReminderEmailData = {
      dailyGoalMinutes: profile.dailyGoalMinutes,
      ...(appUrl ? { appUrl } : {}),
    };
    return { userId: profile.userId, eventKey: 'practice.daily_reminder', data };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Every candidate's `study` namespace, in ONE query.
   *
   * A learner with no `user_settings` row, or a row with no `study` key, is
   * simply absent from the map — which the callers above read as "use the
   * built-in defaults", exactly as the sparse contract requires. Nothing here
   * writes a row to make the absence explicit.
   *
   * The stored blob is read defensively rather than parsed: `user_settings
   * .value` is user-written JSON, and a hand-crafted PATCH cannot get past
   * `studySchema` today, but a row written by an older or newer build might
   * still hold a shape this code does not expect. A malformed value falls back
   * to the defaults instead of throwing the whole hourly run.
   */
  private async loadStudySettings(
    userIds: string[],
  ): Promise<Map<string, StudyValue>> {
    const rows = (await this.prisma.userSettings.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, value: true },
    })) as { userId: string; value: unknown }[];

    const byUserId = new Map<string, StudyValue>();

    for (const row of rows) {
      const study = (row.value as UserSettingsValue | null)?.study;

      if (study && typeof study === 'object') {
        byUserId.set(row.userId, {
          ...(typeof study.reminderHour === 'number'
            ? { reminderHour: study.reminderHour }
            : {}),
          ...(typeof study.reminderEnabled === 'boolean'
            ? { reminderEnabled: study.reminderEnabled }
            : {}),
        });
      }
    }

    return byUserId;
  }

  /**
   * One learner's whole `daily_activity` history, as the streak engine's own
   * reduced shape.
   *
   * The WHOLE history for the reason `EngagementService.loadDays` gives:
   * `computeStreak` defines `longest` over all of it, and this task hands the
   * engine the same evidence the summary endpoint does so the two can never
   * disagree about a learner's current streak. `goalMet` for today comes out
   * of the same rows, so filter 3 costs no extra query.
   */
  private async loadDays(userId: string): Promise<StreakDay[]> {
    const rows = (await this.prisma.dailyActivity.findMany({
      where: { userId },
      orderBy: { activityDate: 'asc' },
      select: { activityDate: true, goalMet: true, freezeUsed: true },
    })) as { activityDate: Date; goalMet: boolean; freezeUsed: boolean }[];

    return rows.map((row) => ({
      // Prisma hands a `@db.Date` back as the midnight-UTC instant it stores,
      // so the local calendar day is the leading 10 characters of its ISO
      // form — the same conversion `EngagementService.fromDateColumn` makes.
      date: row.activityDate.toISOString().slice(0, 10),
      goalMet: row.goalMet,
      freezeUsed: row.freezeUsed,
    }));
  }

  /**
   * §6.3, verbatim: has any of the three reminder events already been raised
   * for this learner inside their CURRENT local calendar day?
   *
   * `notification_deliveries` answers it — the framework's own table, already
   * indexed `[userId, eventKey]` — rather than a duplicate "last reminded"
   * column this epic would then have to keep in sync with it.
   *
   * `createdAt` SPECIFICALLY, and not a completion timestamp: `notify` writes
   * the delivery row when the send is SCHEDULED, so this reflects "was an
   * attempt already made today" — the correct question — regardless of whether
   * that attempt's eventual status was `sent` or `failed`. A learner whose
   * 9am email bounced is not re-reminded at 10am to make up for it.
   *
   * The bounds are the learner's own local day, so two learners in different
   * zones are asking about two different windows of UTC time.
   */
  private async alreadyRemindedToday(
    userId: string,
    timezone: string,
  ): Promise<boolean> {
    const { start, end } = this.clock.localDayRangeIn(timezone);

    const existing = await this.prisma.notificationDelivery.findFirst({
      where: {
        userId,
        eventKey: { in: [...PRACTICE_REMINDER_EVENT_KEYS] },
        createdAt: { gte: start, lt: end },
      },
      select: { id: true },
    });

    return existing !== null;
  }

  /**
   * `due + weak` for one learner, classified by the selector's own rule.
   *
   * READS `question_mastery` DIRECTLY rather than calling
   * `PracticeService.getQueue`, and the reason is structural rather than
   * stylistic: `PracticeModule` imports `EngagementModule` (so practice can
   * accrue after its own writes commit), so importing practice back from here
   * would be a module cycle. `EngagementService` already reads
   * `practice_sessions` and `practice_attempts` directly for the same reason.
   *
   * What is NOT re-derived is the DECISION: `classifyMasteryBucket` is the one
   * shared rule `getQueue` and the session selector both use, so this count
   * cannot drift from what starting a session right now would select.
   *
   * A question with no `question_mastery` row classifies as `new`, never as
   * due or weak — which is why only existing rows need to be read here, and
   * why a learner who has never practised produces `0` without touching the
   * question bank at all.
   */
  private async reviewCountFor(userId: string): Promise<number> {
    const rows = (await this.prisma.questionMastery.findMany({
      where: { userId },
      select: {
        state: true,
        dueAt: true,
        lapses: true,
        correctStreak: true,
        lastAttemptAt: true,
      },
    })) as QuestionMasterySnapshot[];

    const now = this.clock.now();

    return rows.filter((row) => {
      const bucket = classifyMasteryBucket(row, now);
      return bucket === 'due' || bucket === 'weak';
    }).length;
  }

  /**
   * The application's absolute base URL, or `undefined` when none is
   * configured.
   *
   * Trailing slashes are stripped here rather than in each template, matching
   * `AuthService.handleGoogleLogin`'s own handling of the same value. With no
   * `APP_URL` the templates omit their button rather than rendering one that
   * goes nowhere — the browser channel's links are root-relative and are
   * unaffected either way.
   */
  private resolveAppUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }
}
