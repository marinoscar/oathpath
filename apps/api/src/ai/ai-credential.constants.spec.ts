import {
  AI_SYSTEM_CREDENTIAL_NAME,
  AI_SYSTEM_CREDENTIAL_PURPOSE,
  AI_USER_CREDENTIAL_PURPOSE,
  aiUserCredentialName,
} from './ai-credential.constants';

// =============================================================================
// AI credential addresses (issue #27, epic #25)
// =============================================================================
//
// `purpose` is also the HKDF sub-key domain in `common/crypto/secret-cipher.ts`
// (`deriveKey(purpose)`), so these strings are not labels — they decide which
// key a ciphertext can be read back with. Changing one is not a rename; it
// orphans every already-stored key under the old spelling.
// =============================================================================

describe('AI credential addresses', () => {
  it('uses two distinct purposes, which is what domain-separates the scopes', () => {
    // A ciphertext lifted from one scope into the other fails GCM
    // authentication rather than decrypting into a context where it means
    // something else. That guarantee is exactly this inequality.
    expect(AI_SYSTEM_CREDENTIAL_PURPOSE).not.toBe(AI_USER_CREDENTIAL_PURPOSE);
  });

  it('pins the address strings', () => {
    // Pinned deliberately: a drive-by "tidy up" of either string is
    // unrecoverable data loss for every stored key, so it should fail here
    // rather than in production.
    expect(AI_SYSTEM_CREDENTIAL_PURPOSE).toBe('ai');
    expect(AI_SYSTEM_CREDENTIAL_NAME).toBe('openai');
    expect(AI_USER_CREDENTIAL_PURPOSE).toBe('ai-user');
  });

  it('carries no whitespace, which CredentialsService rejects', () => {
    for (const value of [
      AI_SYSTEM_CREDENTIAL_PURPOSE,
      AI_SYSTEM_CREDENTIAL_NAME,
      AI_USER_CREDENTIAL_PURPOSE,
    ]) {
      expect(value).toBe(value.trim());
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe('aiUserCredentialName', () => {
  it('addresses a per-user key by the user id', () => {
    expect(aiUserCredentialName('3f1b0c4e-0000-4000-8000-000000000001')).toBe(
      '3f1b0c4e-0000-4000-8000-000000000001',
    );
  });

  it('produces a value CredentialsService.assertIdentifier accepts', () => {
    // Non-empty and untrimmed-equal — the two conditions that service checks.
    const name = aiUserCredentialName('user-1');
    expect(name.length).toBeGreaterThan(0);
    expect(name).toBe(name.trim());
  });

  it('rejects an empty user id', () => {
    expect(() => aiUserCredentialName('')).toThrow(/non-empty user id/);
  });

  it('rejects a user id with surrounding whitespace', () => {
    // Rejected rather than trimmed: a silently trimmed address is a row that
    // saves and can never be read back, because the two spellings derive two
    // different sub-keys.
    expect(() => aiUserCredentialName(' user-1 ')).toThrow(/whitespace/);
    expect(() => aiUserCredentialName('user-1\n')).toThrow(/whitespace/);
  });
});
