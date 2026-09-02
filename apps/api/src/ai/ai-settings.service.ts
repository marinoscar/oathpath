import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  AI_SETTINGS_KEY,
  AiSettings,
  DEFAULT_AI_SETTINGS,
  aiSettingsSchema,
} from './ai-settings.schema';
import {
  AI_SYSTEM_CREDENTIAL_LABEL,
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
} from './ai-credential.constants';
import { AI_MODEL_ROLES, wiredModelRoles } from './ai-model-roles';
import { filterCatalog } from './providers/model-classifier';
import type { AiCapabilityFamily } from './ai-model-roles';
import type { AiProvider } from './providers/ai-provider.interface';
import type { AiModelCatalogResponse } from './dto/ai-model-catalog.dto';
import type { UpdateAiSettingsInput } from './dto/update-ai-settings.dto';

// =============================================================================
// AiSettingsService — where AI configuration is read from (issue #30, epic #25)
// =============================================================================
//
// Modelled directly on `email/email-settings.service.ts`, which solved this
// shape for SMTP. The reasoning there transfers unchanged and is not repeated
// in full here; the short version is that AI configuration lives in a row of
// its own under `system_settings.key = 'ai'`, NOT inside the 'global' blob,
// because `SystemSettingsService` rebuilds that blob field by field on every
// write and would silently destroy an `ai` key the next time an admin saved a
// feature flag. See `ai-settings.schema.ts`'s note on AI_SETTINGS_KEY.
//
// THE SERVER API KEY IS NOT IN THIS ROW. It goes to the encrypted credential
// store at `('ai', 'openai')`, and this service is the only thing that writes
// it — so "save the AI configuration" is ONE operation with one ordering
// story, rather than a controller stitching two writes together and getting
// the order wrong.
//
// NOTE WHICH CREDENTIAL METHODS THIS FILE USES: `setSecret` (write) and
// `describe` (masked read). `getSecret` — the plaintext one — is never called
// here and must not be: nothing on the settings path needs the key's value,
// and a call to it would put plaintext one careless `return` away from an
// admin response.
// =============================================================================

/**
 * The masked view of the stored server key that the admin page renders.
 *
 * A boolean alone is not enough: an admin who has just rotated a key needs to
 * see WHICH value is live, and "when, and by whom" is the difference between
 * "my change saved" and "I am looking at a colleague's value from months ago".
 *
 * EVERY FIELD HERE IS NON-SECRET BY CONSTRUCTION. `hint` is the credential
 * store's own mask, derived on write by code that already holds the plaintext;
 * nothing in this module can widen it, and no other part of the key is
 * representable in this shape.
 */
export interface AiApiKeyStatus {
  /** Is a key stored at `(purpose 'ai', name 'openai')`? */
  configured: boolean;

  /** The store's mask, e.g. `••••x9fQ`. Null when nothing is stored. */
  hint: string | null;

  /** When the stored key was last written. */
  updatedAt: Date | null;

  /** Who last wrote it. Null when nothing is stored, or the user was deleted. */
  updatedByUserId: string | null;
}

/**
 * What the admin settings page reads: the configuration plus the things it
 * cannot derive.
 *
 * Extends {@link AiSettings} rather than nesting it, so a field added to the
 * schema appears here with no edit. The response DTO is derived from the same
 * schema for the same reason, and carries its own compile-time proof that no
 * secret-bearing field crept into the extension.
 */
export interface AiSettingsAdminView extends AiSettings {
  apiKeyStatus: AiApiKeyStatus;

  /**
   * Why the stored row could not be read, when it could not be. Null normally.
   * FIELD PATHS ONLY — see the note where it is built.
   */
  settingsError: string | null;

  /** Bumped on every write. The optimistic-concurrency token for `If-Match`. */
  version: number;

  updatedAt: Date | null;

  updatedBy: { id: string; email: string } | null;
}

