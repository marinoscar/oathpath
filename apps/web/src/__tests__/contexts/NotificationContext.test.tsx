import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  NotificationProvider,
  useNotifications,
  RECENT_NOTIFICATION_COUNT,
} from '../../contexts/NotificationContext';
import type {
  AppNotification,
  NotificationListResponse,
  UnreadCountResponse,
} from '../../types';

/**
 * Issue #127, epic #109. `NotificationProvider` is the notification centre's
 * state - see its own header for "table first, stream second, toast third".
 * The two REST-derived collections (`getNotifications`,
 * `getUnreadNotificationCount`) and the two write endpoints
 * (`markNotificationRead`, `markAllNotificationsRead`) are mocked directly
 * via `vi.mock('../../services/api', ...)`, keeping the real `ApiError`
 * class so the 401-suppression branches still work correctly.
 * `connectNotificationStream` is mocked to capture its `handlers` so a test
 * can simulate `onOpen`/`onNotification` arriving without any real SSE
 * machinery. `useAuth` is stubbed directly since `NotificationContext` only
 * ever reads `isAuthenticated` from it.
 *
 * THE CENTREPIECE: `handleStreamOpen` must refetch on EVERY `onOpen`, not
 * just the one that happens to follow mount - see this file's dedicated
 * describe block. Deleting that refetch is exactly the bug the header of
 * `contexts/NotificationContext.tsx` warns leaves the bell silently stale
 * forever after one network blip.
 */

const isAuthenticatedMock = vi.fn<() => boolean>();
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: isAuthenticatedMock() }),
}));

interface CapturedHandlers {
  onNotification: (notification: AppNotification) => void;
  onOpen: () => void;
  onStateChange?: (state: string) => void;
}

let capturedHandlers: CapturedHandlers | null = null;
const streamCloseMock = vi.fn();
const connectNotificationStreamMock = vi.fn((handlers: CapturedHandlers) => {
  capturedHandlers = handlers;
  return { close: streamCloseMock };
});
vi.mock('../../services/notificationStream', () => ({
  connectNotificationStream: (handlers: CapturedHandlers) =>
    connectNotificationStreamMock(handlers),
}));

const showNativeNotificationMock = vi.fn();
vi.mock('../../services/browserNotifications', () => ({
  showNativeNotification: (...args: unknown[]) => showNativeNotificationMock(...args),
}));

const getNotificationsMock = vi.fn();
const getUnreadNotificationCountMock = vi.fn();
const markNotificationReadMock = vi.fn();
const markAllNotificationsReadMock = vi.fn();

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>(
    '../../services/api',
  );
  return {
    ...actual,
    getNotifications: (...args: unknown[]) => getNotificationsMock(...args),
    getUnreadNotificationCount: (...args: unknown[]) =>
      getUnreadNotificationCountMock(...args),
    markNotificationRead: (...args: unknown[]) => markNotificationReadMock(...args),
    markAllNotificationsRead: (...args: unknown[]) =>
      markAllNotificationsReadMock(...args),
  };
});

function makeAppNotification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    eventKey: 'security.role_changed',
    title: 'Your role changed',
    body: 'You are now an Admin.',
    link: '/settings',
    readAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeListResponse(items: AppNotification[] = []): NotificationListResponse {
  return { items, total: items.length, page: 1, pageSize: RECENT_NOTIFICATION_COUNT, totalPages: 1 };
}

function makeUnreadResponse(unreadCount = 0): UnreadCountResponse {
  return { unreadCount };
}

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <NotificationProvider>{children}</NotificationProvider>
      </MemoryRouter>
    );
  };
}

