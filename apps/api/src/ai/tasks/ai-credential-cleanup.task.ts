import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../../prisma/prisma.service';
import { CredentialsService } from '../../credentials/credentials.service';
import { AI_USER_CREDENTIAL_PURPOSE } from '../ai-credential.constants';

// =============================================================================
// AiUserCredentialCleanupTask — orphaned per-user keys (issue #38, epic #25)
// =============================================================================
//
// THE DEFECT THIS SWEEPS UP
//
// `Credential` has no foreign key to `User`. A per-user OpenAI key is
// addressed by `(purpose 'ai-user', name <userId>)`, where the user id is a
// STRING IN A COLUMN, not a reference — so the database cannot know the row
// belongs to that user, `ON DELETE CASCADE` does not apply, and nothing will
// ever surface the row again.
//
// A key left behind that way is a live OpenAI credential, encrypted but
// retained indefinitely, still chargeable to someone who has left.
//
// WHY A SWEEP AND NOT ONLY A DELETION HOOK
//
// `AiUserKeyService.purgeForDeletedUser` is the hook, and it is the right
// immediate action. But this application has NO user-deletion endpoint today:
// `UsersService` offers deactivation and role changes and nothing else. A hook
// with no call site is an unenforced promise that whoever adds the first
// deletion path remembers to call it — and if they do not, the failure is
// invisible, because no FK and no query will ever point at the orphan.
//
// This task does not depend on anyone remembering. It also collects rows
// orphaned by deletions performed outside the application entirely: a
// `DELETE FROM users` run by an operator, a data-migration script, a GDPR
// erasure done in SQL.
//
// WHY `list(purpose)` IS LEGITIMATE HERE
//
// docs/specs/ai-settings.md §4.2 forbids `CredentialsService.list('ai-user')`
// FROM A CONTROLLER, because it enumerates every user's key metadata and is
// the shape that grows a "show me everything" endpoint. This is not a
// controller: it is a scheduled server-side task with no HTTP surface, no
// caller, and no response. Enumerating is the entire job — you cannot find an
// orphan without looking at the set — and the result never leaves the process.
//
// It returns `CredentialInfo`, which carries a compile-time proof that it
// cannot hold secret material and whose query does not select the ciphertext
// column, so even here no key is read.
//
// AT 5AM, after the other three cleanup tasks (2, 3 and 4am), so a night's
// maintenance does not contend on the same connections.
// =============================================================================

/**
 * How many orphans one run will delete.
 *
 * A BOUND, NOT A TARGET. Any real run finds zero. A run that finds thousands
 * means something unexpected happened — a bulk deletion, a restored database
 * with a mismatched user table — and destroying every credential in one
 * unattended pass on that hypothesis is worse than doing it over several
 * nights while somebody notices the log line.
 */
const MAX_DELETIONS_PER_RUN = 500;

@Injectable()
export class AiUserCredentialCleanupTask {
  private readonly logger = new Logger(AiUserCredentialCleanupTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async handleCron(): Promise<void> {
    const removed = await this.purgeOrphans();

    // Logged only when something happened. A nightly "0 orphans" line in every
    // deployment forever is noise that trains people to skip this task's
    // output, which is exactly when the non-zero line matters.
    if (removed > 0) {
      this.logger.warn(
        `Removed ${removed} orphaned AI key credential(s) belonging to deleted users`,
      );
    }
  }

  /**
   * Delete `('ai-user', <id>)` rows whose `<id>` matches no existing user.
   *
   * Exposed (rather than inlined into `handleCron`) so it can be exercised
   * directly and invoked by hand during an incident without waiting for 5am.
   *
   * @returns how many rows were removed.
   */
  async purgeOrphans(): Promise<number> {
    const stored = await this.credentials.list(AI_USER_CREDENTIAL_PURPOSE);

    if (stored.length === 0) return 0;

    const names = stored.map((credential) => credential.name);

    // ONE QUERY FOR ALL OF THEM, not one per credential. On a system with
    // thousands of users this is the difference between a single indexed `IN`
    // and thousands of round trips at 5am.
    //
    // `name` holds a user id but is a free-text column, so a value that is not
    // a uuid is possible in principle (a hand-written row). Prisma sends these
    // to a `uuid` column and Postgres rejects the batch if one is malformed —
    // hence the filter below rather than trusting the shape.
    const candidates = names.filter(isUuid);

    const existing = await this.prisma.user.findMany({
      where: { id: { in: candidates } },
      select: { id: true },
    });

    const live = new Set(existing.map((user) => user.id));

    // A non-uuid name can match no user by construction, so it is an orphan
    // too — and one nothing else will ever collect.
    const orphans = names
      .filter((name) => !live.has(name))
      .slice(0, MAX_DELETIONS_PER_RUN);

    for (const name of orphans) {
      // Idempotent, and one at a time deliberately: a failure on one row must
      // not abandon the rest, and the store's own logging attributes each
      // deletion to its address.
      await this.credentials.deleteSecret(AI_USER_CREDENTIAL_PURPOSE, name);
    }

    return orphans.length;
  }
}

/**
 * Is `value` shaped like a uuid?
 *
 * Used to keep a hand-written, non-uuid `name` out of a query against a `uuid`
 * column, where Postgres would reject the whole batch and the sweep would
 * silently stop running. Such a name is treated as an orphan, which is
 * correct: it can match no user.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
