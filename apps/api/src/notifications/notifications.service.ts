import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { describeThrown } from './describe-thrown';
import { NotificationDeliveryService } from './notification-delivery.service';
import {
  findEvent,
  type NotificationChannel,
  type NotificationEventDef,
} from './notification-events';
import {
  readNotificationPreferences,
  resolveChannels,
} from './notification-preferences';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type ChannelDeliveryResult,
  type NotificationChannelSender,
  type NotificationDispatchContext,
  type NotificationRecipient,
} from './notification.types';

// =============================================================================
// NotificationsService — the dispatcher (issue #125, epic #109)
// =============================================================================
//
// ONE ENTRY POINT: `notify(eventKey, userId, data)`. It resolves the event
// from the registry (#121), resolves the user's per-channel preference, and
// fans out to each enabled channel, recording what happened.
//
// The alternative — emit an event and let each channel subscribe — is more
// decoupled and scatters the preference gate across subscribers, where one of
// them can forget it. `mandatory` is a security gate; there is ONE resolution
// point and ONE gate.
//
// -----------------------------------------------------------------------------
// INLINE, NOT QUEUED — AND THE TRADE-OFF THAT BUYS
// -----------------------------------------------------------------------------
//
// DECISION: dispatch happens in this process, immediately, and is DETACHED
// from the caller. `notify` schedules the work on a later microtask and
// returns; it never awaits a settings read, a render, or a socket to an SMTP
// server.
//
// WHY NOT A QUEUE. A durable queue (BullMQ + Redis, or a `jobs` table with a
// poller) is real machinery: a broker or a table, a worker process, its own
// deployment unit, its own failure modes, its own dashboard. This baseline has
// none of that anywhere — no Redis, no background worker, no job table — and
// introducing the first one to send three emails puts the ops cost of a job
// system into an epic about notifications. #125 says as much.
//
// WHY NOT PLAIN INLINE-AND-AWAITED. Because then a slow SMTP server is a slow
// request: the admin who changed a user's roles waits on the mail server
// before their PATCH returns, and a hung connection holds a Fastify request
// open for the transport's full timeout. The action and its notification have
// no reason to share a latency budget.
//
// THE TRADE-OFF ACCEPTED, STATED PLAINLY: there is NO DURABILITY AND NO RETRY.
// If this process dies between the schedule and the send — a deploy, an OOM
// kill, a crash — that notification is gone and nothing will try again. Two
// things bound the damage, and neither eliminates it:
//
//   * The `queued` delivery row is written BEFORE the attempt (see
//     notification-delivery.service.ts), so a lost send leaves evidence: a row
//     stuck at `queued`, findable through an index built for that query. The
//     notification is lost; the KNOWLEDGE that it was lost is not.
//   * `onModuleDestroy` drains in-flight dispatches, so an ORDERLY shutdown
//     (the common case — a rolling deploy, `docker compose down`) finishes
//     what it started instead of dropping it.
//
// There is also no backpressure: a burst of events becomes a burst of
// concurrent sends. Acceptable at this baseline's scale — notifications here
// are triggered by human actions, not by a firehose — and it is the first
// thing to revisit if that changes. When a queue is eventually justified, the
// seam is `schedule()` below and nothing above it moves.
//
// -----------------------------------------------------------------------------
// HOW `notify` IS GUARANTEED NOT TO THROW
// -----------------------------------------------------------------------------
//
// Structurally, not by inspection. `notify` itself does exactly two things
// that could fail — a synchronous map lookup, and handing a closure to
// `schedule` — and `schedule` attaches a `.catch()` before the promise can
// reject. Every layer below it is separately defensive: the channel contract
// returns failures instead of throwing, the delivery service swallows its own
// database errors, and `deliverOne` wraps every channel call in a `try`/`catch`
// regardless. The point of the redundancy is that the guarantee must survive a
// channel added by somebody who did not read the contract.
//
// It also never participates in the caller's transaction: the dispatch runs
// after the caller's turn ends, on this service's own `PrismaService` calls,
// outside any `$transaction` the caller may be holding. A notification cannot
// roll back a role change, and a role change's rollback cannot un-send mail.
// =============================================================================

