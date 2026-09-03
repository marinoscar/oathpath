import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';

/**
 * The Progress page's read API (issue #86, epic #54 / E5 "Memory").
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * would inject without an import line here — the same reason `CivicsModule`,
 * `PracticeModule` and `JourneyModule` all omit it. Moot for this module
 * specifically, since `ProgressService` reads no clock at all: it aggregates
 * already-persisted `question_mastery` rows and computes nothing time-based
 * itself.
 *
 * `CivicsModule` is not imported, matching `PracticeModule`'s own reasoning:
 * this module reads `civics_categories`/`civics_questions` directly through
 * Prisma, not through `CivicsService`, whose methods resolve and return
 * answers this endpoint has no use for.
 *
 * `PracticeModule` is not imported either — `ProgressService` does not call
 * `PracticeService`. It reads `question_mastery` directly, the same table
 * `PracticeService.scheduleMastery` writes, because the two need different
 * shapes of the same rows (this file's own header on `ProgressService`) and
 * `PracticeService` exposes no method that already returns this one.
 *
 * One controller, one route, no admin surface: nobody reads another
 * learner's progress through this module, so there is no second controller
 * with a different gate.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ProgressController],
  providers: [ProgressService],
})
export class ProgressModule {}
