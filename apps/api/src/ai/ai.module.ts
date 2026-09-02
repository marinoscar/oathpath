import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { AiSettingsController } from './ai-settings.controller';
import { AiSettingsService } from './ai-settings.service';
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
  controllers: [AiSettingsController],
  providers: [AiSettingsService, OpenAiProvider],
  exports: [AiSettingsService, OpenAiProvider],
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
  constructor(settings: AiSettingsService, openai: OpenAiProvider) {
    settings.onSettingsChanged(() => openai.invalidateCatalogCache());
  }
}
