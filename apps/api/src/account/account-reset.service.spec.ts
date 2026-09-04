import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AccountResetService } from './account-reset.service';
import { ACCOUNT_RESET_TABLES } from './account-reset.constants';
import { PrismaService } from '../prisma/prisma.service';
import { AiUserKeyService } from '../ai/ai-user-key.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// =============================================================================
// AccountResetService — tests (issue #270)
// =============================================================================
//
// The properties an HTTP-level integration spec cannot easily assert:
//
//   1. The phrase check runs first, unconditionally, and touches NOTHING
//      else on a mismatch.
//   2. The fourteen `ACCOUNT_RESET_TABLES` deletes run inside the
//      transaction, in the constant's own declared order.
//   3. Storage-object deletion happens where the source actually puts it —
//      outside `$transaction`, proven by real call ordering, not assumed.
//   4. The AI key purge is gated on `scope === 'data_and_key'` alone.
//   5. The audit write happens strictly after every deletion, and its
//      `meta` carries only counts and booleans — never a row's content.
//   6. The notification dispatches strictly after the audit write.
// =============================================================================

const USER_ID = '11111111-1111-4111-8111-111111111111';
const USER_EMAIL = 'caller@example.com';

/** Per-table delete counts, distinct and deterministic. */
function tableCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  ACCOUNT_RESET_TABLES.forEach((entry, index) => {
    counts[entry.model] = (index + 1) * 3;
  });
  return counts;
}

