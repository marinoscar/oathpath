import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AiUserKeyService } from '../ai/ai-user-key.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { AccountDataResetEmailData } from '../email';
import {
  ACCOUNT_RESET_PHRASES,
  ACCOUNT_RESET_TABLES,
  type AccountResetScope,
} from './account-reset.constants';
import type { AccountDataSummary } from './dto/account-data-summary.dto';
import type { AccountResetResult } from './dto/account-reset-result.dto';

/**
 * The `storage_objects` key both `AccountDataSummaryDto.counts` and
 * `AccountResetResultDto.deleted` carry, alongside — but never inside —
 * `ACCOUNT_RESET_TABLES`. See that constant's own header comment for why
 * storage objects are counted and deleted through a completely different
 * path (`ObjectsService`, not `tx.<model>.deleteMany`) from every other
 * table this feature touches.
 */
const STORAGE_OBJECTS_TABLE = 'storage_objects';

/**
 * The narrow slice of a Prisma model delegate `ACCOUNT_RESET_TABLES` needs:
 * a per-user `count` and a per-user `deleteMany`. Every entry in that
 * constant names a model that satisfies this — `PracticeAttempt.userId`
 * through `UserSettings.userId` are all real, indexed columns — so this
 * interface is a STRUCTURAL PROMISE about that constant's contents, not a
 * separate thing that could drift from it silently: if a future entry named
 * a model with no `userId` field, the `deleteMany({ where: { userId } })`
 * call below would fail to COMPILE the moment `delegateFor`'s result is
 * used, which is why this stays a real interface instead of `unknown`.
 */
interface UserScopedDelegate {
  count(args: { where: { userId: string } }): Promise<number>;
  deleteMany(args: {
    where: { userId: string };
  }): Promise<{ count: number }>;
}

/**
 * Resolve one `ACCOUNT_RESET_TABLES` entry's Prisma accessor off whichever
 * client is calling — `this.prisma` itself for a read-only `count`
 * (`summarize`), or the interactive transaction's `tx` for a `deleteMany`
 * (`reset`).
 *
 * `client: unknown` DELIBERATELY, rather than `PrismaService |
 * Prisma.TransactionClient`. Prisma 7's generated interactive-transaction
 * parameter has no exported standalone type this module can name without
 * reaching into generated internals, and typing this narrowly on
 * `PrismaService` alone would refuse the `tx` client `reset` actually needs
 * to pass. The real type safety here is `UserScopedDelegate` on the RETURN
 * side, not on what comes in: every caller of this function already knows
 * (from the constant it iterates) that `entry.model` names a real model with
 * a `userId` column, and the cast below is where that knowledge, which
 * `ACCOUNT_RESET_TABLES`'s own header comment argues for at length, is
 * actually spent.
 */
function delegateFor(client: unknown, model: string): UserScopedDelegate {
  return (client as Record<string, UserScopedDelegate>)[model];
}

