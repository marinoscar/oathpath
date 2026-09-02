import { z } from 'zod';

import { AI_MODEL_ROLE_KEYS } from './ai-model-roles';

// =============================================================================
// AI settings — shape and validation (issue #27, epic #25)
// =============================================================================
//
// The admin-configurable half of AI: which provider, whether AI is on at all,
// which model serves which role, and how aggressively the model catalog is
// filtered. Everything here is ORDINARY CONFIGURATION and is safe to return
// from an admin endpoint (#30).
//
// NEITHER OPENAI API KEY IS HERE, AND NEITHER MAY EVER BE ADDED. Both live in
// the encrypted credential store — the server key at `('ai', 'openai')` and
// each user's own at `('ai-user', <their id>)`, see ai-credential.constants.ts.
// The reason is mechanical, not stylistic: this object is persisted as a
// settings blob and returned wholesale by the settings endpoints, so a secret
// in it is one careless response away from exposure, and "blank preserves" on
// an admin form would have to be reimplemented here (badly) instead of being
// inherited from CredentialsService, which already enforces it. There is a
// compile-time proof of the absence at the bottom of this file.
//
// Modelled directly on `email/email-settings.schema.ts`, which solved this
// exact shape for SMTP — same two-axis provider/enabled split, same
// nullable-not-optional reasoning, same proof.
//
// Zod, not class-validator, matching the settings schemas in
// `common/schemas/settings.schema.ts`; the DTOs #30 adds derive from this
// schema rather than restate it.
// =============================================================================

/**
 * The `system_settings.key` this configuration is stored under.
 *
 * A ROW OF ITS OWN, NOT A KEY INSIDE THE 'global' BLOB. The argument is
 * written out in `email/email-settings.service.ts` and applies unchanged:
 * `SystemSettingsService` rebuilds the 'global' value field by field on every
 * write — `replaceSettings` parses through `systemSettingsSchema` and zod
 * STRIPS unknown keys, while `patchSettings` hand-builds `{ ui, features }`
 * and discards everything else even on a partial update. So an `ai` key inside
 * that blob would be silently destroyed the next time an admin saved an
 * unrelated feature flag: AI stops working, nothing in the audit trail
 * connects the two, and the admin's action ("I toggled a flag") has no visible
 * relationship to the outcome.
 *
 * A separate row also gives the AI settings page its own version counter for
 * `If-Match`, rather than sharing one with a page that has nothing to do with
 * AI.
 *
 * Exported so #30's read and write paths and every test fixture address the
 * same row by the same constant rather than by a repeated string literal.
 */
export const AI_SETTINGS_KEY = 'ai';

/**
 * Providers this app can run AI on.
 *
 * Derived type below rather than a hand-written union, so adding one widens
 * every `switch` in the same edit instead of silently falling through.
 *
 * ONE ENTRY TODAY, AND THE ENUM IS STILL RIGHT. Epic #25, decision 3: the
 * provider abstraction exists now precisely so that Anthropic, Kimi and Qwen
 * slot in without reshaping the settings surface, the test endpoint and the
 * admin page all at once. A bare boolean or a hardcoded 'openai' would make
 * that day a migration over live admin configuration.
 *
 * There is deliberately no `openai-compatible` custom-baseURL kind yet: an
 * admin-supplied base URL is an outbound-request primitive with its own trust
 * questions, and it is separable work.
 */
export const AI_PROVIDER_KINDS = ['openai'] as const;

/** A configured AI provider. See {@link AI_PROVIDER_KINDS}. */
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/**
 * Default text-family generation floor.
 *
 * The "5.4 and above" filter epic #25 asks for. It applies ONLY to the text
 * families — see `ai-model-roles.ts`'s note on `AI_CAPABILITY_FAMILIES` for
 * why a numeric floor is meaningless for `whisper-1` or `tts-1-hd`.
 *
 * CONFIGURABLE RATHER THAN CONSTANT, with a show-all escape hatch on the
 * endpoint (#31), because model naming is not ours to control: a filter that
 * cannot be relaxed eventually locks the product out of its own configuration.
 */
export const DEFAULT_MIN_MODEL_GENERATION = 5.4;

/**
 * Upper bound on the configurable floor.
 *
 * Not a security control — it stops a typo (`54` for `5.4`) from silently
 * emptying every dropdown with no error to explain it, which is exactly the
 * failure the show-all toggle exists to make recoverable and this bound makes
 * unlikely in the first place.
 */
const MAX_MIN_MODEL_GENERATION = 99;

