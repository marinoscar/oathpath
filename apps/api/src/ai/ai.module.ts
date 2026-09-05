import { Inject, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { CredentialsService } from '../credentials/credentials.service';
import { AiSettingsController } from './ai-settings.controller';
import { AiSpeechService } from './ai-speech.service';
import { AiSettingsService } from './ai-settings.service';
import { AiConnectionTestService } from './ai-connection-test.service';
import { AiDispatchService } from './ai-dispatch.service';
import { AiUserKeyController } from './ai-user-key.controller';
import { CoachController } from './coach/coach.controller';
import { AiUserKeyService } from './ai-user-key.service';
import { AiStatusService } from './ai-status.service';
import { AiUsageController } from './ai-usage.controller';
import { AiUsageService } from './ai-usage.service';
import { AiUserCredentialCleanupTask } from './tasks/ai-credential-cleanup.task';
import type { AiProvider } from './providers/ai-provider.interface';
import { FakeAiProvider } from './providers/fake-ai.provider';
import { OpenAiProvider } from './providers/openai.provider';

// =============================================================================
// AiModule (issue #30, epic #25)
// =============================================================================
//
// AI configuration: the settings row, the server credential, the provider, and
// the admin surface over them.
//
// #27 and #28 shipped declarations and the provider abstraction with NO module
// at all, on the grounds that adding an HTTP surface before there is something
// to expose puts a route to review in infrastructure. #30 is the diff that has
// something to expose, and it is reviewed here.
//
// THIS CONTROLLER RETURNS NO SECRET. The server key reaches this module only
// as a write — request body -> `AiSettingsService.update` ->
// `CredentialsService.setSecret` — and the read side uses `describe`, whose
// return type carries a compile-time proof that it has no field able to hold
// secret material. `CredentialsService.getSecret`, the plaintext one, is
// called from exactly one place in this module: `OpenAiProvider`, at the
// moment it builds a client.
//
// THE PROVIDER IS REGISTERED UNCONDITIONALLY, not chosen here from the
// configured `provider` setting. Provider selection is a runtime decision: the
// setting lives in the database and an admin can change it without a restart,
// so a module-construction-time choice would be stale the moment they did.
//
// NOT @Global(). OpenAiProvider depends transitively on
// `CredentialsService.getSecret`, which returns plaintext; the set of modules
// that can reach it should stay a list a person can read, which means every
// consumer writes `imports: [AiModule]` and shows up in a diff.
//
// THE PROVIDER TOKEN IS SUBSTITUTABLE (#105, epic #53). `OpenAiProvider` is
// registered through a factory that returns a `FakeAiProvider` instead on a
// non-production deployment that sets `AI_PROVIDER_FAKE=true`. See
// {@link resolveAiProvider} — that function is the ONLY place in the
// application that knows a fake exists.
// =============================================================================

/**
 * The environment variable that asks for the fake provider.
 *
 * READ THROUGH `ConfigService`, NEVER `process.env` DIRECTLY, matching
 * `TestEnvironmentGuard`: a test can then stand this module up with a config
 * stub instead of mutating global process state, which is the mutation that
 * leaks between test files and makes one suite's behaviour depend on another's
 * ordering.
 */
const FAKE_PROVIDER_FLAG = 'AI_PROVIDER_FAKE';

/**
 * The provider an `AiProvider` consumer gets, plus the catalog-cache hook this
 * module's constructor wires.
 *
 * A STRUCTURAL TYPE RATHER THAN `OpenAiProvider`. Under the fake the token
 * does not resolve to an `OpenAiProvider` at all, so declaring that class as
 * the type would be a claim the compiler cannot check and, on those
 * deployments, a false one.
 */
type RegisteredAiProvider = AiProvider & { invalidateCatalogCache(): void };

/**
 * Choose the provider instance registered under the `OpenAiProvider` token.
 *
 * -----------------------------------------------------------------------------
 * TWO CONDITIONS, AND `NODE_ENV=production` IS THE ONE THAT CANNOT BE WAIVED
 * -----------------------------------------------------------------------------
 *
 * `AI_PROVIDER_FAKE=true` alone is not enough. A production deployment that
 * inherited the variable — a copied `.env`, a templated compose file, a
 * container image built from a developer's shell — would run every learner's
 * grading against a lookup table while reporting itself perfectly healthy:
 * `systemReady` true, connection tests green, `ai_usage_events` rows being
 * written, and every verdict wrong in a way no error surfaces. The environment
 * check is what makes that failure impossible rather than unlikely.
 *
 * -----------------------------------------------------------------------------
 * WHY THE CHOICE IS MADE HERE AND NOWHERE ELSE
 * -----------------------------------------------------------------------------
 *
 * `ai-evaluation.md` §10's rule is that nothing downstream may learn which
 * provider it got — not `AiDispatchService`, not the settings row (which still
 * stores the real, valid `provider: 'openai'`), not the admin page, not the
 * seed. One factory, at registration, is what keeps that true: every consumer
 * injects the same token, holds the same `AiProvider` interface, and has no
 * branch to get wrong. A flag read at a call site would be a second place the
 * answer is decided, and the two places would eventually disagree.
 *
 * Exported so `ai.module.spec.ts` can assert the production rule directly. The
 * test calls THIS function — the one the registration below uses — rather than
 * a copy of its logic.
 */
export function resolveAiProvider(
  config: ConfigService,
  credentials: CredentialsService,
  usage: AiUsageService,
): RegisteredAiProvider {
  const nodeEnv = config.get<string>('nodeEnv');
  const wantsFake = config.get<string>(FAKE_PROVIDER_FLAG) === 'true';

  if (nodeEnv !== 'production' && wantsFake) {
    return new FakeAiProvider(usage);
  }

  return new OpenAiProvider(credentials, usage);
}

@Module({
  imports: [
    // AiSettingsService reads the `ai` row of `system_settings`.
    PrismaModule,
    // The server key. Imported explicitly (CredentialsModule is deliberately
    // not global) so this module's access to a plaintext-returning service is
    // visible right here.
    CredentialsModule,
    // `resolveAiProvider` reads `nodeEnv` and `AI_PROVIDER_FAKE` through
    // ConfigService. Imported explicitly even though the root ConfigModule is
    // global, matching TestAuthModule: a module that reads configuration says
    // so in its own imports rather than relying on a global registered
    // somewhere else.
    ConfigModule,
  ],
  controllers: [
    AiSettingsController,
    // The per-user surface (#35). A SEPARATE CONTROLLER from the admin one,
    // and not merely for tidiness: these routes are `@Auth()` with no
    // permissions while every route on the other is gated on
    // `system_settings:*`. Two controllers means the gate is visible per file
    // rather than per decorator, and a route added to the wrong one is a
    // visibly wrong file rather than a missing decorator.
    AiUserKeyController,
    // Read-only, and separate from the key controller even though both live
    // under /api/ai. A controller that both holds credentials and reports
    // history is a controller where a future "usage for user X" route looks
    // like it belongs.
    AiUsageController,
    // The coach persona registry's read surface (#320, epic #305 / E14).
    //
    // Registered here, with the other two `@Auth()`-no-permissions controllers
    // under `/api/ai`, and separate from both for the reason the note above
    // gives: one file, one gate, so a route added to the wrong one is a
    // visibly wrong file. This one is the narrowest in the module — it injects
    // NOTHING and returns a projection of `coach/personas.ts`, a constant.
    //
    // It needs no provider registered below because there is no service: the
    // registry is pure data by design (`personas.ts`'s own header: "This file
    // is intentionally NOT a Nest provider"), and standing up DI for a
    // constant is what that header declines to do.
    CoachController,
    // `AiSpeechController` USED TO BE REGISTERED HERE (#95, epic #58) and now
    // is not — it moved to `SpeechAudioModule` in #284, and only its
    // REGISTRATION moved; the file is still `ai/ai-speech.controller.ts` and
    // still resolves `AiSpeechService` out of this module.
    //
    // The reason is a module cycle, not a change of ownership. Its newest
    // route resolves civics text through `CivicsService`, and `CivicsModule`
    // already imports this module for `AiDispatchService`. Declaring the
    // controller here would make the two import each other, which Nest
    // survives only with `forwardRef` on both sides — and with
    // `emitDecoratorMetadata`, a cycle got wrong leaves `design:paramtypes`
    // holding `undefined` and Nest failing to resolve a dependency at boot,
    // the same hazard this module's own constructor comment names below. See
    // `speech-audio.module.ts`.
  ],
  providers: [
    AiSettingsService,
    // The test path (#32). Registered here rather than in a module of its own
    // because it is one method over the provider and settings this module
    // already owns.
    AiConnectionTestService,
    AiUserKeyService,
    AiStatusService,
    AiUsageService,
    // The orphaned-key sweep (#38). `Credential` has no FK to `User`, so a
    // deleted user's key is invisible to the database and to every query — a
    // scheduled sweep is the only thing that will ever find one.
    AiUserCredentialCleanupTask,
    // The one door a feature calls to run inference (#100). Registered
    // alongside the provider rather than in a module of its own for the same
    // reason AiConnectionTestService is: it is resolution over the settings,
    // credentials and provider this module already owns.
    AiDispatchService,
    // The speech endpoints' logic (#95): the upload caps, the accepted content
    // types, and the mapping from a dispatch result to a wire shape. Registered
    // here rather than in a module of its own because it is resolution over
    // the dispatcher this module already owns — the same reason
    // AiConnectionTestService lives here.
    AiSpeechService,
    // THE SUBSTITUTABLE PROVIDER TOKEN (#105). Still addressed everywhere as
    // `OpenAiProvider` — the class is the injection token, not necessarily the
    // instance — so no consumer changes and no consumer can tell. See
    // {@link resolveAiProvider}.
    {
      provide: OpenAiProvider,
      inject: [ConfigService, CredentialsService, AiUsageService],
      useFactory: resolveAiProvider,
    },
  ],
  // AiConnectionTestService is deliberately NOT exported: running an outbound
  // call on the organisation's key is an admin action reached through this
  // module's controller, not a service other features should be able to
  // invoke. Same posture as EmailTestSendService.
  //
  // AiDispatchService IS EXPORTED, and the difference is not inconsistency.
  // The connection test spends the ORGANISATION's key on demand, which is an
  // admin action with a route of its own; the dispatcher spends the CALLING
  // USER's key, refuses outright when they have none (`no_user_key`), and
  // resolves the model from the admin's settings row rather than from
  // anything a caller passes. Exporting it is what lets the grading ladder and
  // the tutor exist at all — `ai-evaluation.md` §3's rule is that a feature
  // imports THIS and never a provider — and it hands a consumer no capability
  // it could not already exercise with its own caller's key.
  exports: [
    AiSettingsService,
    AiStatusService,
    AiUsageService,
    AiDispatchService,
    OpenAiProvider,
    // Exported for `SpeechAudioModule` (#284), which declares
    // `AiSpeechController` — see the note in `controllers` above. This adds no
    // capability: the service resolves nothing a caller passes it and spends
    // only the calling learner's own key, exactly as `AiDispatchService`
    // (already exported, for the same reasoning) does.
    AiSpeechService,
    // Exported for `AccountModule` (#270): `AccountResetService`'s
    // `data_and_key` scope calls `purgeForDeletedUser` directly, on the SAME
    // service every route in this module already resolves credentials
    // through — not a copy of its logic and not a second way to reach
    // `CredentialsService.deleteSecret` for this address. Every method on
    // this class still enforces its own "no route/caller passes a user id it
    // did not already hold" discipline (see this class's own header); adding
    // an exporter does not relax that, it only adds one more reviewed
    // in-process caller.
    AiUserKeyService,
  ],
})
export class AiModule {
  /**
   * Wire the settings service's change notification to the provider's catalog
   * cache.
   *
   * DONE HERE RATHER THAN BY INJECTING THE PROVIDER INTO THE SERVICE: the
   * provider already depends on the credential store, and #36 will add a
   * second listener from a module that depends on the settings service. A
   * direct injection in either direction makes the two modules import each
   * other, and with `emitDecoratorMetadata` a cycle leaves `design:paramtypes`
   * holding `undefined` and Nest failing to resolve a dependency at boot —
   * the same hazard `ai-credential.constants.ts` exists to avoid.
   *
   * The module is the one place that already knows about both.
   */
  constructor(
    settings: AiSettingsService,
    // ADDRESSED BY THE TOKEN, TYPED BY WHAT IS ACTUALLY USED. Under
    // `AI_PROVIDER_FAKE` this is a `FakeAiProvider`, which is not an
    // `OpenAiProvider`, so the declared type is the structural one and the
    // explicit `@Inject` supplies the token `emitDecoratorMetadata` can no
    // longer infer.
    @Inject(OpenAiProvider) provider: RegisteredAiProvider,
    status: AiStatusService,
  ) {
    settings.onSettingsChanged(() => provider.invalidateCatalogCache());
    // The gate's system half. An admin who has just bound the last model
    // expects the app to become usable immediately, not after a TTL.
    settings.onSettingsChanged(() => status.invalidate());
  }
}