// =============================================================================
// AccountResetService — self-service account data reset (issue #270)
// =============================================================================
//
// The "Danger zone" backend: a read-only preview of what a reset would touch
// (`summarize`) and the destructive action itself (`reset`). Every method
// takes a `userId` from the caller and deletes ONLY that user's rows — see
// `account.controller.ts`'s header for the same "no route accepts a user id"
// discipline this application's other per-learner modules already state.
//
// -----------------------------------------------------------------------------
// THIS IS NOT ACCOUNT DELETION
// -----------------------------------------------------------------------------
//
// The `users` row survives every scope this service offers, and so does the
// caller's ability to sign back in immediately afterward. `data_and_key`
// erases the caller's stored AI key too, but the account itself, its OAuth
// identity, its roles, and its sign-in history are untouched. That is a
// deliberate, narrower promise than "delete my account" would make, and it
// is why `refresh_tokens` and `audit_events` are conspicuously absent from
// `ACCOUNT_RESET_TABLES`:
//
//   - `refresh_tokens` are SESSION state, not DATA. This feature is scoped
//     to what a learner has BUILT — practice history, readiness, interview
//     transcripts, settings — not to what devices they happen to be signed
//     in on right now. Deleting them here would silently sign the caller
//     (and every other device they are signed in on) out as a SIDE EFFECT
//     of a data reset, which is a materially different, separately-named
//     action this codebase already has (`POST /api/auth/logout-all`) and
//     which a caller did not ask for by typing "DELETE MY DATA". A learner
//     finishing a reset should land right back on their own dashboard, not
//     be bounced to the sign-in screen.
//
//   - `audit_events` is the OPERATOR'S record, not the user's own data —
//     the identical distinction `NotificationDelivery`'s own schema comment
//     draws against `Notification`: an operator table that must outlive the
//     account it describes, never shown to the user it is about. Deleting
//     it here would be self-defeating in the most literal sense: THIS VERY
//     METHOD writes an `account:reset` row to that table as its own
//     accountability record (step 5 below) — a reset that could erase its
//     own audit trail would let a caller destroy the evidence that a
//     destructive action ever happened, which defeats the reason
//     `audit_events` exists in the first place. It would also erase the
//     history of every OTHER admin action ever taken on this account (role
//     changes, deactivations), which belongs to the administrators who
//     performed them and to nobody's self-service delete button.
// =============================================================================

@Injectable()
export class AccountResetService {
  private readonly logger = new Logger(AccountResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUserKeys: AiUserKeyService,
    private readonly objects: ObjectsService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * What a reset would touch, without touching anything.
   *
   * One `count({ where: { userId } })` per `ACCOUNT_RESET_TABLES` entry, run
   * in parallel, plus a `storage_objects` count keyed the same way the
   * result of `reset` itself is keyed — so the "Danger zone" screen and the
   * confirmation screen that follows it read the identical shape.
   *
   * `mock_interview_turns` and `storage_object_chunks` are NOT counted here,
   * matching `ACCOUNT_RESET_TABLES`'s own omission of them: both cascade
   * from a parent row this method (and `reset`) already accounts for, so a
   * separate count would either double-count the same deletions from the
   * caller's point of view or require the caller to mentally subtract rows
   * nobody asked about.
   */
  async summarize(userId: string): Promise<AccountDataSummary> {
    const counts: Record<string, number> = {};

    await Promise.all(
      ACCOUNT_RESET_TABLES.map(async (entry) => {
        counts[entry.table] = await delegateFor(this.prisma, entry.model).count(
          { where: { userId } },
        );
      }),
    );

    counts[STORAGE_OBJECTS_TABLE] = await this.prisma.storageObject.count({
      where: { uploadedById: userId },
    });

    return { counts, phrases: ACCOUNT_RESET_PHRASES };
  }

  /**
   * Erase this user's own data — and, on `scope: 'data_and_key'`, their own
   * stored AI key too. Irreversible.
   *
   * Six steps, in this exact order, and the order is the load-bearing part:
   *
   *   1. Verify the confirmation phrase. Nothing below runs on a mismatch.
   *   2. Delete storage objects — network I/O, outside any transaction.
   *   3. Delete every `ACCOUNT_RESET_TABLES` row, in one DB transaction.
   *   4. On `data_and_key`, purge the caller's stored AI key.
   *   5. Write the audit event — AFTER destruction, not before or during.
   *   6. Notify the caller by email.
   */
  async reset(
    userId: string,
    scope: AccountResetScope,
    confirmationPhrase: string,
  ): Promise<AccountResetResult> {
    // -------------------------------------------------------------------------
    // 1. THE PHRASE IS CHECKED FIRST, BEFORE A SINGLE ROW IS TOUCHED
    // -------------------------------------------------------------------------
    //
    // See `ACCOUNT_RESET_PHRASES`'s own comment for why this is verified
    // server-side at all. `.trim()` only — never case-insensitive, never
    // fuzzy — because the whole point of a typed phrase is that it proves the
    // caller read and reproduced the exact word "DELETE", and a comparison
    // that forgives a wrong case would prove something weaker than that.
    const expectedPhrase = ACCOUNT_RESET_PHRASES[scope];
    if (confirmationPhrase.trim() !== expectedPhrase) {
      throw new BadRequestException(
        `The confirmation phrase did not match. Type "${expectedPhrase}" exactly to continue.`,
      );
    }

    // The recipient's email is read up front, before anything is deleted,
    // for the account.data_reset notification built in step 6 — the SAME
    // reason `UsersService.updateUserRoles` reads `user.email` before its own
    // transaction rather than after: nothing this method deletes touches the
    // `users` table itself, but reading it late for no reason would be one
    // more place a caller has to convince themselves nothing changed.
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });

