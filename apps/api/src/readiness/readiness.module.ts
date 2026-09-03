import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { ReadinessController } from './readiness.controller';
import { ReadinessService } from './readiness.service';
import { ReadinessRecomputeTask } from './tasks/readiness-recompute.task';

/**
 * The readiness engine's API surface and its nightly cron (issue #122,
 * epic #55 / E6 "Readiness and Progress").
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * injects into `ReadinessService` without an import line here — the same
 * reason `ProgressModule`, `PracticeModule` and `JourneyModule` all omit it.
 *
 * `ReadinessRecomputeTask` is registered directly in this module's own
 * `providers` array — there is deliberately **no separate "tasks module"**
 * anywhere in this application (`docs/specs/readiness-model.md` §7, mirroring
 * `apps/api/src/auth/tasks/token-cleanup.task.ts`'s own placement in
 * `AuthModule`). `ScheduleModule.forRoot()` is already registered globally
 * in `AppModule`.
 *
 * This module does **not** import `PracticeModule`: the dependency runs the
 * other way — `PracticeModule` imports `ReadinessModule` so
 * `PracticeService.completeSession` can call `ReadinessService
 * .recomputeSnapshot` synchronously (§7(a)). `ReadinessService` never calls
 * back into `PracticeService`, so importing it here would be a needless
 * cycle for a dependency this module does not have.
 *
 * `ReadinessService` is exported for exactly that one consumer.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ReadinessController],
  providers: [ReadinessService, ReadinessRecomputeTask],
  exports: [ReadinessService],
})
export class ReadinessModule {}
