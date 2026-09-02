import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { AiSettingsController } from './ai-settings.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiConnectionTestService } from './ai-connection-test.service';
import { AiUserKeyController } from './ai-user-key.controller';
import { AiUserKeyService } from './ai-user-key.service';
import { AiStatusService } from './ai-status.service';
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
// =============================================================================

@Module({
  imports: [
    // AiSettingsService reads the `ai` row of `system_settings`.
    PrismaModule,
    // The server key. Imported explicitly (CredentialsModule is deliberately
    // not global) so this module's access to a plaintext-returning service is
    // visible right here.
    CredentialsModule,
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
  ],
  providers: [
    AiSettingsService,
    // The test path (#32). Registered here rather than in a module of its own
    // because it is one method over the provider and settings this module
    // already owns.
    AiConnectionTestService,
    AiUserKeyService,
    AiStatusService,
    OpenAiProvider,
  ],
  // AiConnectionTestService is deliberately NOT exported: running an outbound
  // call on the organisation's key is an admin action reached through this
  // module's controller, not a service other features should be able to
  // invoke. Same posture as EmailTestSendService.
  exports: [AiSettingsService, AiStatusService, OpenAiProvider],
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
    openai: OpenAiProvider,
    status: AiStatusService,
  ) {
    settings.onSettingsChanged(() => openai.invalidateCatalogCache());
    // The gate's system half. An admin who has just bound the last model
    // expects the app to become usable immediately, not after a TTL.
    settings.onSettingsChanged(() => status.invalidate());
  }
}
