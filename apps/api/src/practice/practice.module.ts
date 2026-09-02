import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { PracticeController } from './practice.controller';
import { PracticeService } from './practice.service';

/**
 * The practice loop's API surface (issue #73, epic #52 / E3).
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * injects into `PracticeService` without an import line here — the same reason
 * `CivicsModule` and `JourneyModule` both omit it. The clock is infrastructure,
 * not a feature dependency, and a per-module import would add a line that tells
 * a reader nothing the constructor does not already say.
 *
 * `CivicsModule` is not imported either, and that is worth stating because this
 * module clearly depends on civics content. What it depends on is
 * `civics/answer-resolution.ts` — a pure, dependency-free module imported as a
 * FUNCTION, not as a provider — plus direct reads of `civics_questions` and
 * `civics_answers` through Prisma. Importing `CivicsModule` to reach
 * `CivicsService` would buy nothing: its `getQuestion` resolves and returns
 * ANSWERS, which is exactly the shape practice must not have in hand while it
 * is choosing a question to ask.
 *
 * One controller, because every route takes the same posture: `@Auth()` with no
 * permissions, ownership decided per row inside the service. There is no admin
 * surface here at all — nobody reads another learner's practice history through
 * this module, so there is no second controller with a different gate the way
 * `CivicsModule` needs one.
 *
 * No `NotificationsModule` and no `AuditModule`-equivalent write: answering a
 * civics question notifies nobody and is not a privileged act
 * (practice-sessions.md §10). `PracticeService` is exported because E4 (#53)
 * extends the grading path and E5 reads this module's evidence — both of which
 * are a service injection, not a new copy of the loop.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PracticeController],
  providers: [PracticeService],
  exports: [PracticeService],
})
export class PracticeModule {}
