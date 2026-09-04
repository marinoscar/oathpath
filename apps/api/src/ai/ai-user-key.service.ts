import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { AiSettingsService } from './ai-settings.service';
import type { AiProviderKind, AiSettings } from './ai-settings.schema';
import {
  AI_USER_CREDENTIAL_LABEL,
  AI_USER_CREDENTIAL_PURPOSE,
  aiUserCredentialName,
} from './ai-credential.constants';
import { wiredModelRoles } from './ai-model-roles';
import { OpenAiProvider } from './providers/openai.provider';
import type { AiProvider } from './providers/ai-provider.interface';
import type { AiReachabilityRequest } from './ai.types';
import type { AiTestResult } from './dto/ai-test-result.dto';
import type { AiUserKeyStatus } from './dto/ai-user-key.dto';

// =============================================================================
// AiUserKeyService — a caller's own OpenAI key (issue #35, epic #25)
// =============================================================================
//
// Every inference call in this application runs on the CALLING USER's key
// (epic #25, decision 4), so each user sees and pays for their own
// consumption. This service is where those keys are stored, replaced, removed
// and proved.
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES A USER ID FROM THE CALLER, AND THE CONTROLLER ONLY EVER
// PASSES THE AUTHENTICATED PRINCIPAL
// -----------------------------------------------------------------------------
//
// The service cannot enforce that on its own — a `userId: string` parameter is
// a `userId: string` parameter. The enforcement is that NO ROUTE ACCEPTS ONE
// (see ai-user-key.controller.ts), so widening cross-user access is a
// signature change and a visible diff rather than a query-string edit.
//
// -----------------------------------------------------------------------------
// `CredentialsService.list('ai-user')` IS NEVER CALLED FROM HERE
// -----------------------------------------------------------------------------
//
// It enumerates EVERY user's key metadata. It returns `CredentialInfo`, which
// carries a compile-time proof that it cannot hold secret material, so this is
// not a plaintext leak — but it is a cross-user metadata leak (who has a key,
// when they set it, the masked hint) waiting for a convenient admin listing,
// and it is the shape that grows a "show me everything" endpoint.
//
// An admin cannot read any user's key. That is enforced structurally, by the
// endpoints having no parameter to name another user, not by a permission
// check a later refactor could relax.
//
// `getSecret` IS called here — in exactly one method, `test`, where the key
// goes straight into `provider.testConnection` and is never held, logged,
// returned or stored.
// =============================================================================

@Injectable()
export class AiUserKeyService {
  private readonly logger = new Logger(AiUserKeyService.name);

