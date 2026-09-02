import { Injectable } from '@nestjs/common';

import { CredentialsService } from '../credentials/credentials.service';
import { AiSettingsService } from './ai-settings.service';
import {
  AI_USER_CREDENTIAL_PURPOSE,
  aiUserCredentialName,
} from './ai-credential.constants';
import type { AiStatusResponse } from './dto/ai-status.dto';

// =============================================================================
// AiStatusService — the availability gate (issue #36, epic #25)
// =============================================================================
//
// The web app consults this on EVERY navigation to decide whether to hard-block
// a user into the key setup screen. Two things follow from that, and both are
// design constraints rather than optimisations.
//
// -----------------------------------------------------------------------------
// 1. IT MUST BE CHEAP
// -----------------------------------------------------------------------------
//
// NO OUTBOUND PROVIDER CALL IS MADE ON THIS PATH, ever. Not to validate the
// key, not to check a model exists. That would put an OpenAI round trip in
// front of every page transition, and an OpenAI outage would lock every user
// out of an application that had nothing wrong with it.
//
// The per-user half is a single indexed existence check on `credentials`'
// `@@unique([purpose, name])` — `describe`, not `getSecret`, so no decrypt
// happens and the ciphertext is not even selected.
//
// The system half is cached in-process and invalidated on a settings write,
// through the same listener mechanism the provider's catalog cache uses.
//
// -----------------------------------------------------------------------------
// 2. IT MUST NOT LEAK ADMIN CONFIGURATION
// -----------------------------------------------------------------------------
//
// Every authenticated user reads this, including a Viewer. It reports whether
// the system is ready and which of the app's own capabilities are unbound; it
// reports nothing about the server key, the provider, or the model ids. See
// the compile-time proof in ./dto/ai-status.dto.ts.
// =============================================================================

/**
 * How long the system half stays cached, in milliseconds.
 *
 * A BACKSTOP, NOT THE PRIMARY MECHANISM. Correctness comes from the
 * invalidation listener registered in `AiModule` — a settings write drops this
 * immediately, so an admin never waits. The TTL exists only so a cache that
 * somehow missed an invalidation (a second API process, a listener removed by
 * a future refactor) self-heals in seconds rather than living until a restart.
 *
 * Short on purpose for that reason: the value it protects is one indexed
 * lookup, so a low hit rate costs almost nothing, while a long stale window
 * costs an admin their confidence that a save took effect.
 */
const SYSTEM_STATUS_TTL_MS = 30_000;

/** The cached system half, with the moment it was computed. */
interface CachedSystemStatus {
  value: Omit<AiStatusResponse, 'userKeyConfigured'>;
  computedAt: number;
}

@Injectable()
export class AiStatusService {
  private cache: CachedSystemStatus | null = null;

  constructor(
    private readonly credentials: CredentialsService,
    private readonly aiSettings: AiSettingsService,
  ) {}

  /**
   * Drop the cached system half.
   *
   * Wired to `AiSettingsService.onSettingsChanged` in `AiModule` — not by
   * injecting this service into that one, which would make the two modules
   * import each other and leave `design:paramtypes` holding `undefined` under
   * `emitDecoratorMetadata`.
   */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * The two independent facts, for one caller.
   *
   * @param userId the AUTHENTICATED caller. Like every route in
   *        `AiUserKeyController`, the controller passes the principal and
   *        nothing else — there is no parameter for a caller to fill.
   */
  async describe(userId: string): Promise<AiStatusResponse> {
    // Both halves in parallel: they are independent, and this endpoint is on
    // the navigation path.
    const [userKeyConfigured, system] = await Promise.all([
      this.hasUserKey(userId),
      this.describeSystem(),
    ]);

    return { userKeyConfigured, ...system };
  }

  /**
   * Does this caller have a key stored?
   *
   * `describe`, NOT `getSecret`. The question is existence, and `describe`
   * returns a type that cannot hold secret material and whose query does not
   * select the ciphertext column — so on the hottest path in the application,
   * the encrypted bytes never leave Postgres and no decrypt is attempted.
   *
   * Using `getSecret` here would additionally mean that a key which fails to
   * decrypt (a rotated `SECRETS_ENCRYPTION_KEY`) throws on every navigation
   * rather than reporting "no key", which would take the whole app down for
   * that user instead of returning them to the setup screen.
   */
  private async hasUserKey(userId: string): Promise<boolean> {
    const info = await this.credentials.describe(
      AI_USER_CREDENTIAL_PURPOSE,
      aiUserCredentialName(userId),
    );

    return info !== null;
  }

  /** The administrator-configured half, cached. */
  private async describeSystem(): Promise<
    Omit<AiStatusResponse, 'userKeyConfigured'>
  > {
    if (this.cache && Date.now() - this.cache.computedAt < SYSTEM_STATUS_TTL_MS) {
      return this.cache.value;
    }

    // `describeReadiness` never throws — a corrupt settings row reports "not
    // ready" rather than taking down the gate that decides whether anyone can
    // use the app.
    const readiness = await this.aiSettings.describeReadiness();

    const value = {
      systemReady: readiness.systemReady,
      enabled: readiness.enabled,
      providerConfigured: readiness.providerConfigured,
      unboundRoles: readiness.unboundRoles,
    };

    this.cache = { value, computedAt: Date.now() };

    return value;
  }
}
