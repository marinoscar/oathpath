import { Module } from '@nestjs/common';

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
 */
@Module({
  imports: [PrismaModule],
  controllers: [JourneyController],
  providers: [JourneyService],
  exports: [JourneyService],
})
export class JourneyModule {}
