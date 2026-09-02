import { Test, TestingModule } from '@nestjs/testing';
import { NotificationDeliveryStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type ChannelDeliveryResult,
  type NotificationChannelSender,
  type NotificationDispatchContext,
  type NotificationRecipient,
} from './notification.types';

// =============================================================================
// NotificationsService — tests (issue #125, epic #109)
// =============================================================================
//
// `NotificationDeliveryService` is used for real, wired to a mocked
// `PrismaService`, rather than mocked itself. What #125 needs proven —
// "queued is written before the send attempt, and updated after" — is an
// ordering claim across `notify -> deliverOne -> deliveries.queue ->
// sender.deliver -> deliveries.markSent/markFailed`. Mocking
// `NotificationDeliveryService` would hide exactly the sequencing this file
// exists to assert on; going one layer down to the Prisma calls it makes is
// what lets a shared `callOrder` array record the true order of events.
//
// Channel senders are hand-written fakes implementing
// `NotificationChannelSender`, not the real `EmailNotificationChannel` — this
// suite is about the dispatcher's fan-out, gating and containment, not about
// any one transport (see email-notification.channel.spec.ts for that).
//
// `notify()` defers work via `Promise.resolve().then(...)` and is fire-and-
// forget by design (see notifications.service.ts's header), so every test
// that needs to observe the outcome calls `service.flush()` — the same drain
// `onModuleDestroy` uses — rather than an arbitrary timer.
// =============================================================================