/**
 * The role -> model-id map.
 *
 * BUILT FROM `AI_MODEL_ROLE_KEYS`, NOT HAND-WRITTEN. That is what makes the
 * registry's promise real: adding a role to `ai-model-roles.ts` adds its slot
 * here in the same edit, with no second list to remember. A restated object
 * literal is how a role ends up declared, rendered in the admin UI, and
 * silently unstorable.
 *
 * Every value is `string | null`, and `null` — not absent — is "this role is
 * not bound". The distinction matters on read: an absent key would be
 * indistinguishable from a role added after the row was written, and the
 * settings page would have no way to tell "never configured" from "explicitly
 * cleared".
 *
 * `.catchall`-free and non-strict: zod strips unknown keys, so a binding for a
 * role that has since been removed is dropped on the next save rather than
 * failing the parse and taking the settings page down with it.
 */
const modelBindingsShape = Object.fromEntries(
  AI_MODEL_ROLE_KEYS.map((key) => [
    key,
    z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      // `.default(null)` so a body that omits a role (an older client, or a
      // role added since that client shipped) stores an explicit "unbound"
      // rather than dropping the key and reintroducing the absent/null
      // ambiguity described above.
      .default(null),
  ]),
) as Record<string, z.ZodTypeAny>;

export const aiSettingsSchema = z.object({
  /**
   * Which provider to use. `null` means "no provider chosen", which is the
   * state of every fresh installation.
   *
   * NULLABLE RATHER THAN OPTIONAL: "the admin has not picked one" is a real,
   * persisted state that the settings page renders, not an absent key whose
   * meaning has to be guessed. `enabled` is a separate axis so an admin can
   * switch AI off for a maintenance window without losing the configuration
   * they would otherwise have to rebuild.
   */
  provider: z.enum(AI_PROVIDER_KINDS).nullable(),

  /**
   * Master switch. Nothing is dispatched while this is false, and
   * `systemReady` (#36) reports false — which is a point-of-use message, not a
   * block: a user with a valid personal key still gets into the app.
   */
  enabled: z.boolean(),

  /**
   * Role -> model id. See {@link modelBindingsShape}.
   *
   * The keys are the registry's, not free-form: a binding for an unknown role
   * is stripped on save rather than stored somewhere nothing will ever read.
   */
  models: z.object(modelBindingsShape),

  /**
   * Minimum model generation offered for the TEXT families.
   *
   * A number rather than a string so ordering is arithmetic rather than
   * lexicographic — `'5.10' < '5.4'` as a string, and that comparison silently
   * hides a newer model.
   */
  minModelGeneration: z
    .number()
    .min(0)
    .max(MAX_MIN_MODEL_GENERATION)
    .default(DEFAULT_MIN_MODEL_GENERATION),
});

/** Validated AI settings. */
export type AiSettings = z.infer<typeof aiSettingsSchema>;

/**
 * What a system with no AI configuration looks like.
 *
 * Not `{}`: `provider`, `enabled` and `models` are required by the schema, so
 * the "nothing configured yet" state is spelled out rather than being an
 * invalid object that only survives because nobody validates it.
 *
 * `models` is DERIVED from the registry for the same reason the shape above
 * is: a hand-written default would go stale the first time a role is added,
 * and the staleness would present as a role that cannot be bound.
 */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: null,
  enabled: false,
  models: Object.fromEntries(
    AI_MODEL_ROLE_KEYS.map((key) => [key, null]),
  ) as AiSettings['models'],
  minModelGeneration: DEFAULT_MIN_MODEL_GENERATION,
};

// -----------------------------------------------------------------------------
// Compile-time proof that no secret-bearing field crept in
// -----------------------------------------------------------------------------
//
// Mirrors `email/email-settings.schema.ts`, which mirrors the technique in
// `credentials/interfaces/credential-info.interface.ts`. Adding `apiKey` (or
// any of the other names below) to the schema above makes
// `AiSettingsCarriesNoSecret` resolve to `never`, and this file stops
// compiling — a build break at the moment of the mistake, rather than a
// security review that has to notice a new optional string.
//
// This is worth more here than it was for SMTP. There are TWO key scopes now,
// one of them a named individual's credential, and the obvious-looking
// convenience ("store the user's key with their settings") would put a
// personal secret into a blob an admin endpoint returns wholesale.
//
// If you are here because this line went red: you are trying to put a secret
// into a settings blob. Use CredentialsService instead — see
// ai-credential.constants.ts for the two addresses.

type SecretFieldNames =
  | 'apiKey'
  | 'openaiApiKey'
  | 'userApiKey'
  | 'key'
  | 'password'
  | 'secret'
  | 'token'
  | 'accessKeyId'
  | 'secretAccessKey';

export type AiSettingsCarriesNoSecret =
  Extract<keyof AiSettings, SecretFieldNames> extends never ? true : never;

export const AI_SETTINGS_CARRIES_NO_SECRET: AiSettingsCarriesNoSecret = true;
