import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { CivicsController } from './civics.controller';
import { CivicsService } from './civics.service';

/**
 * The civics question bank's read API (issue #111, epic #51).
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * injects into `CivicsService` without an import line here — the same reason
 * `JourneyModule` omits it. The clock is infrastructure, not a feature
 * dependency, and a per-module import would add a line that tells a reader
 * nothing the constructor does not already say.
 *
 * No `NotificationsModule`, no `CredentialsModule`, no audit dependency:
 * nothing in this module writes. The admin dynamic-answer surface that does
 * (civics-content.md §9) is issue #117.
 */
@Module({
  imports: [PrismaModule],
  controllers: [CivicsController],
  providers: [CivicsService],
  exports: [CivicsService],
})
export class CivicsModule {}
