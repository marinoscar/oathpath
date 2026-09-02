// =============================================================================
// AI credential addresses (issue #27, epic #25)
// =============================================================================
//
// The `(purpose, name)` pairs the two OpenAI key scopes are stored under in the
// encrypted credential store (`credentials/credentials.service.ts`, #115).
//
// WHY THIS IS A LEAF MODULE THAT IMPORTS NOTHING:
//
// `smtp-credential.constants.ts` documents the failure this shape avoids, and
// it applies here identically. `AiSettingsService` (#30) writes the system key
// and `OpenAiProvider` (#29) reads it; the provider also needs the settings.
// Had the addresses lived in either file, the two modules would import each
// other, and with `emitDecoratorMetadata` a cycle is not a style problem:
// `design:paramtypes` is evaluated at class-decoration time, so whichever
// module CommonJS begins loading second sees `undefined` where a constructor
// parameter type should be, and Nest fails to resolve the dependency at boot.
//
// So the shared values live here, in a file with no imports at all.
//
// -----------------------------------------------------------------------------
// TWO PURPOSES, AND THAT IS THE POINT
// -----------------------------------------------------------------------------
//
// `purpose` is not merely the first half of an address. It is ALSO the HKDF
// sub-key domain in `common/crypto/secret-cipher.ts`'s `deriveKey(purpose)`,
// and `CredentialsService` passes the same string to both by construction, so
// the two can never drift.
//
// The consequence is that the organisation's key and a named individual's key
// are encrypted under DIFFERENT sub-keys. A ciphertext lifted from one scope
// into the other — by a SQL write, or by a bug copying rows — fails GCM
// authentication rather than decrypting into a context where it means
// something entirely different. That is the same guarantee `smtp` relies on,
// and it is worth more here, where one scope is organisation-wide and the
// other belongs to a person.
//
// CHANGING EITHER PURPOSE STRING IS NOT A RENAME. Every already-stored key
// under the old spelling remains in the table and becomes permanently
// unreadable — which for `ai-user` means every user is locked out of the
// product until they re-enter a key (see docs/specs/ai-settings.md §16).
// =============================================================================

/**
 * Credential store address for the SERVER key: the sub-key domain.
 *
 * This key exists to fetch the model catalog and to let an admin prove
 * connectivity. It is NEVER used for inference — every inference call runs on
 * the calling user's own key (epic #25, decision 4).
 */
export const AI_SYSTEM_CREDENTIAL_PURPOSE = 'ai';

/**
 * Discriminator within the system purpose.
 *
 * Named for the provider rather than `'default'` because a second provider
 * (Anthropic, Kimi, Qwen — see `ai-settings.schema.ts`) gets its own row here
 * without touching anything above.
 */
export const AI_SYSTEM_CREDENTIAL_NAME = 'openai';

/**
 * Human label written alongside the stored server key.
 *
 * NON-SECRET, and it must stay that way: `CredentialMeta` carries a
 * compile-time proof that it has no secret-bearing field, and this string is
 * shown verbatim in any credential listing.
 */
export const AI_SYSTEM_CREDENTIAL_LABEL = 'OpenAI API key (server)';

/**
 * Credential store address for a PER-USER key: a distinct sub-key domain.
 *
 * See the header — this being a different string from
 * {@link AI_SYSTEM_CREDENTIAL_PURPOSE} is what domain-separates an
 * individual's key from the organisation's.
 */
export const AI_USER_CREDENTIAL_PURPOSE = 'ai-user';

/**
 * Human label written alongside a stored per-user key.
 *
 * Deliberately carries no user identifier: `label` is non-secret metadata that
 * a listing renders verbatim, and the address already holds the user id.
 */
export const AI_USER_CREDENTIAL_LABEL = 'OpenAI API key (personal)';

/**
 * The `name` half of a per-user key's address: the user's own id.
 *
 * A FUNCTION RATHER THAN AN INLINE `userId`, for two reasons.
 *
 * 1. It is the single place the mapping from "a user" to "their credential
 *    row" is defined, so a future change (a prefix, a tenant qualifier) is one
 *    edit rather than a grep across every call site — and a call site that
 *    passed a raw id would silently address a different row.
 *
 * 2. It VALIDATES. `CredentialsService.assertIdentifier` rejects an empty or
 *    whitespace-padded name, and it rejects rather than trims deliberately:
 *    a silently trimmed address is a row that saves and can never be read
 *    back. Failing here, at the point the address is constructed, names the
 *    real problem ("this user id is unusable") instead of surfacing it three
 *    frames later as a credential-store validation error.
 *
 * @throws Error if `userId` is empty or carries surrounding whitespace.
 */
export function aiUserCredentialName(userId: string): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error(
      'aiUserCredentialName requires a non-empty user id: an AI credential is addressed by the user it belongs to.',
    );
  }

  if (userId !== userId.trim()) {
    throw new Error(
      'aiUserCredentialName requires a user id with no leading or trailing whitespace: the credential address is also the cipher sub-key domain, and two spellings derive two different keys.',
    );
  }

  return userId;
}