/**
 * A zod failure rendered as the list of field paths that failed.
 *
 * PATHS, NEVER VALUES, and both callers depend on that: one logs the result
 * and one returns it to an admin. `zod`'s own `message` strings can quote the
 * received value, so the issue objects are never stringified wholesale. There
 * is no secret in this schema today — there is a compile-time proof of that in
 * ai-settings.schema.ts — and this function is what keeps the claim true if
 * the schema ever grows.
 */
function describeInvalidPaths(error: z.ZodError): string {
  return error.issues
    .map((issue) => issue.path.join('.') || '(root)')
    .join(', ');
}

/**
 * Is this submission "I did not retype the key"?
 *
 * Mirrors `CredentialsService.isBlankSecret` exactly, including the ABSENCE of
 * `.trim()`: a key whose surrounding whitespace is significant is a real key,
 * and silently altering a secret's bytes produces an authentication failure
 * with no visible cause.
 *
 * It exists here only to decide WHETHER TO CALL `setSecret` at all; the
 * preserve behaviour itself belongs to the store and is not reimplemented.
 */
function isBlankKey(value: string | null | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Drop the model bindings an admin left empty.
 *
 * A `<Select>` with no selection submits `''`, and a reset controlled
 * component submits `null`. The schema expresses "not bound" as `null`, so
 * `''` is normalised here — once, in one documented place — rather than being
 * accepted by the schema, which would then have to distinguish an empty string
 * from a model id at every read.
 */
function normaliseModelBindings(
  models: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!models || typeof models !== 'object') return {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(models)) {
    out[key] = value === '' ? null : value;
  }
  return out;
}

