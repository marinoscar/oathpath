import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EngagementController } from './engagement.controller';
import { EngagementService } from './engagement.service';
import { PracticeReminderTask } from './tasks/practice-reminder.task';

/**
 * Daily activity, streaks and the engagement summary (issue #119, epic #56 /
 * E7 "Habit").
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * injects into `EngagementService` without an import line here — the same
 * reason `ReadinessModule`, `ProgressModule`, `PracticeModule` and
 * `JourneyModule` all omit it. It matters more here than in most: every local
 * day this module writes is `clock.calendarDateIn(timezone)`, so an
 * `X-Test-Clock` header pins the day a test's accrual lands on.
 *
 * This module does **not** import `PracticeModule`, and must not: the
 * dependency runs one way only — `PracticeModule` imports THIS module so
 * `PracticeService.recordAttempt` and `.completeSession` can accrue after
 * their own writes commit (`docs/specs/habit-streaks.md` §2.1), exactly as it
 * already imports `ReadinessModule` for the same shape of call. Engagement
 * reads `practice_sessions` and `practice_attempts` directly through Prisma
 * for its one derived value (§2.3's time slice) rather than through
 * `PracticeService`, the same way `ProgressService` reads `question_mastery`
 * directly: importing back would be a cycle for a dependency this module does
 * not have.
 *
 * `ReadinessModule` is not imported either, and that absence is the point
 * (§1): a streak is structurally incapable of moving a readiness score if
 * there is no wire between them. `PRD.md` requires the separation, and it is
 * kept by the missing import, not by a filter at read time.
 *
 * `NotificationsModule` IS imported, for the hourly `PracticeReminderTask`
 * (`docs/specs/habit-streaks.md` §6) — the one thing in this module that
 * reaches outside it. That import runs one way too: `NotificationsModule`
 * knows nothing about engagement, and the task raises events through
 * `notify()` like every other trigger point in this application, rather than
 * calling a channel directly.
 *
 * The task lives in THIS module's `providers` array rather than a separate
 * "tasks module", exactly as `TokenCleanupTask` lives in `AuthModule` and
 * `ReadinessRecomputeTask` in `ReadinessModule`. It is not exported: nothing
 * calls it but the scheduler (and a test, which resolves it from the module
 * it is declared in).
 *
 * `EngagementService` is exported for exactly one consumer — `PracticeModule`.
 *
 * One controller, one route, no admin surface: nobody reads another learner's
 * streak through this module, so there is no second controller with a
 * different gate.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [EngagementController],
  providers: [EngagementService, PracticeReminderTask],
  exports: [EngagementService],
})
export class EngagementModule {}
