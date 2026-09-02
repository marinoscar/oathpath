import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { AiSettingsService } from './ai-settings.service';
import { AI_SETTINGS_KEY } from './ai-settings.schema';
import type { AiProviderKind, AiSettings } from './ai-settings.schema';
import {
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
} from './ai-credential.constants';
import { wiredModelRoles } from './ai-model-roles';
import { OpenAiProvider } from './providers/openai.provider';
import type { AiProvider } from './providers/ai-provider.interface';
import type { AiReachabilityRequest } from './ai.types';
import type { AiTestResult } from './dto/ai-test-result.dto';

// =============================================================================
// AiConnectionTestService — the "Test connection" button (issue #32, epic #25)
// =============================================================================
//
// THIS IS A DIAGNOSTIC, AND EVERY DECISION BELOW FOLLOWS FROM THAT. It follows
// `email/email-test-send.service.ts` in every respect that carries over; that
// file's five design rules are the specification here.
//
// -----------------------------------------------------------------------------
// THERE IS NO TARGET PARAMETER
// -----------------------------------------------------------------------------
//
// It tests the SAVED configuration: the stored server key, the selected
// provider, the bound models. A free-text model id or base URL is tempting —
// "let me try one before I save it" is a real thing an admin wants — and it
// would turn an admin form into a call-arbitrary-endpoint primitive, issuing
// outbound requests of the caller's choosing on the organisation's credential.
//
// Note the shape that keeps this honest: `runTest` takes an actor, not a
// target. There is no parameter for a caller to fill from a request body, so
// "just let them pass a model" is a signature change and a visible diff.
//
// -----------------------------------------------------------------------------
// IT RETURNS A RESULT; IT DOES NOT THROW FOR A FAILED TEST
// -----------------------------------------------------------------------------
//
// See the long note in ./dto/ai-test-result.dto.ts. In short: the error
// envelope suppresses detail in production and the client funnels a non-2xx
// into generic failure handling, so the one fact worth having would be the one
// fact lost.
//
// -----------------------------------------------------------------------------
// EVERY ATTEMPT IS AUDITED, THROUGH ONE FUNNEL
// -----------------------------------------------------------------------------
//
// Success, provider refusal, and pre-flight refusal alike. "Did anyone test
// this, and what did it say?" is the first question asked when an admin
// reports that AI stopped working, and an audit trail that only records
// successes cannot answer it. One `finish` method builds every result, so a
// second hand-rolled failure literal cannot end up without an audit row.
//
// NOT EXPORTED FROM `AiModule`. Reachable only through
// `AiSettingsController`, as `EmailTestSendService` is: running an outbound
// call on the organisation's key is an admin action, not a capability other
// features should be able to invoke.
// =============================================================================

@Injectable()
export class AiConnectionTestService {
  private readonly logger = new Logger(AiConnectionTestService.name);