/**
 * How long an orderly shutdown waits for in-flight dispatches.
 *
 * BOUNDED, because the thing being waited on is a network call to a mail
 * server: an unbounded drain lets one hung SMTP connection hold a container in
 * `stopping` until the orchestrator SIGKILLs it, which loses the same work
 * AND makes the deploy slow. Five seconds is enough for a send already in
 * flight and short enough to stay well inside a typical 10s stop grace period.
 */
const SHUTDOWN_DRAIN_MS = 5_000;

@Injectable()
export class NotificationsService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Channel -> sender, built once from whatever the module registered.
   *
   * A Map rather than a `switch` or a chain of `if`s: the dispatcher iterates
   * the channels the event and the user's preferences agree on, and asks this
   * for each. A channel the registry declares but nothing implements —
   * `browser`, until #127 — is simply absent, and absent is handled in one
   * place.
   */
  private readonly senders: Map<NotificationChannel, NotificationChannelSender>;

  /**
   * Dispatches that have been scheduled and have not finished.
   *
   * Tracked ONLY so shutdown can drain them (and so tests can await them —
   * see {@link flush}). Nothing reads it to make a delivery decision.
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveries: NotificationDeliveryService,
    @Inject(NOTIFICATION_CHANNEL_SENDERS)
    senders: NotificationChannelSender[],
  ) {
    this.senders = new Map();

    for (const sender of senders) {
      if (this.senders.has(sender.channel)) {
        // FAIL AT BOOT, LOUDLY. Two senders claiming one channel means the
        // second silently shadows the first, and the symptom is "some
        // notifications go out over the wrong transport", which is close to
        // undiagnosable from a delivery record. This is the one place in this
        // file that is allowed to throw: it runs at module construction, not
        // on a business action, and a misconfigured graph should not start.
        throw new Error(
          `Duplicate notification channel sender registered for '${sender.channel}'.`,
        );
      }

      this.senders.set(sender.channel, sender);
    }
  }

  /**
   * Raise a notification for one user.
   *
   * THE ONLY PUBLIC ENTRY POINT, and deliberately the whole API: a call site
   * needs an event key, a user id and a payload, and nothing about channels,
   * templates, transports or preferences. That is what makes "adding a
   * notification costs one registry entry" (epic #109) true at the call site
   * as well as in the registry.
   *
   * RETURNS AS SOON AS THE WORK IS SCHEDULED. The returned promise resolves
   * before anything is rendered or sent — see the header. Awaiting it is
   * correct and cheap; it just does not mean "delivered". Callers that need to
   * know what happened read `notification_deliveries`.
   *
   * NEVER REJECTS. Not for a database failure, not for a mail server, not for
   * a template bug, not for an event key that does not exist.
   *
   * @param eventKey a key from `NOTIFICATION_EVENTS`. An UNKNOWN KEY IS A
   *        NO-OP THAT RECORDS NOTHING — not a throw, and not a delivery row.
   *        Both matter: a throw would fail the action that raised the stale
   *        event (the exact coupling this issue exists to prevent), and a row
   *        for a non-existent event would put a key in
   *        `notification_deliveries` that no registry entry explains, poisoning
   *        the table that answers "what did we send?".
   * @param userId the recipient's account.
   * @param data the event's payload, passed to the channel's template
   *        untouched. Never logged.
   */
  async notify(eventKey: string, userId: string, data: unknown): Promise<void> {
    const event = findEvent(eventKey);

    if (!event) {
      // `debug`, not `warn`: the overwhelmingly likely cause is a key that
      // was legitimately retired, raised by a code path nobody updated, and
      // an unknown event is defined to be harmless. A `warn` here would train
      // operators to ignore this logger.
      this.logger.debug(
        `Ignoring notification for unknown event '${eventKey}'.`,
      );
      return;
    }

    this.schedule(() =>
      this.dispatchToUser(event, userId, data),
    );
  }

  /**
   * Raise a notification for an EMAIL ADDRESS THAT MAY HAVE NO ACCOUNT.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS EXISTS AT ALL (#128, and the design problem of that issue)
   * ---------------------------------------------------------------------------
   *
   * `allowlist.invitation` is sent to somebody an administrator has just
   * authorised to sign in. By definition they have no user row, no
   * `user_settings` row and no open tab — that is what being newly allowlisted
   * MEANS — so `notify(eventKey, userId, data)` has nothing to pass as
   * `userId`, and there are no stored preferences to resolve.
   *
   * Two ways to handle that were on the table:
   *
   *   1. **REJECTED — let the event bypass preference resolution.** A flag on
   *      the registry entry, or a branch in `dispatch`, saying "this one skips
   *      the gate". That puts a documented hole in the ONE place the
   *      `mandatory` override and the sparse absent-key contract are enforced,
   *      and the hole is selected by a string. Every future event is then one
   *      copied line away from silently opting out of preferences for
   *      recipients who DO have them. The gate is only a gate if there is no
   *      way around it.
   *
   *   2. **CHOSEN — a second way to BUILD a recipient, feeding the same gate.**
   *      This method resolves a `NotificationRecipient` and hands it to the
   *      identical `dispatch`. Nothing about resolution changes: preferences
   *      are still read, `resolveChannels` still runs, `mandatory` still
   *      overrides. For a recipient with no account the preferences are simply
   *      empty — and empty resolves to the registry's `defaultEnabled`, which
   *      is the correct answer for somebody who has never had a settings row
   *      to express an opinion in. That is not a bypass; it is the sparse
   *      contract's own definition of "absent".
   *
   * ---------------------------------------------------------------------------
   * AND IT LOOKS THE ADDRESS UP FIRST, WHICH IS THE PART THAT MATTERS
   * ---------------------------------------------------------------------------
   *
   * The danger in (2) is not the no-account case, which has no preferences to
   * ignore. It is the case where the address TURNS OUT to belong to an
   * account: an admin re-adds an address that already has a user (the initial
   * admin bypasses the allowlist entirely and can be allowlisted afterwards;
   * an entry can be removed and added again). Dispatching that as an
   * account-less recipient would deliver to a real user while ignoring the
   * preferences they actually set — exactly the weakening #128 forbids.
   *
   * So this looks the address up, and if it resolves to an account it hands
   * off to the ordinary user path. Preference resolution is therefore never
   * skipped for anybody who has preferences. The cost is one indexed query on
   * a path that is already detached from the caller.
   *
   * NEVER REJECTS, and never joins the caller's transaction — same guarantees
   * as {@link notify}, by the same mechanism (`schedule`).
   *
   * @param eventKey a key from `NOTIFICATION_EVENTS`. Unknown is a no-op.
   * @param email the recipient's address. Matched case-insensitively, because
   *        the allowlist stores addresses lower-cased while `users.email`
   *        holds whatever the OAuth provider returned.
   * @param data the event's payload, passed to the template untouched.
   */
  async notifyAddress(
    eventKey: string,
    email: string,
    data: unknown,
  ): Promise<void> {
    const event = findEvent(eventKey);

    if (!event) {
      this.logger.debug(
        `Ignoring notification for unknown event '${eventKey}'.`,
      );
      return;
    }

    this.schedule(() => this.dispatchToAddress(event, email, data));
  }

  /**
   * Wait for every scheduled dispatch to finish.
   *
   * The shutdown drain, and the seam tests use to assert on what a
   * fire-and-forget `notify` eventually did — without it, a test would be
   * reduced to polling or to an arbitrary `setTimeout`, which is how a suite
   * acquires flakes.
   *
   * Loops rather than awaiting the set once, because a dispatch may schedule
   * further work; awaiting a snapshot would return while that work is still
   * running.
   */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /**
   * Finish what has been started, within a bound.
   *
   * Without this, an orderly shutdown drops every in-flight notification —
   * and an orderly shutdown is the COMMON case (a rolling deploy), so the
   * fire-and-forget model would lose notifications routinely rather than only
   * on a crash.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.inFlight.size === 0) return;

    this.logger.log(
      `Draining ${this.inFlight.size} in-flight notification dispatch(es).`,
    );

    let timer: NodeJS.Timeout | undefined;

    // The timer is `unref`'d so it can never be the reason the process stays
    // alive, and cleared in `finally` so a fast drain does not leave a pending
    // handle behind for a test runner to complain about.
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
      timer.unref?.();
    });

    try {
      await Promise.race([this.flush(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (this.inFlight.size > 0) {
      // Their `queued` rows stay `queued`, which is the evidence trail
      // described in notification-delivery.service.ts.
      this.logger.warn(
        `Shutdown drain timed out with ${this.inFlight.size} dispatch(es) ` +
          `unfinished; their delivery records remain 'queued'.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Detach a unit of work from the caller.
   *
   * THE SINGLE PLACE THE INLINE/QUEUED DECISION LIVES. Swapping this body for
   * an enqueue is the entire change if a durable queue is ever justified;
   * `notify` and `dispatchToUser` do not move.
   *
   * `Promise.resolve().then(work)` rather than calling `work()` directly:
   * invoking it here would run its synchronous prefix inside the caller's
   * turn, which is a small lie about "does not block the caller" and a large
   * one if somebody later adds a synchronous statement to the top of
   * `dispatchToUser`. Deferring makes the guarantee independent of what the
   * work happens to do first.
   *
   * The `.catch()` is attached to the promise that is STORED, so there is no
   * window in which an unhandled rejection can escape — this is the mechanism
   * behind `notify`'s never-throws guarantee.
   */
  private schedule(work: () => Promise<void>): void {
    const task = Promise.resolve()
      .then(work)
      .catch((err: unknown) => {
        // Reaching here means something below threw despite every layer being
        // written not to. That is a bug worth an `error`, and it is still
        // contained: the caller returned long ago.
        this.logger.error(
          `Notification dispatch failed unexpectedly: ${describeThrown(err)}`,
        );
      });

    this.inFlight.add(task);
    void task.finally(() => {
      this.inFlight.delete(task);
    });
  }

  /**
   * Resolve the recipient from their account, then dispatch.
   *
   * SPLIT FROM {@link dispatch} so the no-account case (#128's
   * `allowlist.invitation`, where there is no user row and `userId` is null on
   * the delivery record) is a different way of BUILDING a
   * `NotificationRecipient` rather than a second copy of the fan-out, the
   * preference gate and the containment rules.
   */
  private async dispatchToUser(
    event: NotificationEventDef,
    userId: string,
    data: unknown,
  ): Promise<void> {
    const user = await this.loadRecipient(userId);

    if (!user) {
      // No user, no address, no delivery row: `recipient` is NOT NULL and
      // there is nothing truthful to put in it. Logged because a notification
      // raised for a user id that does not exist is a caller bug (or a user
      // deleted between the action and this dispatch — a real race, given the
      // dispatch is detached).
      this.logger.warn(
        `Cannot dispatch '${event.key}': user ${userId} was not found.`,
      );
      return;
    }

    await this.dispatch(event, user, data);
  }

  /**
   * Resolve an email address to a recipient, preferring the account behind it.
   *
   * THE ORDER IS THE SECURITY PROPERTY. The account lookup happens FIRST, and
   * an address with an account is dispatched as that account — with its stored
   * preferences — rather than as an anonymous address. See {@link
   * notifyAddress} for why the reverse would be a hole in the preference gate.
   */
  private async dispatchToAddress(
    event: NotificationEventDef,
    email: string,
    data: unknown,
  ): Promise<void> {
    let existing: { id: string } | null;

    try {
      // `findFirst` with a case-insensitive `equals` rather than `findUnique`:
      // `users.email` is unique but stored with the provider's casing, while
      // the caller's address (an allowlist entry) is lower-cased. A
      // case-sensitive miss here would silently produce the anonymous path for
      // a user who does have preferences, which is the one outcome this lookup
      // exists to prevent.
      existing = await this.prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: { id: true },
      });
    } catch (err) {
      // ABORT, DO NOT FALL BACK. Falling through to the anonymous path here
      // would mean a transient database error downgrades a preference-checked
      // send into an unchecked one — a gate that fails OPEN. Failing closed
      // costs at most one undelivered notification, and the database is also
      // where the delivery record would have gone, so nothing is being
      // silently lost that would otherwise have been recorded.
      this.logger.error(
        `Cannot dispatch '${event.key}': resolving the recipient address ` +
          `failed: ${describeThrown(err)}`,
      );
      return;
    }

    if (existing) {
      // A real account. Ordinary path, ordinary preference resolution.
      await this.dispatchToUser(event, existing.id, data);
      return;
    }

    // Genuinely no account. `preferences: {}` is not a bypass: under the
    // sparse absent-key contract an absent preference resolves to the event's
    // `defaultEnabled`, which is precisely the right answer for somebody who
    // has never had a settings row. `mandatory` still applies, and a channel
    // that cannot reach an account-less recipient — the browser channel, whose
    // `resolveTo` returns the user id — skips itself.
    await this.dispatch(
      event,
      { userId: null, email, preferences: {} },
      data,
    );
  }

  /**
   * Read the recipient's address and preferences in ONE query.
   *
   * The settings blob is read RAW, through `user_settings.value`, and
   * deliberately NOT through `UserSettingsService.getSettings`, for three
   * independent reasons — any one of which would be disqualifying:
   *
   *   1. `getSettings` CREATES A ROW when none exists. A read on a
   *      fire-and-forget send path must not write, and materialising a
   *      settings row as a side effect of sending an email is precisely the
   *      "silently materialises preference blobs" failure #125 warns about.
   *   2. Its response projection lists the namespaces it knows and would drop
   *      `notifications` entirely.
   *   3. `userSettingsSchema.parse` STRIPS unknown keys, so the namespace
   *      would not survive the parse even if the projection kept it. (That
   *      schema is #126's to widen, on the write side; resolution does not
   *      depend on it, which is why preference READING works today with no
   *      change to the settings module.)
   *
   * Returns `null` when there is no such user.
   */
  private async loadRecipient(
    userId: string,
  ): Promise<NotificationRecipient | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        userSettings: { select: { value: true } },
      },
    });

    if (!user) return null;

    // NO `isActive` GATE, DELIBERATELY. Skipping deactivated accounts is a
    // POLICY, it is not stated anywhere in #109/#125, and putting it here
    // would make it a hidden one: `security.role_changed` is mandatory
    // precisely so that a privilege change is never silent, and a silent drop
    // in the dispatcher would defeat that for the accounts an incident review
    // is most likely to care about. If an offboarded mailbox is gone, the send
    // bounces and the delivery record says so — which is a visible answer
    // rather than an invisible one. Whoever raises an event decides whether it
    // applies (#128).
    return {
      userId: user.id,
      email: user.email,
      preferences: readNotificationPreferences(user.userSettings?.value),
    };
  }

  /**
   * Fan one event out to a resolved recipient's enabled channels.
   *
   * Channel-agnostic and recipient-agnostic: this is the method #128's
   * no-account path will call with `{ userId: null, ... }`.
   */
  private async dispatch(
    event: NotificationEventDef,
    recipient: NotificationRecipient,
    data: unknown,
  ): Promise<void> {
    // THE GATE. `resolveChannels` applies the sparse absent-key contract and
    // the `mandatory` override; nothing else in this file consults a
    // preference. One resolution point, one gate.
    const channels = resolveChannels(event, recipient.preferences);

    if (channels.length === 0) {
      // Every channel muted. No rows: nothing was attempted, and recording a
      // "we did not try" row per muted event would fill the table with the
      // absence of activity.
      this.logger.debug(
        `'${event.key}' is disabled on every channel for user ` +
          `${recipient.userId ?? '(no account)'}.`,
      );
      return;
    }

    const context: NotificationDispatchContext = { event, recipient, data };

    // SEQUENTIAL, not `Promise.all`. Two channels at most today, so there is
    // no latency worth parallelising for, and sequencing keeps the log lines
    // for one notification adjacent and ordered — which matters when the
    // question being answered is "what happened to this one event?". Failure
    // containment does not depend on it either way: each iteration is
    // independently wrapped below.
    for (const channel of channels) {
      await this.deliverOne(context, channel);
    }
  }

  /**
   * One (event, recipient, channel) attempt, with its delivery record.
   *
   * EVERY EXIT FROM THIS METHOD IS NORMAL. It has no throwing path, so one
   * channel's failure can never prevent the next channel's attempt.
   */
  private async deliverOne(
    context: NotificationDispatchContext,
    channel: NotificationChannel,
  ): Promise<void> {
    const { event, recipient } = context;
    const sender = this.senders.get(channel);

    if (!sender) {
      // A channel the registry declares with no transport implemented —
      // `browser` on `security.role_changed`, until #127. NO DELIVERY ROW, and
      // `debug` not `warn`: this is the documented, expected state
      // (notification-events.ts: "declaring a channel before its
      // implementation lands is safe — it simply has nowhere to go"). A failed
      // row per event would fill the table with a known, deliberate gap and
      // bury the real failures an operator is looking for.
      this.logger.debug(
        `No transport registered for channel '${channel}'; ` +
          `skipping '${event.key}'.`,
      );
      return;
    }

    const to = sender.resolveTo(recipient);

    if (!to) {
      // The channel cannot reach this recipient at all. Still no row:
      // `NotificationDelivery.recipient` is NOT NULL and exists to answer
      // "where did this go?", so filling it with a placeholder to record a
      // non-attempt corrupts the one column that must stay literal.
      this.logger.warn(
        `No '${channel}' address for user ${recipient.userId ?? '(no account)'}; ` +
          `skipping '${event.key}'.`,
      );
      return;
    }

    // Written BEFORE the attempt. See notification-delivery.service.ts for why
    // the extra write is worth it. `null` means the row could not be written;
    // the send proceeds anyway and the mark* calls below become no-ops.
    const deliveryId = await this.deliveries.queue({
      eventKey: event.key,
      userId: recipient.userId,
      recipient: to,
      channel,
    });

    // Declared with its type rather than left to inference from the assignment
    // inside the `try`: a bare `let result;` is an evolving `any`, which would
    // silently stop typechecking `result.messageId` below.
    let result: ChannelDeliveryResult;

    try {
      result = await sender.deliver(context, to);
    } catch (err) {
      // BELT AND BRACES. `NotificationChannelSender.deliver` is contracted not
      // to throw and today's one implementation does not — but #125's
      // never-throws guarantee has to hold for a channel written later by
      // somebody who did not read that contract, and this is where that is
      // enforced rather than assumed.
      const error = `Channel '${channel}' threw: ${describeThrown(err)}`;
      this.logger.error(`Delivery of '${event.key}' failed: ${error}`);
      await this.deliveries.markFailed(deliveryId, error);
      return;
    }

    if (!result.success) {
      const error =
        result.error ?? `Channel '${channel}' reported a failure with no message.`;

      // `warn`, not `error`: a refused send is usually an operator-side
      // configuration or mailbox problem, not a fault in this service. The
      // event key and channel are here; the address, the subject and the body
      // are not — they belong in the delivery record, which is the controlled
      // place for them.
      this.logger.warn(
        `Delivery of '${event.key}' over '${channel}' failed: ${error}`,
      );

      await this.deliveries.markFailed(deliveryId, error);
      return;
    }

    await this.deliveries.markSent(deliveryId, result.messageId);
  }
}
