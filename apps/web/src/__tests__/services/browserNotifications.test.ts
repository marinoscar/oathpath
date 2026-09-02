import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  requestBrowserNotificationPermission,
  showNativeNotification,
} from '../../services/browserNotifications';
import type { AppNotification } from '../../types';

/**
 * Issue #127, epic #109. This module is DECORATION - the notification centre
 * behind the bell is the durable feature, and everything here must degrade
 * silently: unsupported browsers, denied permission, and a constructor that
 * throws (Android Chrome, where `Notification` is service-worker-only) are
 * all supported outcomes, never exceptions that escape to a caller.
 *
 * Mocking idiom follows `useBrowserNotificationPermission.test.ts`: replace
 * `window.Notification` per test with a fake supplying only what each test
 * needs, restoring the original afterward.
 */

const originalNotification = (window as any).Notification;

interface FakeNotificationInstance {
  onclick: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

function setNotification(
  permission: 'granted' | 'denied' | 'default' | 'absent',
  opts: {
    requestPermissionImpl?: () => Promise<NotificationPermission> | NotificationPermission;
    constructorImpl?: (title: string, options?: NotificationOptions) => FakeNotificationInstance;
    throwOnConstruct?: boolean;
  } = {},
) {
  if (permission === 'absent') {
    delete (window as any).Notification;
    return { requestPermission: undefined, ctor: undefined };
  }

  const requestPermission = vi.fn(
    opts.requestPermissionImpl ?? (() => Promise.resolve(permission)),
  );

  const instances: FakeNotificationInstance[] = [];
  const ctor = vi.fn(function (
    this: FakeNotificationInstance,
    title: string,
    options?: NotificationOptions,
  ) {
    if (opts.throwOnConstruct) {
      throw new Error('Notification is not supported in this context');
    }
    const instance: FakeNotificationInstance = { onclick: null, close: vi.fn() };
    if (opts.constructorImpl) {
      const custom = opts.constructorImpl(title, options);
      Object.assign(instance, custom);
    }
    Object.assign(this, instance);
    instances.push(this as unknown as FakeNotificationInstance);
    return this;
  });

  (ctor as any).permission = permission;
  (ctor as any).requestPermission = requestPermission;

  (window as any).Notification = ctor;

  return { requestPermission, ctor, instances };
}

const baseNotification: AppNotification = {
  id: 'n1',
  eventKey: 'security.role_changed',
  title: 'Your role changed',
  body: 'You are now an Admin.',
  link: '/settings',
  readAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('browserNotifications', () => {
  afterEach(() => {
    if (originalNotification === undefined) {
      delete (window as any).Notification;
    } else {
      (window as any).Notification = originalNotification;
    }
    vi.restoreAllMocks();
  });

  describe('requestBrowserNotificationPermission', () => {
    it('returns null without throwing when Notification is unsupported', async () => {
      setNotification('absent');

      await expect(requestBrowserNotificationPermission()).resolves.toBeNull();
    });

    it('calls window.Notification.requestPermission() and returns its resolved value', async () => {
      const { requestPermission } = setNotification('default', {
        requestPermissionImpl: () => Promise.resolve('granted'),
      });

      const result = await requestBrowserNotificationPermission();

      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(result).toBe('granted');
    });

    it('catches a synchronous throw from requestPermission and returns null', async () => {
      setNotification('default', {
        requestPermissionImpl: () => {
          throw new Error('blocked');
        },
      });

      await expect(requestBrowserNotificationPermission()).resolves.toBeNull();
    });
  });

  describe('showNativeNotification', () => {
    it('returns false when Notification is unsupported', () => {
      setNotification('absent');

      const result = showNativeNotification(baseNotification);

      expect(result).toBe(false);
    });

    it('returns false and constructs nothing when permission is not granted', () => {
      const { ctor } = setNotification('denied');

      const result = showNativeNotification(baseNotification);

      expect(result).toBe(false);
      expect(ctor).not.toHaveBeenCalled();
    });

    it('returns false and constructs nothing when permission is "default"', () => {
      const { ctor } = setNotification('default');

      const result = showNativeNotification(baseNotification);

      expect(result).toBe(false);
      expect(ctor).not.toHaveBeenCalled();
    });

    it('constructs new Notification(title, {body, tag}) and returns true when granted', () => {
      const { ctor } = setNotification('granted');

      const result = showNativeNotification(baseNotification);

      expect(result).toBe(true);
      expect(ctor).toHaveBeenCalledTimes(1);
      expect(ctor).toHaveBeenCalledWith(
        baseNotification.title,
        expect.objectContaining({ body: baseNotification.body, tag: baseNotification.id }),
      );
    });

    it('tags the toast with the notification id - this is what collapses duplicate toasts across tabs', () => {
      const { ctor } = setNotification('granted');

      showNativeNotification(baseNotification);

      const [, options] = ctor.mock.calls[0];
      expect(options.tag).toBe('n1');
    });

    it('clicking the toast focuses the window, then calls onClick with the notification, then closes the toast', () => {
      const { ctor } = setNotification('granted');
      const onClick = vi.fn();
      const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});

      showNativeNotification(baseNotification, onClick);

      const instance = ctor.mock.results[0].value as FakeNotificationInstance;
      expect(instance.onclick).toBeInstanceOf(Function);

      const callOrder: string[] = [];
      focusSpy.mockImplementation(() => callOrder.push('focus'));
      onClick.mockImplementation(() => callOrder.push('onClick'));
      instance.close.mockImplementation(() => callOrder.push('close'));

      instance.onclick!();

      expect(callOrder).toEqual(['focus', 'onClick', 'close']);
      expect(onClick).toHaveBeenCalledWith(baseNotification);
    });

    it('does not attach onclick when no onClick callback is provided', () => {
      const { ctor } = setNotification('granted');

      showNativeNotification(baseNotification);

      const instance = ctor.mock.results[0].value as FakeNotificationInstance;
      expect(instance.onclick).toBeNull();
    });

    it('a throw from the Notification constructor is caught and returns false', () => {
      setNotification('granted', { throwOnConstruct: true });

      expect(() => showNativeNotification(baseNotification)).not.toThrow();
      expect(showNativeNotification(baseNotification)).toBe(false);
    });
  });
});
