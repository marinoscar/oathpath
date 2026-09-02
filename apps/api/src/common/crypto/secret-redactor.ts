// =============================================================================
// SecretRedactor — scrub a credential out of an error we did not author
// (issue #122, epic #109; moved here by #28, epic #25)
// =============================================================================
//
// WHY THIS MOVED OUT OF `email/base-email.provider.ts`:
//
// Epic #25 adds AI providers that hold an OpenAI API key across an SDK call
// which builds its own error text. That is the same problem this class already
// solved for nodemailer and the AWS SDK, and its behaviour was never
// email-specific — only its location was. `BaseAiProvider` needs it, and an
// `ai/` module importing from `email/base-email.provider` to get it would say
// something untrue about the dependency.
//
// So it lives in `common/crypto/`, next to the cipher whose plaintext it
// exists to keep out of logs, and the email module RE-EXPORTS it so
// `SecretRedactor` remains importable from exactly where #122 put it. The
// `../email` barrel is unchanged, and no email call site moved.
//
// THIS IS A MOVE, NOT A FORK. Two copies of the one thing standing between a
// provider error and a leaked key is not a trade worth making; the same
// argument `email/smtp-credential.constants.ts` makes for its own move.
//
// THIS MODULE MUST NOT LOG, for the same reason `secret-cipher.ts` must not:
// every value passing through it is a secret or an error that may contain one.
// =============================================================================

/**
 * Shortest secret we will redact by substring.
 *
 * Below this a secret is indistinguishable from ordinary words in an error
 * ("smtp", "true"), and blanket-replacing it would corrupt the message into
 * uselessness while still not proving the secret is gone. Under the floor we
 * take the other branch — see {@link SecretRedactor.apply}.
 */
const MIN_REDACTABLE_SECRET_LENGTH = 4;

/**
 * Collects the secrets in play during one send so that ANY error raised
 * afterwards can be scrubbed before it is logged or returned.
 *
 * WHY THIS EXISTS RATHER THAN "just don't put the password in the error":
 * we do not write most of these errors. nodemailer builds its own error text,
 * and an SMTP server's rejection is echoed back to us verbatim; a server that
 * quotes the offending AUTH line, or a transport bug that stringifies its own
 * options, would put the password into a string we then hand to an admin
 * screen (#124) and a database row (#125). Registering the secret the moment
 * we hold it means the scrub happens even for errors from code we do not own.
 *
 * The plaintext lives in this object for the duration of one send. That is the
 * same lifetime the transport itself needs it for, so it adds no new exposure
 * window; it is dropped when the send returns.
 */
export class SecretRedactor {
  private readonly secrets: string[] = [];

  /**
   * Register a value that must never appear in an error string.
   *
   * Call this at the instant the secret is obtained — BEFORE the code that
   * might throw while holding it, not in the failure path, where a throw
   * would have skipped it.
   */
  protect(secret: string | null | undefined): void {
    if (typeof secret === 'string' && secret.length > 0) {
      this.secrets.push(secret);
    }
  }

  /**
   * Scrub every registered secret out of `text`.
   *
   * Long secrets are replaced in place, keeping the rest of the message —
   * which is the whole point of showing the provider's real error. A secret
   * too short to replace safely (see {@link MIN_REDACTABLE_SECRET_LENGTH})
   * costs the caller the entire message instead: an unreadable error is a bad
   * outcome, a leaked password is a worse one, and the choice is not close.
   */
  apply(text: string): string {
    let out = text;

    for (const secret of this.secrets) {
      if (!out.includes(secret)) continue;

      if (secret.length < MIN_REDACTABLE_SECRET_LENGTH) {
        return '[error withheld: it contained the configured credential]';
      }

      out = out.split(secret).join('[redacted]');
    }

    return out;
  }
}

/**
 * The maximum length of a provider error string we will return or log.
 *
 * AWS SDK errors can carry a serialised response body; an SMTP server can
 * answer with an arbitrarily long banner; an OpenAI error can quote a request
 * payload. This text is rendered in an admin dialog and stored in a delivery
 * record, so it is capped at something a human can actually read.
 *
 * SHARED by `BaseEmailProvider` and `BaseAiProvider` (#28, epic #25) rather
 * than declared twice: two caps that drift apart mean one surface silently
 * truncating differently from the other, with nothing to notice it.
 */
export const MAX_PROVIDER_ERROR_LENGTH = 2000;

/**
 * Cap `text`, marking the cut so a reader knows the message continues.
 *
 * Separate from {@link SecretRedactor.apply} because the two do different
 * jobs: redaction is a security guarantee, truncation is a readability bound.
 * Callers apply redaction FIRST — truncating a string before scrubbing it
 * could cut a secret in half and leave the tail intact.
 */
export function truncateProviderError(text: string): string {
  return text.length > MAX_PROVIDER_ERROR_LENGTH
    ? `${text.slice(0, MAX_PROVIDER_ERROR_LENGTH)}… (truncated)`
    : text;
}
