import type {
  NotificationChannel,
  NotificationEventDef,
} from './notification-events';
import type { NotificationPreferences } from './notification-preferences';

// =============================================================================
// Dispatch types (issue #125, epic #109)
// =============================================================================
//
// The wire format between the dispatcher and a channel, mirroring the split
// `../email/email.types.ts` makes one layer down: free of Nest and Prisma, so
// a channel test can build a context and assert on a result without standing
// up DI.
// =============================================================================

/**
 * Who a notification is going to, resolved once per dispatch.
 *
 * -----------------------------------------------------------------------------
 * `userId` IS NULLABLE, AND THAT IS THE POINT OF THIS TYPE EXISTING AT ALL
 * -----------------------------------------------------------------------------
 *
 * `notify(eventKey, userId, data)` always has a user. `allowlist.invitation`
 * (#121, wired by #128) does not: it is sent to an email address that has no
 * account yet — that is what being newly allowlisted means — and
 * `NotificationDelivery.userId` is nullable in the schema for exactly this
 * case.
 *
 * Rather than give that case its own parallel dispatch path (which is how the
 * preference gate, the delivery record and the failure containment end up
 * implemented twice, and differently), everything below the public `notify`
 * method takes THIS shape. The no-account case is then a different way of
 * BUILDING one — `{ userId: null, email, preferences: {} }` — and empty
 * preferences resolve to the registry defaults, which is the correct answer
 * for somebody who has never had a settings row to express a preference in.
 *
 * #125 deliberately ships no public method for it: an unused entry point is
 * speculative surface. The seam is here so #128 adds one without a rewrite.
 */
export interface NotificationRecipient {
  /** The account, or `null` for a recipient with no account (#128). */
  userId: string | null;

  /**
   * Destination email address, or `null` when this recipient has none.
   *
   * A CHANNEL-SPECIFIC handle, on a type that is otherwise channel-agnostic.
   * The alternative — a `Record<NotificationChannel, string>` — is
   * speculative generality for one entry, and it would force every caller to
   * invent a browser "address" before #127 has decided what one is. When that
   * lands and needs a second handle, it is a field here and a `resolveTo` in
   * one channel class; nothing else moves.
   */
  email: string | null;

  /**
   * The user's stored preferences, already read out of `user_settings`.
   *
   * Read ONCE per dispatch and passed down, not re-read per channel: a
   * three-channel event would otherwise make three identical queries, and
   * worse, two channels could resolve against different snapshots if the user
   * saved a preference mid-dispatch.
   */
  preferences: NotificationPreferences;
}

/**
 * Everything a channel needs to render and deliver one notification.
 */
export interface NotificationDispatchContext {
  /** The resolved registry entry. Never a bare string — the lookup already happened. */
  event: NotificationEventDef;

  recipient: NotificationRecipient;

  /**
   * The event's payload, exactly as the caller passed it to `notify`.
   *
   * `unknown`, NOT `any` and not a per-event generic. It crosses this boundary
   * untyped because `notify`'s signature is untyped by design (#125): one
   * entry point for every event, callable from anywhere, with no import of a
   * per-event payload type at the call site.
   *
   * The cost is real and is paid in exactly one place: the channel that
   * renders it. See `email-notification.channel.ts`, which treats a render
   * throw as a recorded delivery failure rather than trusting the shape.
   */
  data: unknown;
}

/**
 * The outcome of one channel's attempt at one delivery.
 *
 * Deliberately the same shape as `EmailSendResult` (../email/email.types.ts):
 * a channel reports failure by RETURNING it, never by throwing, and the fields
 * map one-to-one onto the `NotificationDelivery` columns
 * (`providerMessageId`, `error`) so nothing has to be reinterpreted on the way
 * to the row.
 */
export interface ChannelDeliveryResult {
  success: boolean;

  /** Transport-assigned id, on success. Recorded on the delivery row. */
  messageId?: string;

  /**
   * Human-readable failure text, on failure. Recorded on the delivery row.
   *
   * MUST NOT CARRY A SECRET OR A MESSAGE BODY. This string is persisted and
   * will be read by an operator triaging failures. Email provider errors have
   * already been through `SecretRedactor` and the length cap in
   * `BaseEmailProvider.formatError`, which is the single exit path for
   * provider error text; anything authored here must hold itself to the same
   * rule.
   */
  error?: string;
}

/**
 * A transport the dispatcher can fan an event out to.
 *
 * ADDING A CHANNEL IS: one class implementing this, and one line in
 * `notifications.module.ts`'s channel factory. Nothing in
 * `NotificationsService` changes — it iterates whatever is registered. That is
 * the whole reason this interface exists rather than the dispatcher calling
 * the email provider directly; #127 adds `browser` and #109 reserves `push`.
 *
 * NO BROWSER STUB SHIPS WITH #125. An empty implementation would be a channel
 * that resolves as enabled, records a delivery row and delivers nothing —
 * worse than the honest current state, where an unregistered channel is
 * skipped and says so in a debug log.
 */
export interface NotificationChannelSender {
  /**
   * Which channel this is. Used as the registry key, so it must be unique
   * across registered senders — `NotificationsService` refuses to start if two
   * senders claim the same channel, because the second would silently shadow
   * the first.
   */
  readonly channel: NotificationChannel;

  /**
   * The address or handle this channel would deliver to, or `null` when it
   * cannot reach this recipient at all.
   *
   * SEPARATE FROM `deliver` because `NotificationDelivery.recipient` is NOT
   * NULL and the row is written as `queued` BEFORE the attempt (see
   * `notification-delivery.service.ts`). The dispatcher therefore has to know
   * the destination before it has a result. Returning `null` means "skip me" —
   * no row, no attempt — rather than forcing a placeholder into the one column
   * that answers "where did this actually go?".
   */
  resolveTo(recipient: NotificationRecipient): string | null;

  /**
   * Attempt one delivery.
   *
   * SHOULD NOT THROW — failures come back as `{ success: false, error }`, the
   * same contract `EmailProvider.send` carries one layer down.
   *
   * The dispatcher does not TRUST that, and wraps every call in a try/catch
   * anyway. Not because the contract is in doubt for today's one
   * implementation, but because #125's own guarantee — `notify` never throws
   * to its caller — must survive a channel added later by somebody who did
   * not read this comment. A guarantee that depends on every future
   * implementer being careful is not a guarantee.
   *
   * @param to the destination from {@link resolveTo}, passed in rather than
   *           re-derived so the row's `recipient` and the actual send can
   *           never disagree.
   */
  deliver(
    context: NotificationDispatchContext,
    to: string,
  ): Promise<ChannelDeliveryResult>;
}

/**
 * DI token for the set of registered channels.
 *
 * An injected ARRAY rather than each channel being a constructor parameter of
 * `NotificationsService`: adding `browser` must not edit the dispatcher, and a
 * constructor parameter would. The array is assembled in
 * `notifications.module.ts`, which is the one file where "what transports
 * exist" is a legitimate question.
 */
export const NOTIFICATION_CHANNEL_SENDERS = 'NOTIFICATION_CHANNEL_SENDERS';