  /**
   * Provider kind -> provider.
   *
   * A `Record` rather than a `switch`, so adding a kind to
   * `AI_PROVIDER_KINDS` fails to compile until the new provider is wired.
   */
  private readonly providers: Record<AiProviderKind, AiProvider>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly aiSettings: AiSettingsService,
    openai: OpenAiProvider,
  ) {
    this.providers = { openai };
  }

  /**
   * Is a key stored for this user, and roughly which one?
   *
   * `describe`, NOT `getSecret`: the return type has no field capable of
   * holding secret material, and its query does not select the ciphertext
   * column, so for this read the encrypted bytes never leave Postgres.
   */
  async describe(userId: string): Promise<AiUserKeyStatus> {
    const info = await this.credentials.describe(
      AI_USER_CREDENTIAL_PURPOSE,
      aiUserCredentialName(userId),
    );

    return {
      configured: info !== null,
      // The store's own mask, derived on write by code that already held the
      // plaintext. Never computed here, because computing it would mean
      // holding the plaintext to compute it from.
      hint: info?.hint ?? null,
      updatedAt: info?.updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Store or replace this user's key.
   *
   * BLANK PRESERVES, inherited from `CredentialsService` and not reimplemented
   * here — no `.trim()`, no coercion. The value arrives byte-for-byte as
   * submitted.
   *
   * A blank submission when nothing is stored is refused by the store's own
   * first-write guard (a 400 naming the address). That is the right outcome:
   * "blank preserves" is a statement about an EXISTING value, and with nothing
   * stored there is nothing to preserve.
   */
  async set(userId: string, apiKey: string | null | undefined): Promise<void> {
    await this.credentials.setSecret(
      AI_USER_CREDENTIAL_PURPOSE,
      aiUserCredentialName(userId),
      apiKey,
      {
        label: AI_USER_CREDENTIAL_LABEL,
        // The owner is the only possible writer, so this is not provenance —
        // it is the same id as the address, recorded so an orphaned row can
        // still be attributed if one ever appears.
        updatedByUserId: userId,
      },
    );

    await this.audit(userId, 'ai_key:set');
    // userId only. Never the key, never its hint.
    this.logger.log(`AI key stored for user ${userId}`);
  }

  /**
   * Remove this user's key.
   *
   * THE ONLY WAY TO ERASE, deliberately separate from {@link set} so that
   * destroying a credential is always something the user asked for by name,
   * not a consequence of clearing a field and saving.
   *
   * Idempotent: deleting when nothing is stored is a no-op, not a 404. The
   * caller's goal is "there is no key here", and that goal is already met.
   */
  async remove(userId: string): Promise<void> {
    await this.credentials.deleteSecret(
      AI_USER_CREDENTIAL_PURPOSE,
      aiUserCredentialName(userId),
    );

    await this.audit(userId, 'ai_key:delete');
    this.logger.log(`AI key removed for user ${userId}`);
  }

  /**
   * Prove this user's key works — for the models this application actually
   * uses.
   *
   * -------------------------------------------------------------------------
   * REACHABILITY, NOT VALIDITY. THIS IS THE WHOLE POINT OF THE METHOD.
   * -------------------------------------------------------------------------
   *
   * The admin binds model ids using the SERVER key. A user's personal key may
   * sit in a different organisation or tier with NO ACCESS to those models.
   * Testing only `GET /v1/models` would pass for a key that cannot run a
   * single request the app makes — and the user would finish onboarding into a
   * product that fails on their first practice answer, with a key they were
   * told was fine.
   *
   * So each wired role's bound model is probed on the user's own key, and the
   * results are reported PER ROLE.
   *
   * Never throws for a key or provider problem — every such outcome is a
   * `{ success: false }` result, so a refusal reaches the user as a diagnosis
   * rather than as "Request failed".
   */
  async test(userId: string): Promise<AiTestResult> {
    const attemptedAt = new Date();

    // The system's own configuration, read through the consumption path so a
    // corrupt row fails the same way a real dispatch would.
    let settings: AiSettings;
    try {
      settings = await this.aiSettings.get();
    } catch (err) {
      return this.finishTest(userId, null, attemptedAt, {
        success: false,
        authenticated: false,
        roles: [],
        error:
          err instanceof Error
            ? err.message
            : 'The AI configuration could not be read.',
      });
    }

    const apiKey = await this.credentials.getSecret(
      AI_USER_CREDENTIAL_PURPOSE,
      aiUserCredentialName(userId),
    );

    if (apiKey === null) {
      return this.finishTest(userId, settings.provider, attemptedAt, {
        success: false,
        authenticated: false,
        roles: [],
        error: 'No API key is saved for your account yet. Add one, then test.',
      });
    }

    if (!settings.provider) {
      // The user's key may be perfectly good; the administrator has not
      // finished. Say exactly that, rather than anything that reads as a
      // problem with what they just typed — this is the same distinction
      // `GET /api/ai/status` keeps by returning two flags.
      return this.finishTest(userId, null, attemptedAt, {
        success: false,
        authenticated: false,
        roles: [],
        error:
          'Your administrator has not chosen an AI provider yet, so there is nothing to test your key against. Your key has been saved.',
      });
    }

    const providerKind = settings.provider;
    const provider = this.providers[providerKind];

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

    // `testConnection` NEVER throws — that contract lives in `BaseAiProvider`,
    // so there is deliberately no try/catch here.
    const result = await provider.testConnection(apiKey, probes);

    return this.finishTest(userId, providerKind, attemptedAt, result);
  }

  /**
   * Remove the key belonging to a user account that is being DELETED, or
   * whose owner has chosen to erase it themselves.
   *
   * -------------------------------------------------------------------------
   * TWO CALLERS NOW, ONE METHOD (issue #270)
   * -------------------------------------------------------------------------
   *
   * Originally written for a user-DELETION path this application still does
   * not have (see "NOTHING CALLS THIS TODAY" below, which is now half true
   * rather than wholly true). `AccountResetService.reset`'s `data_and_key`
   * scope calls this method too, on a live, still-active account that chose
   * to erase its own data and key — the mechanics are IDENTICAL either way
   * (the row lives at the same address, keyed by the string `userId`, and
   * "gone" means the same thing whether the account survives the call or
   * not), so this stayed one method with a `reason` rather than growing a
   * near-duplicate `purgeForResetUser`. Only the AUDIT trail needs to tell
   * the two apart — see `reason` below.
   *
   * -------------------------------------------------------------------------
   * WHY THIS EXISTS, AND WHY IT IS NOT MERELY HOUSEKEEPING (#38)
   * -------------------------------------------------------------------------
   *
   * `Credential` has NO FOREIGN KEY TO `User`. The only relation in
   * schema.prisma is `updatedByUserId`, which is `onDelete: SetNull` and
   * records who last EDITED a credential, not who owns it — behaviour that is
   * correct for the SMTP password it was designed for, where offboarding the
   * admin who typed it in must not delete a working mail configuration.
   *
   * A per-user key is addressed by `(purpose 'ai-user', name <userId>)`, where
   * the user id is A STRING IN THE `name` COLUMN, not a reference. The
   * database therefore has no way to know that row belongs to that user, and
   * nothing will ever collect it.
   *
   * So deleting a user leaves behind a row containing that person's live
   * OpenAI API key — encrypted, retained indefinitely, and still chargeable to
   * someone who has left. That is a data-retention defect.
   *
   * -------------------------------------------------------------------------
   * DEACTIVATION IS THE OPPOSITE DECISION, AND IT IS DELIBERATE
   * -------------------------------------------------------------------------
   *
   * Deactivation is REVERSIBLE and the user may return, so their key is
   * PRESERVED. Destroying it on a temporary suspension would make
   * reactivation silently useless until the user noticed and re-entered a key
   * — and, because a keyless user is hard-blocked (#39), "silently useless"
   * means locked out of the product.
   *
   * Deletion is not reversible and the key must go. Both halves are stated so
   * neither reads as an oversight. See docs/specs/ai-settings.md §4.1.
   *
   * -------------------------------------------------------------------------
   * NOTHING CALLED THIS FOR A LONG TIME, AND THAT WAS THE POINT
   * -------------------------------------------------------------------------
   *
   * This application still has no user-DELETION endpoint: `UsersService`
   * offers deactivation (`isActive: false`) and role changes, and nothing
   * else. So there was no site to hook when this method was written, and a
   * hook alone would have been an unenforced promise that the FIRST deletion
   * path anyone added remembered to call it.
   *
   * `AiUserCredentialCleanupTask` is the enforcement: it sweeps for rows whose
   * `name` matches no existing user and removes them, so a deletion path that
   * forgets this method still cannot leave a key behind indefinitely. This
   * method is the immediate, correct action; the sweep is the backstop that
   * does not depend on anyone remembering.
   *
   * `AccountResetService.reset` (#270) is the FIRST real caller — a live
   * account erasing its own key, not a deletion path — and it is a
   * deliberate, reviewed call site rather than the sweep quietly picking up
   * the slack, which is exactly what "reviewed call site, not a convenient
   * default" means in practice.
   *
   * Idempotent: purging a user with no key stored is not an error.
   *
   * @param reason - Which caller this is, for the audit row's `meta` only —
   *   it changes nothing about what is deleted or how. Defaults to
   *   `'account_deleted'` so the one pre-existing (if still theoretical)
   *   caller's behavior is unchanged by this parameter's addition.
   */
  async purgeForDeletedUser(
    userId: string,
    reason: 'account_deleted' | 'account_reset' = 'account_deleted',
  ): Promise<void> {
    await this.credentials.deleteSecret(
      AI_USER_CREDENTIAL_PURPOSE,
      aiUserCredentialName(userId),
    );

    // Audited under the same action a user's own deletion uses. The actor is
    // the user themselves rather than whoever ran the deletion: the row
    // describes whose credential was destroyed, and `actorUserId` is the only
    // user column an audit event has.
    //
    // NOTE THE ORDER: the credential is removed BEFORE the audit row is
    // written, so a failure to audit cannot leave the key in place. An
    // unaudited deletion is a smaller problem than a retained credential.
    await this.audit(userId, 'ai_key:delete', { reason });

    this.logger.log(`AI key purged for user ${userId} (${reason})`);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Build, log and audit one test outcome.
   *
   * One place, so every outcome reaches the user in the same shape and the
   * audit trail with the same fields.
   */
  private async finishTest(
    userId: string,
    providerKind: AiProviderKind | null,
    attemptedAt: Date,
    outcome: {
      success: boolean;
      authenticated: boolean;
      roles: AiTestResult['roles'];
      error: string | null;
    },
  ): Promise<AiTestResult> {
    if (!outcome.success) {
      // `warn`, not `error`: a user's own key being wrong is not a fault of
      // this service. The text is already redacted (provider failures) or
      // authored here (configuration messages, which quote no stored value).
      this.logger.warn(
        `AI key test failed for user ${userId}: ${outcome.error}`,
      );
    }

    await this.audit(userId, 'ai_key:test', {
      provider: providerKind,
      success: outcome.success,
      authenticated: outcome.authenticated,
      unreachableRoles: outcome.roles
        .filter((role) => !role.reachable)
        .map((role) => role.roleKey),
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

  /**
   * Record an action on the caller's own key.
   *
   * THE META CARRIES NEITHER THE KEY NOR ITS HINT. An audit row is queried and
   * exported far more casually than a credential is, and a hint is a
   * substantial fraction of a short secret. The `meta` this method accepts is
   * built by callers from booleans and role keys only; there is deliberately
   * no path here that could receive a credential.
   *
   * `targetType`/`targetId` name the credential ADDRESS rather than a row id:
   * the credential may not exist (a delete on nothing, a test before a save),
   * and the address is stable across the row's whole life.
   */
  private async audit(
    userId: string,
    action: 'ai_key:set' | 'ai_key:delete' | 'ai_key:test',
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'credential',
        // The address, not the key. `ai-user/<id>` is the same string the
        // store is keyed by, so an audit row and a credential row can be
        // matched without either carrying the other's contents.
        targetId: `${AI_USER_CREDENTIAL_PURPOSE}/${aiUserCredentialName(userId)}`,
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