function makeSender(
  channel: 'email' | 'browser',
  overrides: Partial<NotificationChannelSender> = {},
): jest.Mocked<NotificationChannelSender> {
  return {
    channel,
    resolveTo: jest.fn((recipient: NotificationRecipient) =>
      channel === 'email' ? recipient.email : `browser:${recipient.userId}`,
    ),
    deliver: jest
      .fn()
      .mockResolvedValue({ success: true, messageId: 'msg-1' } satisfies ChannelDeliveryResult),
    ...overrides,
  } as jest.Mocked<NotificationChannelSender>;
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockPrisma: MockPrismaService;
  let emailSender: jest.Mocked<NotificationChannelSender>;
  let browserSender: jest.Mocked<NotificationChannelSender>;
  let callOrder: string[];
  let nextDeliveryId: number;

  const USER_ID = 'user-1';
  const USER_EMAIL = 'user@example.com';

  /** A `prisma.user.findUnique` row shape, defaulting to "no settings row at all". */
  function userRow(overrides: { userSettingsValue?: unknown } = {}) {
    return {
      id: USER_ID,
      email: USER_EMAIL,
      userSettings:
        overrides.userSettingsValue === undefined
          ? null
          : { value: overrides.userSettingsValue },
    };
  }

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    callOrder = [];
    nextDeliveryId = 0;

    mockPrisma.user.findUnique.mockResolvedValue(userRow() as never);

    mockPrisma.notificationDelivery.create.mockImplementation((async () => {
      callOrder.push('db:create');
      return { id: `delivery-${nextDeliveryId++}` };
    }) as never);

    mockPrisma.notificationDelivery.update.mockImplementation((async (args: {
      data: { status: NotificationDeliveryStatus };
    }) => {
      callOrder.push(`db:update:${args.data.status}`);
      return {};
    }) as never);

    emailSender = makeSender('email');
    emailSender.deliver.mockImplementation(async () => {
      callOrder.push('sender:email:deliver');
      return { success: true, messageId: 'msg-1' };
    });

    browserSender = makeSender('browser');
    browserSender.deliver.mockImplementation(async () => {
      callOrder.push('sender:browser:deliver');
      return { success: true, messageId: 'msg-2' };
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        NotificationDeliveryService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: NOTIFICATION_CHANNEL_SENDERS,
          useValue: [emailSender, browserSender],
        },
      ],
    }).compile();

    service = module.get(NotificationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // notify() never throws
  // ==========================================================================

  describe('notify() never throws', () => {
    it('for an unknown event key', async () => {
      await expect(
        service.notify('no.such.event', USER_ID, {}),
      ).resolves.toBeUndefined();
      await expect(service.flush()).resolves.toBeUndefined();
    });

    it('for a user that does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null as never);

      await service.notify('user.welcome', 'ghost-user', {});
      await expect(service.flush()).resolves.toBeUndefined();
    });

    it('when a channel sender rejects', async () => {
      emailSender.deliver.mockRejectedValue(new Error('smtp exploded'));

      await service.notify('user.welcome', USER_ID, {});
      await expect(service.flush()).resolves.toBeUndefined();
    });

    it('when writing the delivery record fails', async () => {
      mockPrisma.notificationDelivery.create.mockRejectedValue(
        new Error('db down') as never,
      );

      await service.notify('user.welcome', USER_ID, {});
      await expect(service.flush()).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // An unknown event key records NOTHING
  // ==========================================================================

  describe('an unknown event key', () => {
    it('writes no delivery row and never even looks up the user', async () => {
      await service.notify('totally.unregistered.event', USER_ID, {});
      await service.flush();

      expect(mockPrisma.notificationDelivery.create).not.toHaveBeenCalled();
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Delivery rows: one per (event, user, channel), recipient = address used
  // ==========================================================================

  describe('delivery rows', () => {
    it('writes one row per channel attempt, with recipient set to the resolved address', async () => {
      await service.notify('user.welcome', USER_ID, { name: 'Ada' });
      await service.flush();

      expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledTimes(1);
      const [[createArgs]] = mockPrisma.notificationDelivery.create.mock
        .calls as unknown as [[{ data: Record<string, unknown> }]];

      expect(createArgs.data).toMatchObject({
        eventKey: 'user.welcome',
        userId: USER_ID,
        recipient: USER_EMAIL,
        channel: 'email',
        status: NotificationDeliveryStatus.queued,
      });
    });

    it('writes a row for every declared channel of a mandatory event, even when both are explicitly muted', async () => {
      // security.role_changed is mandatory and declares email + browser.
      mockPrisma.user.findUnique.mockResolvedValue(
        userRow({
          userSettingsValue: {
            notifications: {
              email: { 'security.role_changed': false },
              browser: { 'security.role_changed': false },
            },
          },
        }) as never,
      );

      await service.notify('security.role_changed', USER_ID, {});
      await service.flush();

      expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledTimes(2);
      const channels = mockPrisma.notificationDelivery.create.mock.calls.map(
        ([args]: [{ data: { channel: string } }]) => args.data.channel,
      );
      expect(channels.sort()).toEqual(['browser', 'email']);
    });

    it('writes no row at all when every channel is muted for a non-mandatory event', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        userRow({
          userSettingsValue: {
            notifications: { email: { 'user.welcome': false } },
          },
        }) as never,
      );

      await service.notify('user.welcome', USER_ID, {});
      await service.flush();

      expect(mockPrisma.notificationDelivery.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Ordering: queued is written BEFORE the send, updated AFTER
  // ==========================================================================

  describe('ordering', () => {
    it('writes the queued row before calling the channel, and updates it after', async () => {
      await service.notify('user.welcome', USER_ID, {});
      await service.flush();

      expect(callOrder).toEqual([
        'db:create',
        'sender:email:deliver',
        'db:update:sent',
      ]);
    });
  });

  // ==========================================================================
  // Failure containment
  // ==========================================================================

  describe('failure containment', () => {
    it('a provider-reported failure is recorded as failed with the error text, and does not propagate', async () => {
      emailSender.deliver.mockResolvedValue({
        success: false,
        error: 'Mailbox does not exist',
      });

      await service.notify('user.welcome', USER_ID, {});
      await service.flush();

      expect(mockPrisma.notificationDelivery.update).toHaveBeenCalledTimes(1);
      const [[updateArgs]] = mockPrisma.notificationDelivery.update.mock
        .calls as unknown as [[{ data: Record<string, unknown> }]];
      expect(updateArgs.data).toMatchObject({
        status: NotificationDeliveryStatus.failed,
        error: 'Mailbox does not exist',
        providerMessageId: null,
      });
    });

    it('a channel that throws is recorded as failed, and the throw does not propagate', async () => {
      emailSender.deliver.mockRejectedValue(new Error('connection reset'));

      await service.notify('user.welcome', USER_ID, {});
      await service.flush();

      expect(mockPrisma.notificationDelivery.update).toHaveBeenCalledTimes(1);
      const [[updateArgs]] = mockPrisma.notificationDelivery.update.mock
        .calls as unknown as [[{ data: Record<string, unknown> }]];
      expect(updateArgs.data.status).toBe(NotificationDeliveryStatus.failed);
      expect(updateArgs.data.error).toContain('connection reset');
    });

    it('a database failure while queuing does not stop the send, and the later mark* call becomes a no-op', async () => {
      mockPrisma.notificationDelivery.create.mockRejectedValue(
        new Error('db down') as never,
      );

      await service.notify('user.welcome', USER_ID, {});
      await service.flush();

      // The send still happened — the notification matters more than its
      // bookkeeping (see notification-delivery.service.ts's header).
      expect(emailSender.deliver).toHaveBeenCalledTimes(1);
      // No id came back from `queue`, so `markSent`/`markFailed` are no-ops.
      expect(mockPrisma.notificationDelivery.update).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // notify() does NOT read through UserSettingsService
  // ==========================================================================

  describe('reading preferences does not go through UserSettingsService', () => {
    it('dispatching for a user with no settings row writes no user_settings row', async () => {
      // userRow() defaults to userSettings: null — no row exists at all.
      await service.notify('user.welcome', USER_ID, {});
      await service.flush();

      // UserSettingsService.getSettings would create a row on a miss. If
      // preference resolution ever routed through it (directly or via a
      // service that does), one of these would fire.
      expect(mockPrisma.userSettings.create).not.toHaveBeenCalled();
      expect(mockPrisma.userSettings.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.userSettings.update).not.toHaveBeenCalled();
      expect(mockPrisma.userSettings.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.userSettings.findFirst).not.toHaveBeenCalled();

      // The recipient is still resolved correctly — the raw read succeeded
      // and the event still dispatched (default-on, no preference row).
      expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledTimes(1);
    });

    it('an absent settings row resolves to the registry default rather than being treated as "everything off"', async () => {
      await service.notify('user.welcome', USER_ID, {});
      await service.flush();

      // user.welcome defaults to enabled; an absent row must not suppress it.
      expect(emailSender.deliver).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // notifyAddress() — the account-less recipient (issue #128)
  // ==========================================================================
  //
  // `allowlist.invitation` is the worked example: the recipient has no user id
  // to pass, so this is a second way of BUILDING a `NotificationRecipient`
  // rather than a second gate. `dispatchToAddress` always looks the address up
  // first (`prisma.user.findFirst`) before deciding whether to delegate to the
  // ordinary user path, so every test below asserts on that lookup as much as
  // on the outcome.
  // ==========================================================================

  describe('notifyAddress()', () => {
    const ADDRESS = 'invitee@example.com';

    beforeEach(() => {
      // Distinct from `mockPrisma.user.findUnique`'s default in the outer
      // `beforeEach`: `findFirst` is the case-insensitive account lookup
      // `dispatchToAddress` performs before anything else. Each test below
      // overrides it for its own scenario; the default here is "no account",
      // the most common case for a brand-new invitation.
      mockPrisma.user.findFirst.mockResolvedValue(null as never);
    });

    it('an address with no user account is dispatched anonymously: the delivery row has userId null and recipient set to the address', async () => {
      await service.notifyAddress('allowlist.invitation', ADDRESS, {});
      await service.flush();

      expect(mockPrisma.user.findFirst).toHaveBeenCalledTimes(1);
      // The ordinary user path is never entered for a genuinely account-less
      // address — no preferences to read, so no reason to touch `user.findUnique`.
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();

      expect(mockPrisma.notificationDelivery.create).toHaveBeenCalledTimes(1);
      const [[createArgs]] = mockPrisma.notificationDelivery.create.mock
        .calls as unknown as [[{ data: Record<string, unknown> }]];
      expect(createArgs.data).toMatchObject({
        eventKey: 'allowlist.invitation',
        userId: null,
        recipient: ADDRESS,
        channel: 'email',
      });
      expect(emailSender.deliver).toHaveBeenCalledTimes(1);
    });

    it('the account lookup is case-insensitive: users.email keeps provider casing, the allowlist entry is lower-cased', async () => {
      await service.notifyAddress('allowlist.invitation', 'Invitee@Example.com', {});
      await service.flush();

      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: 'Invitee@Example.com', mode: 'insensitive' } },
        select: { id: true },
      });
    });

    it('an address that DOES belong to an account delegates to the user path, and that account\'s stored preferences are honoured — a stored false actually suppresses it', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: USER_ID } as never);
      mockPrisma.user.findUnique.mockResolvedValue(
        userRow({
          userSettingsValue: {
            notifications: { email: { 'allowlist.invitation': false } },
          },
        }) as never,
      );

      await service.notifyAddress('allowlist.invitation', USER_EMAIL, {});
      await service.flush();

      // Delegated: the ordinary per-user read ran.
      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
      // And its stored `false` actually suppressed the send — the property
      // that keeps `notifyAddress` from being a preference bypass. If this
      // recipient had been dispatched anonymously instead, `preferences: {}`
      // would resolve to the registry default (`true`) and the assertions
      // below would fail.
      expect(emailSender.deliver).not.toHaveBeenCalled();
      expect(mockPrisma.notificationDelivery.create).not.toHaveBeenCalled();
    });

    it('if the account lookup fails, the dispatch aborts rather than falling through to the anonymous path (fails closed)', async () => {
      mockPrisma.user.findFirst.mockRejectedValue(
        new Error('connection lost') as never,
      );

      await expect(
        service.notifyAddress('allowlist.invitation', ADDRESS, {}),
      ).resolves.toBeUndefined();
      await expect(service.flush()).resolves.toBeUndefined();

      // No fallback to the account-less path: nothing was queued and nothing
      // was sent. A gate that fails open here would silently downgrade a
      // preference-checked send into an unchecked one.
      expect(mockPrisma.notificationDelivery.create).not.toHaveBeenCalled();
      expect(emailSender.deliver).not.toHaveBeenCalled();
    });

    it('for an unknown event key, is a no-op that never even performs the account lookup', async () => {
      await service.notifyAddress('no.such.event', ADDRESS, {});
      await service.flush();

      expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.notificationDelivery.create).not.toHaveBeenCalled();
    });
  });
});
