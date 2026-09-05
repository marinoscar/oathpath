import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { CivicsAdminController } from './civics-admin.controller';
import { CivicsAdminService } from './civics-admin.service';
import { CivicsController } from './civics.controller';
import { CivicsExplainService } from './civics-explain.service';
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
 *
 * `AiModule` IS imported (#120), and it is the one import here worth
 * justifying. `ai-evaluation.md` §3's rule is that a feature imports that
 * module and never a provider: what this module gains is `AiDispatchService`,
 * which resolves the model from the admin's settings row and spends the
 * CALLING USER's own key, and nothing else. `OpenAiProvider` is exported from
 * there too and is deliberately not injected anywhere in this module — a
 * civics service holding a provider could name its own model, which is exactly
 * the door §3 exists to be.
 *
 * That import is also why `AiModule` is not `@Global()`: the set of modules
 * that can reach a plaintext-credential path stays a list a person can read,
 * and this line is how this module appears on it.
 *
 * `SettingsModule` IS imported (issue #319, epic #305 / E14), for exactly one
 * read: `UserSettingsService.readCoachPreferences`, which tells
 * `CivicsExplainService` which voice to write an explanation in. The
 * namespace's own service rather than a second cast of `user_settings.value`
 * at the call site — the same posture `SpeechAudioModule` already takes for
 * `voice.preferredVoice`.
 *
 * NO CYCLE, and worth stating rather than assuming: `SettingsModule` imports
 * NOTHING — its `@Module` has no `imports` array at all — and
 * `UserSettingsService`'s only constructor dependency is `PrismaService`.
 * There is no path back from settings to civics or to AI, so this edge is a
 * leaf. Note also that it buys a TONE and never a fact: the grounding clause
 * in `explain-prompt.ts`'s system message is identical for all four personas,
 * and the user message — this question and these resolved answers — is
 * byte-identical across them.
 *
 * `CivicsExplainService` is NOT exported. Nothing outside this module should
 * be able to start a tutor stream on a learner's key without going through the
 * route that has the learner's own request in front of it — same posture as
 * `CivicsAdminService`, for a different reason: that one is about writes, this
 * one is about spend.
 */
@Module({
  imports: [PrismaModule, AiModule, SettingsModule],
  controllers: [CivicsController, CivicsAdminController],
  providers: [CivicsService, CivicsAdminService, CivicsExplainService],
  exports: [CivicsService],
})
export class CivicsModule {}
