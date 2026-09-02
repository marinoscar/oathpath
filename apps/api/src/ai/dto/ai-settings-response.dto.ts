import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { aiSettingsSchema } from '../ai-settings.schema';

// =============================================================================
// GET/PUT /api/ai-settings — response body (issue #30, epic #25)
// =============================================================================
//
// The settings themselves, plus three things the admin page cannot work
// without and cannot derive:
//
//   1. `apiKeyStatus` — IS a key stored, and roughly which one. Without it the
//      page renders an empty box and has no way to tell the admin whether that
//      means "none set" or "one is set and you cannot see it". Those two
//      states demand opposite actions, and the blank-preserves contract is
//      unusable if the admin cannot tell them apart: submitting blank is
//      correct in one case and leaves the form broken in the other.
//
//   2. `version` / `updatedAt` / `updatedBy` — provenance and the
//      optimistic-concurrency token.
//
//   3. `settingsError` — see the note on the field.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT HERE
// -----------------------------------------------------------------------------
//
// The API key, in any shape: not the plaintext, not the ciphertext, not its
// length, not a "masked" copy of the real characters. `apiKeyStatus` is built
// from `CredentialsService.describe`, whose return type (`CredentialInfo`)
// carries its own compile-time proof that it has no field able to hold a
// secret — and whose query does not even SELECT the ciphertext column, so the
// encrypted bytes never leave Postgres for a presentation read.
//
// There is a compile-time proof at the bottom of this file, mirroring the one
// in ../ai-settings.schema.ts. That is a SEPARATE claim: this schema
// `.extend()`s that one, and an extension is exactly where a convenience field
// ("just send the key back so the form can prefill it") would land.
// =============================================================================

/**
 * What the admin page needs to know about the stored key without being told
 * the key.
 */
export const aiApiKeyStatusSchema = z.object({
  /** Is a key stored at `(purpose 'ai', name 'openai')`? */
  configured: z.boolean(),

  /**
   * The store's non-secret mask, e.g. `••••x9fQ`. Null when nothing is stored,
   * and also null for a row written outside `CredentialsService`.
   */
  hint: z.string().nullable(),

  /** When the stored key was last written. Null when nothing is stored. */
  updatedAt: z.iso.datetime().nullable(),

  /** Who last wrote it. Null when nothing is stored, or the user was deleted. */
  updatedByUserId: z.uuid().nullable(),
});

export const aiSettingsResponseSchema = aiSettingsSchema.extend({
  apiKeyStatus: aiApiKeyStatusSchema,

  /**
   * Why the stored configuration could not be read, when it could not be.
   *
   * `AiSettingsService.get()` THROWS on a stored-but-invalid row, and that is
   * right for a consumption path — a hand-edited row or a bad migration must
   * not be reported to a caller as the benign "AI is not configured".
   *
   * It is the wrong answer for THIS endpoint, and only this one. A 500 here
   * makes the settings page fail to render, which means the one screen capable
   * of repairing the row is the one screen the broken row takes down.
   *
   * Null on the normal path. Contains FIELD PATHS ONLY, never stored values.
   */
  settingsError: z.string().nullable(),

  /** Bumped on every write; pass back as `If-Match` on PUT. */
  version: z.number().int(),

  updatedAt: z.iso.datetime().nullable(),

  updatedBy: z
    .object({
      id: z.uuid(),
      email: z.email(),
    })
    .nullable(),
});

/** The GET/PUT response body, as sent (inside the global `{ data }` envelope). */
export type AiSettingsResponse = z.infer<typeof aiSettingsResponseSchema>;

export class AiSettingsResponseDto extends createZodDto(
  aiSettingsResponseSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the response grew no secret-bearing field
// -----------------------------------------------------------------------------
//
// `aiSettingsSchema` proves the PERSISTED shape carries no secret; this proves
// the RESPONSE shape does not either.
//
// `apiKeyStatus` deliberately does not match: it is a status object built from
// `CredentialInfo`, which has its own proof that it cannot hold a secret. If
// you are here because this line went red, the field you are adding is the bug
// — the value it wants is unreadable by design.

type SecretFieldNames =
  | 'apiKey'
  | 'openaiApiKey'
  | 'userApiKey'
  | 'key'
  | 'password'
  | 'secret'
  | 'token'
  | 'ciphertext';

export type AiSettingsResponseCarriesNoSecret =
  Extract<keyof AiSettingsResponse, SecretFieldNames> extends never
    ? true
    : never;

export const AI_SETTINGS_RESPONSE_CARRIES_NO_SECRET: AiSettingsResponseCarriesNoSecret =
  true;
