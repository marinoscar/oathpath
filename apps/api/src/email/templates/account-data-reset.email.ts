import { APP_NAME, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Your data was reset" template — `account.data_reset` (issue #270)
// =============================================================================
//
// THE OTHER SECURITY MESSAGE, alongside `role-changed.email.ts` — the only
// other template whose event carries `mandatory: true` in the registry. Both
// exist because the fact they report is one a reader must not be able to
// miss for the same underlying reason: an irreversible change to the account
// happened, and if the reader did not make it themselves, that is the moment
// they most need to hear about it.
//
// Modeled on `role-changed.email.ts` end to end — same layout calls, same
// "state the delta / do not name the actor / give the safety-net line"
// shape — with the differences that shape forces:
//
// -----------------------------------------------------------------------------
// 1. THERE IS NO "BEFORE AND AFTER" TABLE, BECAUSE THERE IS NO "AFTER" TO SHOW
// -----------------------------------------------------------------------------
//
// `role-changed.email.ts` shows two role lists because the interesting fact
// is the delta between them. A data reset has no comparably compact "after"
// — the after-state is "empty" for a dozen-odd tables — so this template
// states in PLAIN LANGUAGE what was erased and what was kept instead of
// rendering a table of database table names nobody outside this codebase
// would recognize.
//
// -----------------------------------------------------------------------------
// 2. THE ACTOR IS NOT NAMED, FOR A STRONGER REASON THAN `role-changed.email.ts`
// GIVES
// -----------------------------------------------------------------------------
//
// `role-changed.email.ts` omits the administrator's identity because naming
// them buys nothing operationally. Here there usually is no OTHER actor to
// name: `POST /api/account/reset` is `@Auth()` with no permissions, resolved
// entirely from `@CurrentUser('id')` — the caller can only ever erase their
// OWN data (see `account.controller.ts`'s header). So "who did this" is
// almost always "you, moments ago" and restating it would be noise. It stays
// unnamed anyway, matching the sibling template, because the one case this
// message actually needs to alert on is the case where "you" is wrong — a
// compromised session acting without the real owner's knowledge — and that
// is exactly the reader this copy's closing line is written for.
//
// -----------------------------------------------------------------------------
// 3. NO "SIGN OUT AND BACK IN TO APPLY IT" LINE
// -----------------------------------------------------------------------------
//
// `role-changed.email.ts` has to explain a real delay (claims live in the
// access token until it is refreshed). A data reset has no equivalent lag —
// the rows are gone the moment the request returns — so there is nothing
// here to explain away.
// =============================================================================

/**
 * Everything the data-reset message renders.
 *
 * NO CLOCK READ HERE, per the rule stated on `TestEmailData`: `resetAt` is
 * passed in by the caller rather than computed with `new Date()`, so this
 * stays a pure function of its input and "what did we actually tell them"
 * stays answerable after the fact — the same reason `changedAt` is a
 * parameter on `RoleChangedEmailData`.
 */
export interface AccountDataResetEmailData {
  /** The account whose data was erased. */
  recipientEmail: string;

  /**
   * Which destructive scope ran — see `ACCOUNT_RESET_PHRASES`.
   *
   * `data` erases learning history and keeps the stored AI key; `data_and_key`
   * erases both. This is the one fact that changes what the "what was kept"
   * paragraph below says, so it drives the copy rather than being reported
   * as a raw enum value.
   */
  scope: 'data' | 'data_and_key';

  /** When the reset ran. Rendered in UTC; see `formatTimestamp`. */
  resetAt: Date;

  /**
   * Absolute URL of the application root, for the CTA. Optional, as
   * everywhere else: with no `APP_URL` configured the layout omits the
   * button rather than rendering one that goes nowhere.
   */
  appUrl?: string;
}

/**
 * ISO 8601, in UTC, with the `Z` left on — the same choice, for the same
 * reason, as `role-changed.email.ts`: this timestamp's job is to be matched
 * against an `audit_events` row or a support conversation, both of which are
 * UTC.
 */
function formatTimestamp(value: Date): string {
  return value.toISOString();
}

/**
 * What was kept, as a reader-facing sentence — the one line that actually
 * differs between the two scopes.
 */
function keptSentence(scope: 'data' | 'data_and_key'): string {
  if (scope === 'data_and_key') {
    return 'Your sign-in itself was kept — you can sign in and start over any time.';
  }

  return 'Your sign-in and your saved AI key were both kept — you can sign in and start over any time, with nothing to reconfigure on the AI side.';
}

/**
 * Render the data-reset message.
 */
export function accountDataResetEmail(
  data: AccountDataResetEmailData,
): RenderedEmail {
  const timestamp = formatTimestamp(data.resetAt);
  const kept = keptSentence(data.scope);

  const subject = `Your data on ${APP_NAME} was reset`;

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      All of your ${APP_NAME} data was erased from your account
      (<strong>${data.recipientEmail}</strong>) at
      <strong>${timestamp}</strong>. This cannot be undone.
    </p>
    <p style="margin:0 0 16px 0;">
      What was erased: your practice and mock interview history, your
      readiness and progress record, your reading and writing attempts, your
      recorded AI usage, and your saved app settings.
    </p>
    <p style="margin:0 0 16px 0;">${kept}</p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      If you did not do this, contact an administrator now. This notification
      cannot be turned off, because an erasure of everything you have built
      here should never be silent.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Your data was reset',
    previewText: `Erased at ${timestamp}. This cannot be undone.`,
    bodyHtml,
    ctaLabel: data.appUrl ? `Open ${APP_NAME}` : undefined,
    ctaUrl: data.appUrl,
  });

  const text = plainText({
    title: 'Your data was reset',
    lines: [
      `All of your ${APP_NAME} data was erased from your account (${data.recipientEmail})`,
      `at ${timestamp}. This cannot be undone.`,
      '',
      'What was erased: your practice and mock interview history, your readiness and',
      'progress record, your reading and writing attempts, your recorded AI usage, and',
      'your saved app settings.',
      '',
      kept,
      '',
      'If you did not do this, contact an administrator now. This notification cannot be',
      'turned off, because an erasure of everything you have built here should never be silent.',
    ],
    ctaLabel: data.appUrl ? `Open ${APP_NAME}` : undefined,
    ctaUrl: data.appUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}