@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);

  /**
   * Listeners notified after every successful write.
   *
   * WHY A CALLBACK LIST RATHER THAN A DIRECT CALL: two things must react to a
   * settings write — the provider's catalog cache (#29) and the status
   * endpoint's `systemReady` cache (#36) — and both live in modules that
   * already depend on this service. Injecting them back here would make the
   * two modules import each other, and with `emitDecoratorMetadata` a cycle
   * leaves `design:paramtypes` holding `undefined` and Nest failing at boot.
   * The same hazard `ai-credential.constants.ts` exists to avoid.
   */
  private readonly invalidationListeners: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    // The server key's only home in this module. Used through `setSecret`
    // (write) and `describe` (masked read) only — never `getSecret`.
    private readonly credentials: CredentialsService,
  ) {}

  /**
   * Register a callback fired after every successful settings write.
   *
   * Callbacks must not throw and must not be slow: they run on the admin's
   * save path. Both current listeners are a single field assignment.
   */
  onSettingsChanged(listener: () => void): void {
    this.invalidationListeners.push(listener);
  }

  /**
   * Read the current AI configuration.
   *
   * @returns validated settings; {@link DEFAULT_AI_SETTINGS} when nothing has
   *          been configured yet.
   * @throws if a row exists but does not validate (see below).
   */
  async get(): Promise<AiSettings> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: AI_SETTINGS_KEY },
      select: { value: true },
    });

    if (!row) {
      // Absent is NOT an error: a fresh install has no AI configuration and
      // that is a normal, expected state. Callers see "no provider selected"
      // and report it as such.
      return DEFAULT_AI_SETTINGS;
    }

    const parsed = aiSettingsSchema.safeParse(row.value);

    if (!parsed.success) {
      // THROW, DO NOT FALL BACK TO DEFAULTS. Silently substituting defaults
      // for a stored-but-invalid configuration reports the system as "AI not
      // configured" when what actually happened is that a hand-edited row, a
      // bad migration, or an older schema left something unreadable. That is
      // the same silent-disablement failure CredentialsService refuses on a
      // decrypt error, for the same reason: a configuration problem has to be
      // visible to the person who can fix it.
      //
      // FIELD PATHS ONLY, NEVER VALUES. No secret is in this schema by
      // construction, but an error message that echoes stored configuration is
      // a habit that stops being safe the moment the schema grows.
      const paths = describeInvalidPaths(parsed.error);

      this.logger.error(
        `Stored AI settings are invalid at: ${paths}. AI is unusable until they are saved again.`,
      );

      throw new Error(
        `Stored AI settings are invalid at: ${paths}. Re-save the AI configuration.`,
      );
    }

    return parsed.data;
  }

  /**
   * Is the system ready to serve AI at all?
   *
   * Provider chosen, master switch on, and every WIRED role bound. Read by
   * `GET /api/ai/status` (#36).
   *
   * ONLY THE WIRED ROLES COUNT. Four of the six are declared and inert (#27);
   * requiring them would mean a fresh install could never become ready no
   * matter what an admin did.
   *
   * NEVER THROWS — an invalid stored row reports "not ready" rather than
   * taking down the gate that decides whether anyone can use the app. The
   * repair path is `describeForAdmin`, which reports why.
   */
  async describeReadiness(): Promise<{
    systemReady: boolean;
    enabled: boolean;
    providerConfigured: boolean;
    unboundRoles: string[];
  }> {
    let settings: AiSettings;
    try {
      settings = await this.get();
    } catch {
      // A corrupt row is not ready, and every wired role is reported unbound —
      // which is true, in the sense the caller cares about.
      return {
        systemReady: false,
        enabled: false,
        providerConfigured: false,
        unboundRoles: wiredModelRoles().map((role) => role.key),
      };
    }

    const unboundRoles = wiredModelRoles()
      .filter((role) => !settings.models[role.key])
      .map((role) => role.key);

    const providerConfigured = settings.provider !== null;

    return {
      systemReady:
        providerConfigured && settings.enabled && unboundRoles.length === 0,
      enabled: settings.enabled,
      providerConfigured,
      unboundRoles,
    };
  }

  /**
   * The model catalog and the role registry, filtered for one admin view
   * (`GET /api/ai-settings/models`, #31).
   *
   * -------------------------------------------------------------------------
   * THE ROLES ARE ALWAYS RETURNED, EVEN WHEN THE CATALOG COULD NOT BE FETCHED
   * -------------------------------------------------------------------------
   *
   * They come from the code registry, not from the provider, so a missing key
   * or a provider outage has no bearing on them. Withholding them would leave
   * the admin page unable to render the very controls that explain what is
   * wrong — an empty screen instead of six selects and a "no key stored yet"
   * message.
   *
   * -------------------------------------------------------------------------
   * A PROVIDER FAILURE IS A PAYLOAD, NOT A 500
   * -------------------------------------------------------------------------
   *
   * `listModels` never throws by construction (`BaseAiProvider`), and the two
   * non-success outcomes are carried separately: `notConfigured` for "no key
   * stored", which is the state of every fresh install and must not read as an
   * error, and `error` for a real provider refusal, verbatim after redaction.
   *
   * @param provider the configured provider, or `null` when none is selected.
   *        PASSED IN rather than resolved here: this service must not depend
   *        on the provider (see `AiModule`'s constructor for why that cycle is
   *        a boot failure, not a style problem).
   * @param family restrict to one capability family, for a single role's
   *        select. Absent returns every family.
   * @param showAll engage the escape hatch: no floor, every family, including
   *        ids the classifier did not recognise.
   */
  async describeCatalog(
    provider: AiProvider | null,
    options: { family?: AiCapabilityFamily; showAll?: boolean } = {},
  ): Promise<AiModelCatalogResponse> {
    const showAll = options.showAll === true;

    // The floor comes from the stored configuration, but a corrupt row must
    // not take this endpoint down — the admin page is where a corrupt row gets
    // repaired, and `describeForAdmin` reports the problem alongside.
    let minGeneration = DEFAULT_AI_SETTINGS.minModelGeneration;
    try {
      minGeneration = (await this.get()).minModelGeneration;
    } catch {
      // Keep the default. `describeForAdmin` is the endpoint that explains it.
    }

    const roles = AI_MODEL_ROLES.map((role) => ({
      key: role.key,
      label: role.label,
      description: role.description,
      capability: role.capability,
      // A role the configured provider cannot serve at all is reported as
      // unwired for THIS deployment, so the page renders it inert rather than
      // offering a select whose every choice would fail. A provider that
      // does not declare a capability cannot be selected for that role — the
      // gate lives in the provider (#28), and this is it reaching the UI.
      wired: role.wired && (provider?.supports(role.capability) ?? false),
    }));

    const base = { roles, minGeneration, showAll };

    if (!provider) {
      // No provider selected. Not an error and not "not configured" — the
      // admin has simply not chosen one yet, which the page can see from
      // `GET /api/ai-settings` and does not need repeated as a failure here.
      return { ...base, models: [], notConfigured: true, error: null };
    }

    const catalog = await provider.listModels();

    if (catalog.notConfigured) {
      return { ...base, models: [], notConfigured: true, error: null };
    }

    if (!catalog.success) {
      return { ...base, models: [], notConfigured: false, error: catalog.error };
    }

    const models = filterCatalog(catalog.models, {
      family: options.family,
      minGeneration,
      showAll,
    }).map((model) => ({
      id: model.id,
      family: model.family,
      generation: model.generation,
      createdAt: model.createdAt ? model.createdAt.toISOString() : null,
    }));

    return { ...base, models, notConfigured: false, error: null };
  }

  // ---------------------------------------------------------------------------
  // Admin surface
  // ---------------------------------------------------------------------------

  /**
   * Everything `GET /api/ai-settings` renders.
   *
   * SEPARATE FROM {@link get} ON PURPOSE, in two ways that matter.
   *
   * 1. IT DOES NOT THROW ON AN INVALID STORED ROW; it reports the problem in
   *    `settingsError` and returns the defaults alongside it. `get` is the
   *    consumption path and is right to throw — a corrupt row must not be
   *    reported to a provider as the benign "AI is not configured". This is
   *    the REPAIR path, and a 500 here would make the broken row take down the
   *    one screen capable of fixing it. The failure is still loud: it is in
   *    the payload, in front of the person who can act on it.
   *
   * 2. IT TOUCHES THE CREDENTIAL STORE, which `get` deliberately does not. A
   *    consumption path has no business paying for a credential lookup it will
   *    not use.
   *
   * The key itself is NOT read here. `describe` returns `CredentialInfo`, a
   * type carrying a compile-time proof that it cannot hold secret material,
   * and whose query does not select the ciphertext column at all.
   */
  async describeForAdmin(): Promise<AiSettingsAdminView> {
    const row = await this.prisma.systemSettings.findUnique({
      where: { key: AI_SETTINGS_KEY },
      include: { updatedByUser: { select: { id: true, email: true } } },
    });

    let settings: AiSettings = DEFAULT_AI_SETTINGS;
    let settingsError: string | null = null;

    if (row) {
      const parsed = aiSettingsSchema.safeParse(row.value);

      if (parsed.success) {
        settings = parsed.data;
      } else {
        const paths = describeInvalidPaths(parsed.error);

        this.logger.error(
          `Stored AI settings are invalid at: ${paths}. Serving defaults to the settings page so they can be re-saved.`,
        );

        settingsError = `The stored AI configuration is invalid at: ${paths}. Correct those fields and save to repair it.`;
      }
    }

    return this.toAdminView(settings, settingsError, row);
  }

  /**
   * Replace the AI configuration (`PUT /api/ai-settings`).
   *
   * TWO DESTINATIONS, ONE SUBMISSION. The ordinary settings go to the `ai` row
   * of `system_settings`; the server API key goes to the encrypted credential
   * store and NOWHERE ELSE.
   *
   * -----------------------------------------------------------------------
   * WHY THE KEY IS WRITTEN FIRST
   * -----------------------------------------------------------------------
   *
   * `CredentialsService.setSecret` rejects (400) a blank secret written to an
   * address that holds nothing yet. Doing the settings write first would mean
   * the request persists a selected provider with no key behind it and THEN
   * 400s — the admin sees a failure, the configuration changed anyway, and the
   * next catalog fetch fails for a reason the error never mentioned. Key first
   * makes that refusal happen before anything is persisted.
   *
   * The opposite partial failure (credential written, settings write fails) is
   * harmless by construction: a stored key that no settings row points at is
   * inert, and the next successful save picks it up.
   *
   * -----------------------------------------------------------------------
   * BLANK PRESERVES — AND WHY `setSecret` IS SKIPPED ENTIRELY WHEN BLANK
   * -----------------------------------------------------------------------
   *
   * An empty key field means "I did not retype the key", so the stored one is
   * kept. `CredentialsService` already implements exactly that and this method
   * must not reimplement, second-guess or pre-normalise it: no `.trim()`, no
   * `''` -> `undefined` coercion, no "erase when empty" branch. The value
   * arrives here byte-for-byte as submitted.
   *
   * What this method DOES decide is whether to call `setSecret` at all, and it
   * calls it only for a non-blank value — so an admin adjusting a model
   * binding on a system that has never stored a key does not hit that
   * first-write 400 on a save that has nothing to do with the key.
   *
   * THE FIRST-WRITE-WITH-A-PROVIDER CASE IS REFUSED HERE, deliberately, rather
   * than being left to fail later. Selecting a provider with no key stored and
   * none submitted produces a configuration that saves cleanly and cannot do
   * anything, and the admin finds out from an empty model dropdown.
   *
   * Erasing a stored key is `CredentialsService.deleteSecret`, from a distinct
   * control. It is deliberately not reachable through this endpoint.
   *
   * @param expectedVersion optional `If-Match`; a mismatch is a 409 rather
   *                        than a silent overwrite of a colleague's save.
   */
  async update(
    input: UpdateAiSettingsInput,
    userId: string,
    expectedVersion?: number,
  ): Promise<AiSettingsAdminView> {
    // Destructured out FIRST, so the key is a named local that never travels
    // with the rest of the body. `aiSettingsSchema.parse` below would strip it
    // anyway (zod drops unknown keys) — that is the structural guarantee — but
    // relying on a silent strip to keep a secret out of a persisted blob is a
    // guarantee nobody reading the call site can see.
    const { apiKey, ...submitted } = input;

    const settings = aiSettingsSchema.parse({
      ...submitted,
      models: normaliseModelBindings(
        submitted.models as Record<string, unknown> | undefined,
      ),
    });

    // Read the current row once, for the concurrency check. `version` starts at
    // 0 for "no row yet" so a first save can be guarded with `If-Match: 0`
    // rather than having no way to express "I believe nothing is stored".
    const existing = await this.prisma.systemSettings.findUnique({
      where: { key: AI_SETTINGS_KEY },
      select: { version: true },
    });
    const currentVersion = existing?.version ?? 0;

    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new ConflictException(
        `AI settings version mismatch. Expected ${expectedVersion}, found ${currentVersion}`,
      );
    }

    const keySubmitted = !isBlankKey(apiKey);

    if (keySubmitted) {
      // See the header: key first, and only when one was actually typed.
      await this.credentials.setSecret(
        AI_SYSTEM_CREDENTIAL_PURPOSE,
        AI_SYSTEM_CREDENTIAL_NAME,
        // Passed through UNTOUCHED. See the blank-preserves note above.
        apiKey,
        { label: AI_SYSTEM_CREDENTIAL_LABEL, updatedByUserId: userId },
      );
    } else if (settings.provider !== null) {
      // A provider is selected and no key was typed. That is fine IF one is
      // already stored — the ordinary "edit a model binding" save. It is a
      // configuration error if nothing is stored, and refusing here is the
      // difference between an admin who is told now and an admin who finds an
      // empty model dropdown with nothing explaining it.
      const stored = await this.credentials.describe(
        AI_SYSTEM_CREDENTIAL_PURPOSE,
        AI_SYSTEM_CREDENTIAL_NAME,
      );

      if (stored === null) {
        // Not a 400 thrown by the credential store's first-write guard — that
        // one talks about credential addresses. This one is about the form the
        // admin is looking at.
        throw new ConflictException(
          'Select a provider and enter an API key together: no key is stored yet, and a blank key field preserves an existing key rather than creating one.',
        );
      }
    }

    const row = await this.prisma.systemSettings.upsert({
      where: { key: AI_SETTINGS_KEY },
      update: {
        value: settings as unknown as Prisma.InputJsonValue,
        updatedByUserId: userId,
        version: { increment: 1 },
      },
      create: {
        key: AI_SETTINGS_KEY,
        value: settings as unknown as Prisma.InputJsonValue,
        updatedByUserId: userId,
      },
      include: { updatedByUser: { select: { id: true, email: true } } },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'ai_settings:replace',
        targetType: 'system_settings',
        targetId: row.id,
        meta: {
          // SAFE TO RECORD IN FULL: `settings` is the output of
          // `aiSettingsSchema.parse`, and that schema carries a compile-time
          // proof that it has no secret-bearing field. The key is not in this
          // object and cannot become so without that proof failing to compile.
          newValue: settings as unknown as Prisma.InputJsonValue,
          // WHETHER the key changed, never what it changed to. This is the
          // fact an audit trail needs — "who rotated the AI credential, and
          // when" — and it is the whole of what can be safely recorded.
          apiKeyChanged: keySubmitted,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // Fire AFTER the write commits, so a listener that re-reads sees the new
    // value. Wrapped because a listener throwing must not turn a successful
    // save into a 500 — the admin's change is already persisted, and a stale
    // cache is a far smaller problem than a save that reports failure.
    this.notifyChanged();

    // userId only. No settings values, and above all no key: application logs
    // are shipped, indexed and retained far more widely than this table is.
    this.logger.log(
      `AI settings replaced by user ${userId}` +
        (keySubmitted ? ' (API key updated)' : ''),
    );

    return this.toAdminView(settings, null, row);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private notifyChanged(): void {
    for (const listener of this.invalidationListeners) {
      try {
        listener();
      } catch (err) {
        this.logger.warn(
          `An AI settings change listener threw and was ignored: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      }
    }
  }

  /**
   * Assemble the admin view from an already-validated settings object and the
   * row it came from.
   *
   * Shared by {@link describeForAdmin} and {@link update} so a PUT's response
   * is built by the same code as the following GET — otherwise the page can
   * render one shape after saving and a different one after a reload, and the
   * difference is invisible until someone hits it.
   *
   * Fields are named EXPLICITLY rather than spread from the row, matching
   * `CredentialsService.toInfo`: a spread makes the response shape a
   * consequence of whatever the query happened to select.
   */
  private async toAdminView(
    settings: AiSettings,
    settingsError: string | null,
    row: {
      version: number;
      updatedAt: Date;
      updatedByUser: { id: string; email: string } | null;
    } | null,
  ): Promise<AiSettingsAdminView> {
    // The masked read. NOT `getSecret` — `describe` returns `CredentialInfo`,
    // which has no field capable of carrying secret material, so there is
    // nothing on this path that could be widened into a leak.
    const info = await this.credentials.describe(
      AI_SYSTEM_CREDENTIAL_PURPOSE,
      AI_SYSTEM_CREDENTIAL_NAME,
    );

    return {
      ...settings,
      apiKeyStatus: {
        configured: info !== null,
        // The store's own mask. Derived on write by `CredentialsService`;
        // never computed here, because computing it would mean holding the
        // plaintext to compute it from.
        hint: info?.hint ?? null,
        updatedAt: info?.updatedAt ?? null,
        updatedByUserId: info?.updatedByUserId ?? null,
      },
      settingsError,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedByUser ?? null,
    };
  }
}
