import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AiUserCredentialCleanupTask } from './ai-credential-cleanup.task';
import { AI_USER_CREDENTIAL_PURPOSE } from '../ai-credential.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { CredentialsService } from '../../credentials/credentials.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';

// =============================================================================
// AiUserCredentialCleanupTask — tests (issue #38, epic #25)
// =============================================================================
//
// This sweep is the only thing in the system that will ever find an orphaned
// per-user key: `Credential` has no FK to `User`, so no cascade fires, no
// query joins, and nothing else looks. The tests below are therefore about
// the two ways it could fail QUIETLY — deleting a live user's key, or
// deleting nothing when there is something to delete.
// =============================================================================

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';

function credential(name: string) {
  return {
    purpose: AI_USER_CREDENTIAL_PURPOSE,
    name,
    hint: '••••abcd',
    label: 'OpenAI API key (personal)',
    updatedByUserId: name,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('AiUserCredentialCleanupTask', () => {
  let task: AiUserCredentialCleanupTask;
  let prisma: MockPrismaService;
  let credentials: { list: jest.Mock; deleteSecret: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrismaService();
    credentials = {
      list: jest.fn().mockResolvedValue([]),
      deleteSecret: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiUserCredentialCleanupTask,
        { provide: PrismaService, useValue: prisma },
        { provide: CredentialsService, useValue: credentials },
      ],
    }).compile();

    task = module.get(AiUserCredentialCleanupTask);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('does nothing when no per-user keys are stored', async () => {
    await expect(task.purgeOrphans()).resolves.toBe(0);

    // Not even a user query — there is nothing to check against.
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(credentials.deleteSecret).not.toHaveBeenCalled();
  });

  it('PRESERVES the keys of users who still exist', async () => {
    // The dangerous direction. A sweep that deleted a live user's key would
    // lock them out of the product, and they would have no idea why.
    credentials.list.mockResolvedValue([credential(ALICE), credential(BOB)]);
    prisma.user.findMany.mockResolvedValue([
      { id: ALICE },
      { id: BOB },
    ] as never);

    await expect(task.purgeOrphans()).resolves.toBe(0);
    expect(credentials.deleteSecret).not.toHaveBeenCalled();
  });

  it('removes the key of a user who no longer exists', async () => {
    credentials.list.mockResolvedValue([credential(ALICE), credential(GONE)]);
    prisma.user.findMany.mockResolvedValue([{ id: ALICE }] as never);

    await expect(task.purgeOrphans()).resolves.toBe(1);

    expect(credentials.deleteSecret).toHaveBeenCalledTimes(1);
    expect(credentials.deleteSecret).toHaveBeenCalledWith(
      AI_USER_CREDENTIAL_PURPOSE,
      GONE,
    );
  });

  it('checks every candidate in ONE query, not one per credential', async () => {
    // On a system with thousands of users this is the difference between a
    // single indexed IN and thousands of round trips at 5am.
    credentials.list.mockResolvedValue([
      credential(ALICE),
      credential(BOB),
      credential(GONE),
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: ALICE }, { id: BOB }] as never);

    await task.purgeOrphans();

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    const query = prisma.user.findMany.mock.calls[0][0] as {
      where: { id: { in: string[] } };
    };
    expect(query.where.id.in.sort()).toEqual([ALICE, BOB, GONE].sort());
  });

  it('treats a non-uuid name as an orphan, and keeps it out of the query', async () => {
    // Prisma sends these to a `uuid` column, and Postgres rejects the whole
    // batch if one is malformed — which would silently stop the sweep running
    // at all. Such a name can match no user, so it is an orphan.
    credentials.list.mockResolvedValue([
      credential(ALICE),
      credential('hand-written-row'),
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: ALICE }] as never);

    await expect(task.purgeOrphans()).resolves.toBe(1);

    const query = prisma.user.findMany.mock.calls[0][0] as {
      where: { id: { in: string[] } };
    };
    expect(query.where.id.in).toEqual([ALICE]);
    expect(credentials.deleteSecret).toHaveBeenCalledWith(
      AI_USER_CREDENTIAL_PURPOSE,
      'hand-written-row',
    );
  });

  it('is scoped to the ai-user purpose and touches nothing else', async () => {
    // The SMTP password lives in the same table. A sweep that widened its
    // scope would delete a working mail configuration.
    credentials.list.mockResolvedValue([credential(GONE)]);
    prisma.user.findMany.mockResolvedValue([] as never);

    await task.purgeOrphans();

    expect(credentials.list).toHaveBeenCalledWith(AI_USER_CREDENTIAL_PURPOSE);
    for (const [purpose] of credentials.deleteSecret.mock.calls) {
      expect(purpose).toBe(AI_USER_CREDENTIAL_PURPOSE);
    }
  });

  it('bounds one run rather than destroying everything on an unexpected finding', async () => {
    // A run that finds thousands means something unexpected happened — a bulk
    // deletion, a restored database with a mismatched user table. Doing it
    // over several nights while somebody notices the log line is better than
    // one unattended pass acting on that hypothesis.
    credentials.list.mockResolvedValue(
      Array.from({ length: 900 }, (_, i) =>
        credential(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
      ),
    );
    prisma.user.findMany.mockResolvedValue([] as never);

    await expect(task.purgeOrphans()).resolves.toBe(500);
  });

  it('is idempotent — a second run finds nothing left', async () => {
    credentials.list.mockResolvedValueOnce([credential(GONE)]);
    prisma.user.findMany.mockResolvedValue([] as never);
    await task.purgeOrphans();

    credentials.list.mockResolvedValueOnce([]);
    await expect(task.purgeOrphans()).resolves.toBe(0);
  });

  it('stays quiet when there is nothing to report', async () => {
    // A nightly "0 orphans" line in every deployment forever trains people to
    // skip this task's output, which is exactly when the non-zero line
    // matters.
    const warn = jest.spyOn(Logger.prototype, 'warn');
    credentials.list.mockResolvedValue([]);

    await task.handleCron();

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when it removed something', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    credentials.list.mockResolvedValue([credential(GONE)]);
    prisma.user.findMany.mockResolvedValue([] as never);

    await task.handleCron();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 orphaned'));
  });
});