describe('AccountResetService', () => {
  let service: AccountResetService;
  let prisma: MockPrismaService;
  let aiUserKeys: { purgeForDeletedUser: jest.Mock };
  let objects: { delete: jest.Mock };
  let notifications: { notify: jest.Mock };
  let config: { get: jest.Mock };

  /**
   * Every mutating call this service can make, in the order it actually
   * happened — shared across the deleteMany mocks, `ObjectsService.delete`,
   * `AiUserKeyService.purgeForDeletedUser`, the audit write and the
   * notification dispatch, so a single array proves the FULL ordering rather
   * than five separate pairwise comparisons.
   */
  let order: string[];

  beforeEach(async () => {
    order = [];
    prisma = createMockPrismaService();

    // The recipient email read, before anything is deleted.
    (prisma.user.findUniqueOrThrow as unknown as jest.Mock).mockResolvedValue({
      email: USER_EMAIL,
    });

    // `storageObject.findMany` — no uploaded objects by default; individual
    // tests override this to exercise the storage-object path.
    (prisma.storageObject.findMany as unknown as jest.Mock).mockResolvedValue([]);

    // The interactive transaction hands the callback `prisma` itself, the
    // same shape `mockPrismaTransaction()` gives every integration spec —
    // so `tx.<model>.deleteMany` below IS `prisma.<model>.deleteMany`.
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(
      async (arg: unknown) => {
        order.push('$transaction:start');
        if (typeof arg === 'function') {
          const result = await (arg as (tx: unknown) => Promise<unknown>)(prisma);
          order.push('$transaction:end');
          return result;
        }
        return undefined;
      },
    );

    // Every ACCOUNT_RESET_TABLES model's deleteMany/count, wired generically
    // rather than fourteen hand-written mocks — see this constant's own
    // header comment for why that list is never duplicated.
    const counts = tableCounts();
    for (const entry of ACCOUNT_RESET_TABLES) {
      const model = (prisma as unknown as Record<string, any>)[entry.model];
      model.deleteMany.mockImplementation(async () => {
        order.push(`deleteMany:${entry.model}`);
        return { count: counts[entry.model] };
      });
    }

    (prisma.auditEvent.create as unknown as jest.Mock).mockImplementation(
      async () => {
        order.push('audit');
        return {} as never;
      },
    );

    aiUserKeys = {
      purgeForDeletedUser: jest.fn().mockImplementation(async () => {
        order.push('purgeForDeletedUser');
      }),
    };
    objects = {
      delete: jest.fn().mockImplementation(async () => {
        order.push('objects.delete');
      }),
    };
    notifications = {
      notify: jest.fn().mockImplementation(async () => {
        order.push('notify');
      }),
    };
    config = { get: jest.fn().mockReturnValue('https://app.example.com') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountResetService,
        { provide: PrismaService, useValue: prisma },
        { provide: AiUserKeyService, useValue: aiUserKeys },
        { provide: ObjectsService, useValue: objects },
        { provide: NotificationsService, useValue: notifications },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(AccountResetService);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  });

  // ---------------------------------------------------------------------------
  // The phrase check runs first, unconditionally
  // ---------------------------------------------------------------------------

  describe('phrase mismatch', () => {
    it('throws BadRequestException before touching Prisma, AiUserKeyService, ObjectsService, or NotificationsService', async () => {
      await expect(
        service.reset(USER_ID, 'data', 'not the phrase'),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prisma.storageObject.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
      expect(aiUserKeys.purgeForDeletedUser).not.toHaveBeenCalled();
      expect(objects.delete).not.toHaveBeenCalled();
      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('is case-sensitive — a lowercase phrase is a mismatch', async () => {
      await expect(
        service.reset(USER_ID, 'data', 'delete my data'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects the OTHER scope's phrase", async () => {
      await expect(
        service.reset(USER_ID, 'data', 'DELETE EVERYTHING'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('empty confirmationPhrase throws too (not merely a Zod concern)', async () => {
      await expect(service.reset(USER_ID, 'data', '')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Delete order — every ACCOUNT_RESET_TABLES entry, in that exact order
  // ---------------------------------------------------------------------------

  describe('delete order', () => {
    it('calls tx.<model>.deleteMany for every ACCOUNT_RESET_TABLES entry, in that exact order', async () => {
      await service.reset(USER_ID, 'data', 'DELETE MY DATA');

      const deleteCalls = order.filter((step) => step.startsWith('deleteMany:'));
      expect(deleteCalls).toEqual(
        ACCOUNT_RESET_TABLES.map((entry) => `deleteMany:${entry.model}`),
      );
    });

    it('every deleteMany is scoped to the caller\'s own userId', async () => {
      await service.reset(USER_ID, 'data', 'DELETE MY DATA');

      for (const entry of ACCOUNT_RESET_TABLES) {
        const model = (prisma as unknown as Record<string, any>)[entry.model];
        expect(model.deleteMany).toHaveBeenCalledWith({
          where: { userId: USER_ID },
        });
      }
    });

    it('all fourteen deletes happen INSIDE the $transaction callback', async () => {
      await service.reset(USER_ID, 'data', 'DELETE MY DATA');

      const startIndex = order.indexOf('$transaction:start');
      const endIndex = order.indexOf('$transaction:end');
      const deleteIndices = ACCOUNT_RESET_TABLES.map((entry) =>
        order.indexOf(`deleteMany:${entry.model}`),
      );

      for (const index of deleteIndices) {
        expect(index).toBeGreaterThan(startIndex);
        expect(index).toBeLessThan(endIndex);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Storage objects — wherever the source actually puts them
  // ---------------------------------------------------------------------------

  describe('storage object deletion', () => {
    it('calls ObjectsService.delete once per owned object, with (id, userId)', async () => {
      (prisma.storageObject.findMany as unknown as jest.Mock).mockResolvedValue([
        { id: 'obj-1' },
        { id: 'obj-2' },
      ]);

      await service.reset(USER_ID, 'data', 'DELETE MY DATA');

      expect(objects.delete).toHaveBeenCalledTimes(2);
      expect(objects.delete).toHaveBeenNthCalledWith(1, 'obj-1', USER_ID);
      expect(objects.delete).toHaveBeenNthCalledWith(2, 'obj-2', USER_ID);
    });

    it('happens BEFORE $transaction is invoked at all — real ordering, not assumed', async () => {
      (prisma.storageObject.findMany as unknown as jest.Mock).mockResolvedValue([
        { id: 'obj-1' },
      ]);

      await service.reset(USER_ID, 'data', 'DELETE MY DATA');

      const objectDeleteIndex = order.indexOf('objects.delete');
      const transactionStartIndex = order.indexOf('$transaction:start');

      expect(objectDeleteIndex).toBeGreaterThanOrEqual(0);
      expect(transactionStartIndex).toBeGreaterThanOrEqual(0);
      expect(objectDeleteIndex).toBeLessThan(transactionStartIndex);
    });

    it('reports 0 storage objects deleted when the caller has none', async () => {
      const result = await service.reset(USER_ID, 'data', 'DELETE MY DATA');
      expect(result.deleted.storage_objects).toBe(0);
      expect(objects.delete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // AI key purge — gated on scope alone
  // ---------------------------------------------------------------------------

  describe('AI key purge', () => {
    it('is called exactly once, with reason "account_reset", on scope: data_and_key', async () => {
      await service.reset(USER_ID, 'data_and_key', 'DELETE EVERYTHING');

      expect(aiUserKeys.purgeForDeletedUser).toHaveBeenCalledTimes(1);
      expect(aiUserKeys.purgeForDeletedUser).toHaveBeenCalledWith(
        USER_ID,
        'account_reset',
      );
    });

    it('is NOT called at all on scope: data', async () => {
      await service.reset(USER_ID, 'data', 'DELETE MY DATA');
      expect(aiUserKeys.purgeForDeletedUser).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Audit — after every deletion, exact meta shape
  // ---------------------------------------------------------------------------

  describe('audit event', () => {
    it('is written AFTER every deleteMany and after storage object deletion', async () => {
      (prisma.storageObject.findMany as unknown as jest.Mock).mockResolvedValue([
        { id: 'obj-1' },
      ]);

      await service.reset(USER_ID, 'data', 'DELETE MY DATA');

      const auditIndex = order.indexOf('audit');
      const lastDeleteIndex = Math.max(
        order.indexOf('objects.delete'),
        ...ACCOUNT_RESET_TABLES.map((entry) => order.indexOf(`deleteMany:${entry.model}`)),
      );

      expect(auditIndex).toBeGreaterThan(lastDeleteIndex);
    });

    it('is written with the exact documented shape — counts and booleans only, never a row\'s content', async () => {
      const counts = tableCounts();
      await service.reset(USER_ID, 'data_and_key', 'DELETE EVERYTHING');

      const expectedDeleted: Record<string, number | boolean> = {
        storage_objects: 0,
      };
      for (const entry of ACCOUNT_RESET_TABLES) {
        expectedDeleted[entry.table] = counts[entry.model];
      }
      expectedDeleted.aiKeyRemoved = true;

      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: USER_ID,
          action: 'account:reset',
          targetType: 'user',
          targetId: USER_ID,
          meta: {
            scope: 'data_and_key',
            deleted: expectedDeleted,
          },
        },
      });

      // Spot check: every value in `deleted` is a number or the one boolean
      // field — nothing shaped like a row's actual content (a string, an
      // array, a nested object) ever reaches `meta`.
      const call = (prisma.auditEvent.create as unknown as jest.Mock).mock.calls[0][0];
      const deleted = call.data.meta.deleted as Record<string, unknown>;
      for (const [key, value] of Object.entries(deleted)) {
        if (key === 'aiKeyRemoved') {
          expect(typeof value).toBe('boolean');
        } else {
          expect(typeof value).toBe('number');
        }
      }
    });

    it('aiKeyRemoved is false in the audit meta on scope: data', async () => {
      await service.reset(USER_ID, 'data', 'DELETE MY DATA');

      const call = (prisma.auditEvent.create as unknown as jest.Mock).mock.calls[0][0];
      expect(call.data.meta.deleted.aiKeyRemoved).toBe(false);
      expect(call.data.meta.scope).toBe('data');
    });
  });

  // ---------------------------------------------------------------------------
  // Notification — after the audit write
  // ---------------------------------------------------------------------------

  describe('notification', () => {
    it('calls NotificationsService.notify with "account.data_reset" and the caller\'s id, AFTER the audit write', async () => {
      await service.reset(USER_ID, 'data', 'DELETE MY DATA');

      expect(notifications.notify).toHaveBeenCalledWith(
        'account.data_reset',
        USER_ID,
        expect.objectContaining({
          recipientEmail: USER_EMAIL,
          scope: 'data',
        }),
      );

      const auditIndex = order.indexOf('audit');
      const notifyIndex = order.indexOf('notify');
      expect(notifyIndex).toBeGreaterThan(auditIndex);
    });
  });

  // ---------------------------------------------------------------------------
  // Return value — deleted counts match what deleteMany actually returned
  // ---------------------------------------------------------------------------

  describe('return value', () => {
    it('the deleted counts equal what each mocked deleteMany/objects.delete produced', async () => {
      const counts = tableCounts();
      (prisma.storageObject.findMany as unknown as jest.Mock).mockResolvedValue([
        { id: 'obj-1' },
        { id: 'obj-2' },
      ]);

      const result = await service.reset(USER_ID, 'data', 'DELETE MY DATA');

      expect(result.scope).toBe('data');
      expect(result.aiKeyRemoved).toBe(false);
      expect(result.deleted.storage_objects).toBe(2);
      for (const entry of ACCOUNT_RESET_TABLES) {
        expect(result.deleted[entry.table]).toBe(counts[entry.model]);
      }
    });
  });
});