    // -------------------------------------------------------------------------
    // 2. STORAGE OBJECTS FIRST, OUTSIDE ANY TRANSACTION
    // -------------------------------------------------------------------------
    //
    // Deleting a blob is a call to the storage provider (S3 today) — real
    // network I/O with its own latency and its own failure modes, and
    // Postgres transactions must not wrap around either. Holding a database
    // transaction open across a network round trip holds row locks for as
    // long as that call takes, and a provider hiccup would turn "the reset is
    // a little slow" into "the reset is blocking anyone reading the tables
    // this transaction touches, for however long S3 takes to time out".
    //
    // `ObjectsService.delete` IS REUSED RATHER THAN A DIRECT `prisma
    // .storageObject.deleteMany`, deliberately, so the blob and its
    // `storage_object_chunks` rows are actually removed from the storage
    // provider and not merely orphaned in it — a raw `deleteMany` here would
    // delete the METADATA and leave every uploaded file behind forever,
    // unreachable and still billed. It is called once per object, with
    // `canDeleteAny` left at its default `false`: the caller is deleting
    // their OWN objects, which is the ordinary self-delete path that method
    // already serves, not the cross-user override.
    const ownedObjects = await this.prisma.storageObject.findMany({
      where: { uploadedById: userId },
      select: { id: true },
    });

    let storageObjectsDeleted = 0;
    for (const { id } of ownedObjects) {
      await this.objects.delete(id, userId);
      storageObjectsDeleted += 1;
    }

    // -------------------------------------------------------------------------
    // 3. ONE INTERACTIVE TRANSACTION, EVERY OTHER TABLE
    // -------------------------------------------------------------------------
    //
    // `ACCOUNT_RESET_TABLES`'s own header comment is the reference for WHY
    // this specific order — children before parents, `practiceAttempt`
    // first of all — keeps `practice_attempts`' `onDelete: SetNull`
    // cross-links from ever firing on this user's rows. Read it there rather
    // than restated here.
    //
    // `{ timeout: 30_000 }`: the DEFAULT interactive-transaction timeout
    // (5s) is sized for ordinary request handlers, not for a caller with
    // years of practice history across fourteen tables. 30 seconds is
    // generous headroom for the slowest realistic account without leaving a
    // runaway transaction open indefinitely if something is genuinely wrong.
    const deleted: Record<string, number> = {
      [STORAGE_OBJECTS_TABLE]: storageObjectsDeleted,
    };

    await this.prisma.$transaction(
      async (tx) => {
        for (const entry of ACCOUNT_RESET_TABLES) {
          const result = await delegateFor(tx, entry.model).deleteMany({
            where: { userId },
          });
          deleted[entry.table] = result.count;
        }
      },
      { timeout: 30_000 },
    );

    // `userSettings` and `learnerProfile` are deliberately not recreated
    // here. Both are lazily recreated at their defaults the next time they
    // are read (`UserSettingsService.getSettings`,
    // `JourneyService.ensureProfile`'s `upsert({ create: { userId }, update:
    // {} })`) — deleting the row already IS the reset for each, and writing
    // a fresh default row back here would be redundant work racing whichever
    // read happens first.

