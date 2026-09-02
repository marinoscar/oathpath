import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// /api/ai/key — request and response bodies (issue #35, epic #25)
// =============================================================================
//
// The caller's OWN OpenAI key. Every route resolving to this DTO takes its
// address from the authenticated principal; NONE of them accepts a user id.
// That is the enforcement mechanism, not a convention — see
// ai-user-key.controller.ts.
//
// THE KEY IS WRITE-ONLY, exactly as the server key is (#30). The status shape
// below is built from `CredentialsService.describe`, whose return type carries
// a compile-time proof that it cannot hold secret material and whose query
// does not select the ciphertext column at all.
// =============================================================================

/**
 * Length ceiling on the submitted key.
 *
 * Not a security control — it bounds what a paste accident can push into an
 * encrypted column, so a multi-megabyte body is refused by the validator
 * rather than by Postgres.
 */
const MAX_API_KEY_LENGTH = 1024;

export const updateAiUserKeySchema = z.object({
  /**
   * The caller's OpenAI API key. WRITE-ONLY.
   *
   * NO `.trim()`, NO `.min(1)`, NO `.default('')` — each defeats
   * blank-preserves, and each looks like tidying up:
   *
   *   * `.trim()` — a key whose surrounding whitespace is significant becomes
   *     a different key, and authentication starts failing with no visible
   *     cause. (A user pasting from a console is exactly who this bites.)
   *   * `.min(1)` — a blank submission becomes a 400, so a user cannot save
   *     the form without retyping a secret they cannot see.
   *   * `.default('')` — turns "absent" into a value.
   *
   * Blank (absent, `null`, `''`) preserves whatever is stored. Erasing is
   * `DELETE /api/ai/key`, from a distinct control.
   */
  apiKey: z.string().max(MAX_API_KEY_LENGTH).nullish(),
});

export type UpdateAiUserKeyInput = z.input<typeof updateAiUserKeySchema>;

export class UpdateAiUserKeyDto extends createZodDto(updateAiUserKeySchema) {}

/**
 * What the caller may know about their own stored key.
 *
 * Note what is NOT here even for the key's own owner: the key. It is
 * unreadable through the API by design — the same store, the same guarantee,
 * and deliberately not relaxed for self-access. A user who has lost their key
 * gets a new one from OpenAI; letting the app read it back would mean the app
 * can read it back, which is the property this design exists to avoid.
 *
 * `updatedByUserId` is absent, unlike the server key's status: for a personal
 * credential the only possible writer is the owner, so the field would carry
 * no information and would be one more place a user id travels.
 */
export const aiUserKeyStatusSchema = z.object({
  /** Is a key stored for this caller? */
  configured: z.boolean(),

  /** The store's non-secret mask, e.g. `••••x9fQ`. Null when nothing is stored. */
  hint: z.string().nullable(),

  /** When it was last written. Null when nothing is stored. */
  updatedAt: z.iso.datetime().nullable(),
});

export type AiUserKeyStatus = z.infer<typeof aiUserKeyStatusSchema>;

export class AiUserKeyStatusDto extends createZodDto(aiUserKeyStatusSchema) {}

// -----------------------------------------------------------------------------
// Compile-time proof that the status grew no secret-bearing field
// -----------------------------------------------------------------------------
//
// The tempting addition here is "let the user see their own key" — and the
// answer is no, for the reason on the schema above.

type SecretFieldNames =
  | 'apiKey'
  | 'key'
  | 'secret'
  | 'token'
  | 'password'
  | 'ciphertext';

export type AiUserKeyStatusCarriesNoSecret =
  Extract<keyof AiUserKeyStatus, SecretFieldNames> extends never ? true : never;

export const AI_USER_KEY_STATUS_CARRIES_NO_SECRET: AiUserKeyStatusCarriesNoSecret =
  true;
