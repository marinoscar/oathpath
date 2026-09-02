import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { CivicsAdminController } from './civics-admin.controller';
import { CivicsAdminService } from './civics-admin.service';
import { CivicsController } from './civics.controller';
import { CivicsService } from './civics.service';

/**
 * The civics question bank: the learner-facing read API (issue #111) and the
 * admin dynamic-answer surface (issue #117), epic #51.
 *
 * `ClockModule` is deliberately NOT imported: it is `@Global()`, so `Clock`
 * injects into both services without an import line here — the same reason
 * `JourneyModule` omits it. The clock is infrastructure, not a feature
 * dependency, and a per-module import would add a line that tells a reader
 * nothing the constructor does not already say.
 *
 * Two controllers, because they take OPPOSITE permission postures: the read
 * routes are `@Auth()` with no permission (civics content is what every
 * learner studies), while the dynamic-answer routes are gated on
 * `system_settings:read`/`:write`. See `civics-admin.controller.ts`.
 *
 * `CivicsAdminService` is not exported. Nothing outside this module has a
 * reason to write `civics_answers`, and the content loader (#101) is a
 * standalone `ts-node` process that does not go through Nest's DI container at
 * all — so an export would only widen the reach of the one write path in this
 * epic for no caller that exists.
 *
 * No `NotificationsModule` and no `CredentialsModule`: a corrected civics
 * answer notifies nobody (a learner sees the new answer the next time they
 * read the question) and carries no secret. The audit row is written through
 * `PrismaService` inside the same transaction as the correction.
 */
@Module({
  imports: [PrismaModule],
  controllers: [CivicsController, CivicsAdminController],
  providers: [CivicsService, CivicsAdminService],
  exports: [CivicsService],
})
export class CivicsModule {}