    // -------------------------------------------------------------------------
    // 4. THE AI KEY, ONLY ON `data_and_key`
    // -------------------------------------------------------------------------
    //
    // `AiUserKeyService.purgeForDeletedUser` is called with `reason:
    // 'account_reset'` — the same method a future user-deletion path would
    // call, widened (#270) to say WHICH caller it was for the audit row's
    // `meta` only. See that method's own comment for why this reuses it
    // rather than a second `deleteSecret` call: the credential lives at
    // `(purpose 'ai-user', name userId)`, and that address is this service's
    // to know about, not to duplicate.
    let aiKeyRemoved = false;
    if (scope === 'data_and_key') {
      await this.aiUserKeys.purgeForDeletedUser(userId, 'account_reset');
      aiKeyRemoved = true;
    }

    // -------------------------------------------------------------------------
    // 5. AUDIT AFTER THE DESTRUCTION COMPLETES, NOT BEFORE OR DURING
    // -------------------------------------------------------------------------
    //
    // The identical ordering `AiUserKeyService.purgeForDeletedUser`'s own
    // comment states, applied one level up: "an unaudited deletion is a
    // smaller problem than a retained credential" generalizes here to "an
    // unaudited deletion is a smaller problem than a reset that only
    // half-happened while an audit row claims it fully did". Writing the
    // audit row first would risk exactly that — a row asserting rows were
    // deleted moments before the transaction that deletes them runs, so a
    // crash in between would leave a lie in `audit_events`. Writing it last
    // means the audit row is only ever written for destruction that
    // genuinely already happened.
    //
    // NOT INSIDE THE `$transaction` ABOVE — it already committed by the time
    // this runs, and `audit_events` has no FK to any of the fourteen tables
    // that transaction touched, so there is nothing for a shared transaction
    // to buy here. Matches the pattern `objects.service.ts`'s own `delete`
    // and `UsersService.updateUserRoles` both use: the audit write is a
    // separate statement, after the state change it describes has already
    // landed.
    const auditDeleted: Record<string, number | boolean> = {
      ...deleted,
      aiKeyRemoved,
    };
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'account:reset',
        targetType: 'user',
        targetId: userId,
        // Counts and table names only — never a row's content. The same
        // "meta carries counts, never values" discipline
        // `AiUserKeyService.audit`'s own comment states for a credential
        // action, applied here to fourteen tables instead of one.
        meta: {
          scope,
          deleted: auditDeleted,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Account data reset for user ${userId} (scope: ${scope}, aiKeyRemoved: ${aiKeyRemoved})`,
    );

    // -------------------------------------------------------------------------
    // 6. NOTIFY — AFTER THE AUDIT WRITE, NEVER AWAITED INTO THE RESPONSE'S
    // FAILURE PATH
    // -------------------------------------------------------------------------
    //
    // `notify` is detached and NEVER REJECTS — see `NotificationsService
    // .notify`'s own doc comment — so this is called plainly, exactly as
    // `UsersService.updateUserRoles` and `AllowlistService.addEmail` call it,
    // with no `try`/`catch` wrapping it: a send failure becomes a
    // `notification_deliveries` row with an `error`, never an exception that
    // could make an already-successful reset look like it failed.
    //
    // `account.data_reset` is `mandatory: true` in the registry (see that
    // entry's own comment for the ordering hazard this sidesteps — the
    // `user_settings` row a non-mandatory event's preferences would live in
    // was just deleted, moments ago, by step 3 above), so this always
    // dispatches regardless of anything the caller had stored.
    const payload: AccountDataResetEmailData = {
      recipientEmail: user.email,
      scope,
      resetAt: new Date(),
      appUrl: this.appUrl(),
    };
    await this.notifications.notify('account.data_reset', userId, payload);

    return { scope, deleted, aiKeyRemoved };
  }

  /**
   * Absolute URL of the application root, for the reset email's CTA.
   *
   * Mirrors `UsersService`'s own private `appUrl()` exactly — trims a
   * trailing slash, and returns `undefined` with no `APP_URL` configured so
   * the email layout omits the button rather than rendering one that goes
   * nowhere.
   */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }
}
