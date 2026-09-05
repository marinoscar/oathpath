import { Module } from '@nestjs/common';

import { AiModule } from './ai.module';
import { CivicsModule } from '../civics/civics.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageProvidersModule } from '../storage/providers/storage-providers.module';
import { AiSpeechController } from './ai-speech.controller';
import { SpeechAudioService } from './speech-audio.service';

/**
 * The speech HTTP surface, and the shared civics audio cache behind its newest
 * route (issue #284, epic #280).
 *
 * -----------------------------------------------------------------------------
 * WHY `AiSpeechController` IS REGISTERED HERE AND NOT IN `AiModule`
 * -----------------------------------------------------------------------------
 *
 * `GET /api/ai/speech/audio` resolves its text through `CivicsService`, and
 * `CivicsModule` already imports `AiModule` (for `AiDispatchService`, per
 * `ai-evaluation.md` §3's "a feature imports that module, never a provider").
 * Registering the controller in `AiModule` would therefore have `AiModule`
 * import `CivicsModule` which imports `AiModule` — a cycle, which in Nest is
 * survivable only with `forwardRef` on BOTH sides and, with
 * `emitDecoratorMetadata`, leaves `design:paramtypes` holding `undefined` when
 * it is got wrong (the hazard `AiModule`'s own constructor comment already
 * names for a different pair). This repository uses `forwardRef` nowhere, and
 * introducing it for one controller's registration would be a new global
 * pattern bought for a filing decision.
 *
 * So the dependency stays a straight line — `SpeechAudioModule` imports
 * `AiModule` and `CivicsModule`, `CivicsModule` imports `AiModule`, and nothing
 * imports back. The controller's FILE has not moved; only the module that
 * declares it, which is exactly the flexible half.
 *
 * -----------------------------------------------------------------------------
 * `StorageProvidersModule`, NEVER `StorageModule`
 * -----------------------------------------------------------------------------
 *
 * The cache needs the object-storage PORT and nothing above it. `StorageModule`
 * would bring the object service, whose ownership model
 * (`storage/objects/objects.service.ts`) is right for a learner's own upload
 * and wrong for a shared civics clip — it would refuse every learner but the
 * one who happened to generate it. `CLAUDE.md` warns against widening that
 * shared ownership helper to accommodate a second rule; importing only the
 * providers module is what makes that widening unnecessary rather than merely
 * avoided. Nothing here creates, reads or references a `storage_objects` row.
 *
 * `SettingsModule` is imported for one read: the learner's own
 * `voice.preferredVoice`, through `UserSettingsService.readVoicePreferences` —
 * the namespace's own service rather than a hand-rolled read of the JSONB
 * column at a call site.
 *
 * `SpeechAudioService` is deliberately NOT exported. Nothing outside this
 * module should be able to spend a learner's key on synthesis without the
 * learner's own request in front of it — the same posture `CivicsModule` takes
 * for `CivicsExplainService`, for the same reason.
 */
@Module({
  imports: [
    PrismaModule,
    // `AiSpeechService` (the two POST routes' logic) and `AiDispatchService`
    // (the one door to inference) both come from here.
    AiModule,
    // `CivicsService.getQuestion` — the ONE implementation of answer
    // resolution in this codebase. The cache reuses it rather than deciding
    // for itself which answer is current.
    CivicsModule,
    SettingsModule,
    StorageProvidersModule,
  ],
  controllers: [AiSpeechController],
  providers: [SpeechAudioService],
})
export class SpeechAudioModule {}
