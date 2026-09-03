import { Module } from '@nestjs/common';

import { PracticeModule } from '../practice/practice.module';
import { PrismaModule } from '../prisma/prisma.module';
import { JourneyController } from './journey.controller';
import { JourneyService } from './journey.service';

/**
 * The journey shell's API surface (issue #65, epic #50).
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * injects into `JourneyService` without an import line here. That is the
 * pattern `ClockModule`'s own header describes — the clock is infrastructure,
 * not a feature dependency, and a per-module import would add a line that
 * tells a reader nothing the constructor does not already say.
 *
 * `PracticeModule` IS imported (issue #82, epic #54 / E5), for
 * `PracticeService.getQueue` — the Study Coach's own header
 * (`study-coach.ts`) is explicit that `dueCount`/`lapsedCount` must come from
 * that ONE shared query, never a second aggregation over `question_mastery`
 * kept in sync by convention. `PracticeModule`'s own header already names this
 * exact use: "`PracticeService` is exported because E4 (#53) extends the
 * grading path and E5 reads this module's evidence — both of which are a
 * service injection, not a new copy of the loop."
 */
@Module({
  imports: [PrismaModule, PracticeModule],
  controllers: [JourneyController],
  providers: [JourneyService],
  exports: [JourneyService],
})
export class JourneyModule {}