  /**
   * Provider kind -> provider.
   *
   * A `Record<AiProviderKind, AiProvider>` rather than a `switch`: adding a
   * kind to `AI_PROVIDER_KINDS` makes this object fail to compile until the
   * new provider is wired, where a `switch` would fall through and report
   * "nothing happened" with no error to explain it. Same shape
   * `EmailTestSendService` uses.
   */
  private readonly providers: Record<AiProviderKind, AiProvider>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiSettings: AiSettingsService,
    private readonly credentials: CredentialsService,
    openai: OpenAiProvider,
  ) {
    this.providers = { openai };
  }

  /**
   * Test the saved server configuration.
   *
   * NEVER THROWS for a configuration or provider problem — every such outcome
   * is a `{ success: false, error }` result. It can still reject for a genuine
   * fault (the database being down while writing the audit row), which is a
   * 500 and correctly so.
   *
   * @param actorId the authenticated admin. The audit subject, and the only
   *        thing this method takes — see the header on target parameters.
   */
  async runTest(actorId: string): Promise<AiTestResult> {
    const attemptedAt = new Date();

    // Read through the settings service's CONSUMPTION path (`get`), not the
    // admin view: this must fail the same way a real catalog fetch would. A
    // stored row that will not parse throws there, and the catch below turns
    // it into the admin-facing error — which is precisely the diagnosis
    // wanted, and the message carries field paths only.
    let settings: AiSettings;
    try {
      settings = await this.aiSettings.get();
    } catch (err) {
      return this.finish(actorId, null, attemptedAt, {
        success: false,
        authenticated: false,
        roles: [],
        error:
          err instanceof Error ? err.message : 'AI settings could not be read.',
      });
    }

    if (!settings.provider) {
      return this.finish(actorId, null, attemptedAt, {
        success: false,
        authenticated: false,
        roles: [],
        error:
          'No AI provider is selected. Choose a provider, save, then test again.',
      });
    }

    const providerKind = settings.provider;

    // THE MASTER SWITCH IS HONOURED. `enabled: false` means "nothing is
    // dispatched", and a test button that calls out anyway would make the
    // switch a lie in the one place an admin is looking at it. The error says
    // which control to flip, so this costs an admin one extra save and no
    // confusion.
    if (!settings.enabled) {
      return this.finish(actorId, providerKind, attemptedAt, {
        success: false,
        authenticated: false,
        roles: [],
        error: 'AI is turned off. Turn AI on, save, then test again.',
      });
    }

    // The key is read here, and it is the ONLY `getSecret` call on any settings
    // path in this module. It goes straight into `testConnection` and is never
    // held, logged, returned or stored.
    const apiKey = await this.credentials.getSecret(
      AI_SYSTEM_CREDENTIAL_PURPOSE,
      AI_SYSTEM_CREDENTIAL_NAME,
    );

    if (apiKey === null) {
      return this.finish(actorId, providerKind, attemptedAt, {
        success: false,
        authenticated: false,
        roles: [],
        error:
          'No API key is stored. Enter a key, save, then test again. (A blank key field preserves an existing key rather than creating one.)',
      });
    }

    const provider = this.providers[providerKind];

    // Probe every WIRED role that has a binding. An unbound wired role is not
    // probed and not reported as a failure here: that is `systemReady`'s
    // business (#36), and conflating "you have not finished configuring" with
    // "your key does not work" is the same mistake merging the two status
    // flags would be.
    const probes: AiReachabilityRequest[] = wiredModelRoles()
      .map((role) => ({ role, modelId: settings.models[role.key] }))
      .filter(
        (entry): entry is { role: (typeof entry)['role']; modelId: string } =>
          typeof entry.modelId === 'string' && entry.modelId.length > 0,
      )
      .map(({ role, modelId }) => ({
        roleKey: role.key,
        modelId,
        family: role.capability,
      }));

    // `testConnection` NEVER throws — that contract is implemented once, in
    // `BaseAiProvider`, so there is deliberately no try/catch here. Adding one
    // would suggest the guarantee is in doubt and would produce a worse error
    // message than the base class already builds.
    const result = await provider.testConnection(apiKey, probes);

    return this.finish(actorId, providerKind, attemptedAt, result);
  }

  /**
   * Build, log and audit one outcome.
   *
   * ONE PLACE, so every outcome — configuration refusal, provider rejection,
   * success — reaches the admin in the same shape and reaches the audit trail
   * with the same fields. A second, hand-rolled result literal is how one of
   * them ends up without an audit row.
   */
  private async finish(
    actorId: string,
    providerKind: AiProviderKind | null,
    attemptedAt: Date,
    outcome: {
      success: boolean;
      authenticated: boolean;
      roles: AiTestResult['roles'];
      error: string | null;
    },
  ): Promise<AiTestResult> {
    if (outcome.success) {
      this.logger.log(
        `AI connection test succeeded via ${providerKind} at the request of user ${actorId}`,
      );
    } else {
      // `warn`, not `error`: a misconfigured provider is an operator problem
      // the operator is actively looking at, not a fault of this service. The
      // text is already redacted (provider failures) or authored here
      // (configuration failures, which quote no stored value).
      this.logger.warn(
        `AI connection test failed for user ${actorId} via ${providerKind ?? 'no provider'}: ${outcome.error}`,
      );
    }

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: actorId,
        action: 'ai_settings:test',
        targetType: 'system_settings',
        // No settings row is guaranteed to exist (a test on a fresh install
        // fails before one is written), and `targetId` is non-nullable, so the
        // stable settings key names the target instead of a row id.
        targetId: AI_SETTINGS_KEY,
        meta: {
          provider: providerKind,
          success: outcome.success,
          authenticated: outcome.authenticated,
          // The error text only. It is already redacted, and it is the whole
          // content of the answer. THE KEY AND ITS HINT ARE NOT RECORDED — an
          // audit row is queried and exported far more casually than a
          // credential is.
          error: outcome.error,
          // Which roles failed, without their messages: enough to answer "was
          // it the grader binding again?" from a query.
          unreachableRoles: outcome.roles
            .filter((role) => !role.reachable)
            .map((role) => role.roleKey),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      success: outcome.success,
      authenticated: outcome.authenticated,
      roles: outcome.roles,
      providerKind,
      error: outcome.error,
      attemptedAt: attemptedAt.toISOString(),
    };
  }
}
