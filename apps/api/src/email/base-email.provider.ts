import type { Logger } from '@nestjs/common';

import {
  SecretRedactor,
  truncateProviderError,
} from '../common/crypto/secret-redactor';

import type { EmailMessage, EmailSendResult } from './email.types';
import type { EmailProvider } from './providers/email-provider.interface';

// =============================================================================
// BaseEmailProvider — the never-throw guarantee, implemented once (issue #122)
// =============================================================================
//
// `EmailProvider.send` must never throw (see email-provider.interface.ts for
// the argument). A comment saying so is not a guarantee: the SES and SMTP
// providers each do configuration lookups, a decrypt, a DNS resolution, a TCP
// connect, a TLS handshake and an SDK call, and any of them can throw or
// reject. One `try` block that someone later narrows to "just the send call"
// while refactoring is all it takes.
//
// So `send` is implemented HERE, once, `final` by convention, and subclasses
// implement `deliver` instead. A provider subclass contains no try/catch at
// all and has no `send` to get wrong; the entire never-throw contract is this
// one method, in a file whose only job is that method.
//
// The catch is deliberately bare `catch` over EVERYTHING — not
// `catch (e: Error)`, not a filtered rethrow. There is no error class from
// which the right answer is "let it propagate": a bug in nodemailer and an
// unverified SES sender are the same thing to a caller in the middle of a role
// change, namely "no email went out".
// =============================================================================

/**
 * Re-exported for path stability.
 *
 * `SecretRedactor` now lives in `common/crypto/secret-redactor.ts` (moved by
 * #28, epic #25, because the AI providers need the identical guarantee and an
 * `ai/` module importing from this file would misdescribe the dependency).
 * Every existing import path — this file, `../email` — still resolves, and no
 * email call site moved.
 */
export { SecretRedactor };

/**
 * Base class for every email transport in this app.
 *
 * Subclasses implement {@link deliver}; they do not implement `send` and must
 * not override it.
 */
export abstract class BaseEmailProvider implements EmailProvider {
  /** Subclass's logger, so failures are attributed to the real transport. */
  protected abstract readonly logger: Logger;

  /** Short transport name for log lines and error prefixes: 'SES', 'SMTP'. */
  protected abstract readonly transportName: string;

  /**
   * Do the actual work: resolve configuration, build a client, put the message
   * on the network.
   *
   * MAY THROW FREELY — that is the point. Throwing here is how a subclass
   * reports "this cannot be done", and {@link send} turns it into a result.
   * A subclass therefore needs no try/catch, and adding one only makes the
   * error message worse than what this class already produces.
   *
   * @param redact register any secret obtained here, immediately, so an error
   *               raised later cannot carry it out of the process.
   */
  protected abstract deliver(
    msg: EmailMessage,
    redact: SecretRedactor,
  ): Promise<EmailSendResult>;

  /**
   * Send one message. NEVER throws. Do not override.
   *
   * @see ./providers/email-provider.interface.ts for why this contract exists.
   */
  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const redact = new SecretRedactor();

    try {
      // `await` inside the try, not a returned promise: returning
      // `this.deliver(...)` would resolve the try block before the promise
      // settles, and a rejection would escape this catch entirely. This is
      // the single most likely way for someone to break the contract while
      // "simplifying" this method.
      const result = await this.deliver(msg, redact);

      // Normalise a malformed return. A subclass that falls off the end of a
      // branch yields `undefined`, and a caller reading `.success` on it
      // throws a TypeError one stack frame outside this try — a never-throw
      // violation with this class's name on it. Cheap to rule out here.
      if (!result || typeof result !== 'object') {
        this.logger.error(
          `${this.transportName} provider returned no result object; treating as a failure`,
        );
        return {
          success: false,
          error: `${this.transportName} transport returned no result.`,
        };
      }

      if (result.success) {
        return result;
      }

      // A subclass-authored failure still goes through redaction and
      // truncation, so there is exactly one exit path for error text.
      return {
        success: false,
        error: this.formatError(result.error ?? 'Unknown error.', redact),
      };
    } catch (err) {
      const error = this.formatError(
        err instanceof Error
          ? err.message || err.name
          : typeof err === 'string'
            ? err
            : // Never `JSON.stringify(err)`: a thrown object could be an SDK
              // request context holding the credentials it was built with.
              `Non-Error value of type ${typeof err} thrown.`,
        redact,
      );

      // Body, subject and recipient are absent from this log line on purpose.
      // Bodies carry invitation and password-reset tokens (#123 onwards),
      // subjects carry names, and application logs are shipped, indexed and
      // retained far more widely than mail is. The error and the transport are
      // what makes a misconfiguration diagnosable; the message content adds
      // nothing to that and a great deal to the blast radius of a log leak.
      this.logger.warn(`${this.transportName} send failed: ${error}`);

      return { success: false, error };
    }
  }

  /**
   * Single choke point for every error string this class emits: redact, then
   * truncate, then label with the transport.
   */
  private formatError(raw: string, redact: SecretRedactor): string {
    // Redact FIRST, then truncate. Reversing the two could cut a secret in
    // half and leave the tail intact. The cap itself moved to
    // `common/crypto/secret-redactor.ts` with #28 so `BaseAiProvider` shares
    // it rather than declaring a second 2000 that can drift.
    const truncated = truncateProviderError(redact.apply(raw));

    // Always prefixed with the transport: #124 shows this text with no other
    // context, and "Connection timeout" is a different problem depending on
    // whether it came from SES or from an SMTP host.
    return `${this.transportName}: ${truncated}`;
  }
}