describe('NotificationContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers = null;
    isAuthenticatedMock.mockReturnValue(true);
    getNotificationsMock.mockResolvedValue(makeListResponse());
    getUnreadNotificationCountMock.mockResolvedValue(makeUnreadResponse(0));
    markNotificationReadMock.mockResolvedValue(makeUnreadResponse(0));
    markAllNotificationsReadMock.mockResolvedValue(makeUnreadResponse(0));
  });

  describe('mount behaviour', () => {
    it('triggers exactly one refresh() on initial mount - one call each to the list and unread-count fetchers', async () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current?.isLoading).toBe(false));

      expect(getNotificationsMock).toHaveBeenCalledTimes(1);
      expect(getUnreadNotificationCountMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconnect refetch - the load-bearing property', () => {
    it('refetches on every stream reconnect (onOpen), not just the one after mount, repeatedly', async () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.isLoading).toBe(false));
      expect(capturedHandlers).not.toBeNull();

      // --- Second connect (first RECONNECT) ---
      getNotificationsMock.mockClear();
      getUnreadNotificationCountMock.mockClear();

      await act(async () => {
        capturedHandlers!.onOpen();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(getNotificationsMock).toHaveBeenCalledTimes(1);
        expect(getUnreadNotificationCountMock).toHaveBeenCalledTimes(1);
      });

      // --- Third connect (second RECONNECT) - proves this isn't a one-shot ---
      getNotificationsMock.mockClear();
      getUnreadNotificationCountMock.mockClear();

      await act(async () => {
        capturedHandlers!.onOpen();
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(getNotificationsMock).toHaveBeenCalledTimes(1);
        expect(getUnreadNotificationCountMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('handleNotification - live arrivals over the stream', () => {
    it('prepends the new notification to the list and increments unreadCount by 1 without refetching', async () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.isLoading).toBe(false));

      getNotificationsMock.mockClear();
      getUnreadNotificationCountMock.mockClear();

      const notification = makeAppNotification({ id: 'live-1', title: 'New arrival' });
      act(() => {
        capturedHandlers!.onNotification(notification);
      });

      expect(result.current?.notifications[0]).toEqual(notification);
      expect(result.current?.unreadCount).toBe(1);
      // Incremented locally, not refetched.
      expect(getNotificationsMock).not.toHaveBeenCalled();
      expect(getUnreadNotificationCountMock).not.toHaveBeenCalled();
    });

    it('dedupes by id - the same notification arriving twice does not duplicate the list entry or the unread count', async () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.isLoading).toBe(false));

      const notification = makeAppNotification({ id: 'dup-1' });
      act(() => {
        capturedHandlers!.onNotification(notification);
      });
      act(() => {
        capturedHandlers!.onNotification(notification);
      });

      const matching = result.current?.notifications.filter((n) => n.id === 'dup-1');
      expect(matching).toHaveLength(1);
      // #127: one notification, one increment, however many frames deliver
      // it. `seenNotificationIds` decides newness once, before either state
      // updater runs, so a second frame for an id already recorded must not
      // move the badge - the list's own dedupe above holds independently,
      // but the count must track it rather than counting every arrival.
      expect(result.current?.unreadCount).toBe(1);
    });

    it('does not double-count an id evicted from the visible list but still held in the larger id memory', async () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.isLoading).toBe(false));

      // One more arrival than the visible list holds, so the first id is
      // pushed off the end of `notifications` by truncation.
      act(() => {
        for (let i = 0; i < RECENT_NOTIFICATION_COUNT + 1; i++) {
          capturedHandlers!.onNotification(makeAppNotification({ id: `evict-${i}` }));
        }
      });

      expect(result.current?.notifications).toHaveLength(RECENT_NOTIFICATION_COUNT);
      expect(result.current?.notifications.some((n) => n.id === 'evict-0')).toBe(false);
      expect(result.current?.unreadCount).toBe(RECENT_NOTIFICATION_COUNT + 1);

      // #127: SEEN_NOTIFICATION_ID_MEMORY (200) is deliberately ~10x
      // RECENT_NOTIFICATION_COUNT (20) so that a notification the visible
      // list has already truncated away is still recognised as seen - the
      // server counted it exactly once, and a re-delivery must not count it
      // again just because it scrolled off screen.
      act(() => {
        capturedHandlers!.onNotification(makeAppNotification({ id: 'evict-0' }));
      });

      expect(result.current?.unreadCount).toBe(RECENT_NOTIFICATION_COUNT + 1);
    });

    it('reconnect race: a live arrival for an id the onOpen refetch already returned does not push the count past the servers number', async () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.isLoading).toBe(false));

      // The reconnect refetch (handleStreamOpen -> refresh()) returns a page
      // that already includes this notification, and the server's own
      // unread count (5) already accounts for it.
      const raceNotification = makeAppNotification({ id: 'race-1' });
      getNotificationsMock.mockResolvedValue(makeListResponse([raceNotification]));
      getUnreadNotificationCountMock.mockResolvedValue(makeUnreadResponse(5));

      await act(async () => {
        capturedHandlers!.onOpen();
        await Promise.resolve();
      });

      await waitFor(() => expect(result.current?.unreadCount).toBe(5));
      expect(result.current?.notifications.filter((n) => n.id === 'race-1')).toHaveLength(1);

      // The same notification then arrives live, which is the realistic
      // shape of the race: the refetch's response and the live frame for the
      // same event cross in flight. `refresh()` seeded `seenNotificationIds`
      // from the page it returned, so this must be recognised as already
      // counted rather than pushing the badge to 6.
      act(() => {
        capturedHandlers!.onNotification(raceNotification);
      });

      expect(result.current?.unreadCount).toBe(5);
      expect(result.current?.notifications.filter((n) => n.id === 'race-1')).toHaveLength(1);
    });

    it('does not raise a second native notification for a duplicate frame', async () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.isLoading).toBe(false));

      const notification = makeAppNotification({ id: 'toast-1' });
      act(() => {
        capturedHandlers!.onNotification(notification);
      });
      expect(showNativeNotificationMock).toHaveBeenCalledTimes(1);

      act(() => {
        capturedHandlers!.onNotification(notification);
      });

      // Same reasoning as the count: the user has already been interrupted
      // once about this notification, so a duplicate frame must raise no
      // second OS-level toast.
      expect(showNativeNotificationMock).toHaveBeenCalledTimes(1);
    });

    it('logout clears the id memory, so the same id arriving again after a re-login counts as new', async () => {
      const { result, rerender } = renderHook(() => useNotifications(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current?.isLoading).toBe(false));

      const notification = makeAppNotification({ id: 'relogin-1' });
      act(() => {
        capturedHandlers!.onNotification(notification);
      });
      expect(result.current?.unreadCount).toBe(1);

      // Log out: the logged-out branch resets notifications/unreadCount and
      // clears `seenNotificationIds`.
      isAuthenticatedMock.mockReturnValue(false);
      rerender();
      await waitFor(() => expect(result.current?.notifications).toEqual([]));
      expect(result.current?.unreadCount).toBe(0);

      // Log back in - a fresh mount fetch and stream connection.
      getNotificationsMock.mockResolvedValue(makeListResponse());
      getUnreadNotificationCountMock.mockResolvedValue(makeUnreadResponse(0));
      isAuthenticatedMock.mockReturnValue(true);
      rerender();
      await waitFor(() => expect(result.current?.isLoading).toBe(false));
      expect(capturedHandlers).not.toBeNull();

      // Without the memory clear, this id would be mistaken for a
      // still-remembered duplicate from the previous session and silently
      // not counted - a real under-count, not just a stale badge.
      act(() => {
        capturedHandlers!.onNotification(makeAppNotification({ id: 'relogin-1' }));
      });

      expect(result.current?.unreadCount).toBe(1);
    });

    it('caps the recent list at RECENT_NOTIFICATION_COUNT entries, newest first', async () => {
      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.isLoading).toBe(false));

      act(() => {
        for (let i = 0; i < RECENT_NOTIFICATION_COUNT + 5; i++) {
          capturedHandlers!.onNotification(makeAppNotification({ id: `cap-${i}` }));
        }
      });

      expect(result.current?.notifications).toHaveLength(RECENT_NOTIFICATION_COUNT);
      expect(result.current?.notifications[0].id).toBe(`cap-${RECENT_NOTIFICATION_COUNT + 4}`);
    });
  });

  describe('markRead', () => {
    it('optimistically sets readAt before the API call resolves, then sets unreadCount from the response on success', async () => {
      let resolveMark!: (value: UnreadCountResponse) => void;
      markNotificationReadMock.mockImplementation(
        () =>
          new Promise<UnreadCountResponse>((resolve) => {
            resolveMark = resolve;
          }),
      );

      const notification = makeAppNotification({ id: 'r1', readAt: null });
      getNotificationsMock.mockResolvedValue(makeListResponse([notification]));
      getUnreadNotificationCountMock.mockResolvedValue(makeUnreadResponse(1));

      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.notifications).toHaveLength(1));
      expect(result.current?.notifications[0].readAt).toBeNull();

      act(() => {
        void result.current?.markRead('r1');
      });

      // Optimistic: readAt is set immediately, well before the deferred
      // markNotificationRead promise resolves.
      await waitFor(() => {
        expect(result.current?.notifications[0].readAt).not.toBeNull();
      });
      expect(result.current?.unreadCount).toBe(1); // unchanged until the response arrives

      await act(async () => {
        resolveMark(makeUnreadResponse(0));
        await Promise.resolve();
      });

      await waitFor(() => expect(result.current?.unreadCount).toBe(0));
    });

    it('rolls back the optimistic change to the previous list state on API failure', async () => {
      markNotificationReadMock.mockRejectedValue(new Error('boom'));

      const notification = makeAppNotification({ id: 'r2', readAt: null });
      getNotificationsMock.mockResolvedValue(makeListResponse([notification]));
      getUnreadNotificationCountMock.mockResolvedValue(makeUnreadResponse(1));

      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.notifications).toHaveLength(1));

      // The failure path calls refresh() again; keep it returning the same
      // (still-unread) row so the eventual state is stable and assertable.
      getNotificationsMock.mockResolvedValue(makeListResponse([notification]));

      await act(async () => {
        await result.current?.markRead('r2');
      });

      await waitFor(() => {
        expect(result.current?.notifications[0].readAt).toBeNull();
      });
    });
  });

  describe('markAllRead', () => {
    it('optimistically marks every notification read, then uses the servers returned unreadCount rather than hardcoding 0', async () => {
      const n1 = makeAppNotification({ id: 'a1', readAt: null });
      const n2 = makeAppNotification({ id: 'a2', readAt: null });
      getNotificationsMock.mockResolvedValue(makeListResponse([n1, n2]));
      getUnreadNotificationCountMock.mockResolvedValue(makeUnreadResponse(2));
      // A notification arrived between the mark-all request and its response,
      // so the server reports 1 unread rather than 0.
      markAllNotificationsReadMock.mockResolvedValue(makeUnreadResponse(1));

      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.notifications).toHaveLength(2));

      await act(async () => {
        await result.current?.markAllRead();
      });

      expect(result.current?.notifications.every((n) => n.readAt !== null)).toBe(true);
      expect(result.current?.unreadCount).toBe(1);
    });

    it('rolls back to the previous list state on API failure', async () => {
      const n1 = makeAppNotification({ id: 'b1', readAt: null });
      getNotificationsMock.mockResolvedValue(makeListResponse([n1]));
      getUnreadNotificationCountMock.mockResolvedValue(makeUnreadResponse(1));
      markAllNotificationsReadMock.mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current?.notifications).toHaveLength(1));

      getNotificationsMock.mockResolvedValue(makeListResponse([n1]));

      await act(async () => {
        await result.current?.markAllRead();
      });

      await waitFor(() => {
        expect(result.current?.notifications[0].readAt).toBeNull();
      });
    });
  });

  describe('unauthenticated state', () => {
    it('resets notifications/unreadCount to empty/0 and stops fetching when isAuthenticated flips to false', async () => {
      getNotificationsMock.mockResolvedValue(
        makeListResponse([makeAppNotification({ id: 'x1' })]),
      );
      getUnreadNotificationCountMock.mockResolvedValue(makeUnreadResponse(1));

      const { result, rerender } = renderHook(() => useNotifications(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current?.notifications).toHaveLength(1));

      getNotificationsMock.mockClear();
      getUnreadNotificationCountMock.mockClear();
      isAuthenticatedMock.mockReturnValue(false);
      rerender();

      await waitFor(() => {
        expect(result.current?.notifications).toEqual([]);
        expect(result.current?.unreadCount).toBe(0);
      });
      expect(getNotificationsMock).not.toHaveBeenCalled();
      expect(getUnreadNotificationCountMock).not.toHaveBeenCalled();
    });

    it('does not attempt a stream connection while unauthenticated, and reports a closed stream', async () => {
      isAuthenticatedMock.mockReturnValue(false);

      const { result } = renderHook(() => useNotifications(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current?.streamState).toBe('closed'));
      expect(connectNotificationStreamMock).not.toHaveBeenCalled();
    });
  });

  describe('no provider mounted', () => {
    it('useNotifications() returns null - a deliberately non-throwing contract', () => {
      const { result } = renderHook(() => useNotifications());

      expect(result.current).toBeNull();
    });
  });
});
