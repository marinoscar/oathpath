import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import {
  NotificationSettings,
  isEventChannelEnabled,
  preferenceWriteFor,
  browserChannelState,
} from '../../../components/settings/NotificationSettings';
import type { NotificationEventDef, NotificationPreferences } from '../../../types';

/**
 * Issue #126, epic #109. Covers the pure derivation helpers this component
 * exports (`isEventChannelEnabled`, `preferenceWriteFor`, `browserChannelState`)
 * and the component's rendering of the sparse absent-key contract those
 * helpers encode. See the extensive header of
 * `components/settings/NotificationSettings.tsx` for the rules under test.
 */

const WELCOME: NotificationEventDef = {
  key: 'user.welcome',
  label: 'Welcome',
  description: 'Sent once, the first time you sign in to this application.',
  channels: ['email'],
  defaultEnabled: true,
  mandatory: false,
};

// A defaultEnabled: false event, so preferenceWriteFor's "opting IN" direction
// has something real to exercise - none of the seeded registry events in the
// API declare one, so this is synthetic on purpose.
const WEEKLY_DIGEST: NotificationEventDef = {
  key: 'weekly.digest',
  label: 'Weekly digest',
  description: 'A weekly summary of activity.',
  channels: ['email'],
  defaultEnabled: false,
  mandatory: false,
};

const ROLE_CHANGED: NotificationEventDef = {
  key: 'security.role_changed',
  label: 'Your roles changed',
  description: 'Sent when an administrator changes your roles.',
  channels: ['email', 'browser'],
  defaultEnabled: true,
  mandatory: true,
};

describe('isEventChannelEnabled', () => {
  it('resolves to the registry default when preferences is undefined - the untouched-account case', () => {
    expect(isEventChannelEnabled(WELCOME, 'email', undefined)).toBe(true);
    expect(isEventChannelEnabled(WEEKLY_DIGEST, 'email', undefined)).toBe(false);
  });

  it('resolves to the registry default when the channel has no entry at all', () => {
    const prefs: NotificationPreferences = {
      browser: { 'security.role_changed': false },
    };
    expect(isEventChannelEnabled(WELCOME, 'email', prefs)).toBe(true);
  });

  it('resolves to the registry default when the event key is absent from a present channel', () => {
    const prefs: NotificationPreferences = { email: { 'some.other.event': false } };
    expect(isEventChannelEnabled(WELCOME, 'email', prefs)).toBe(true);
  });

  it('honours an explicit stored false, even against a true default', () => {
    const prefs: NotificationPreferences = { email: { 'user.welcome': false } };
    expect(isEventChannelEnabled(WELCOME, 'email', prefs)).toBe(false);
  });

  it('honours an explicit stored true, even against a false default', () => {
    const prefs: NotificationPreferences = { email: { 'weekly.digest': true } };
    expect(isEventChannelEnabled(WEEKLY_DIGEST, 'email', prefs)).toBe(true);
  });

  it('a mandatory event resolves to enabled on every channel, ignoring a stored false', () => {
    const prefs: NotificationPreferences = {
      email: { 'security.role_changed': false },
      browser: { 'security.role_changed': false },
    };
    expect(isEventChannelEnabled(ROLE_CHANGED, 'email', prefs)).toBe(true);
    expect(isEventChannelEnabled(ROLE_CHANGED, 'browser', prefs)).toBe(true);
  });

  it('uses hasOwnProperty, not a prototype lookup - an event key like "constructor" must not resolve off Object.prototype', () => {
    const trap: NotificationEventDef = { ...WELCOME, key: 'constructor' };
    const prefs: NotificationPreferences = { email: {} };
    // An empty channel object naively indexed with `channelPrefs['constructor']`
    // would return `Object.prototype.constructor` (a function, not undefined),
    // and `typeof choice === 'boolean'` would then be false, silently falling
    // through to the default anyway - so this also pins that the fallback is
    // for the RIGHT reason (own-property check), not an accident of the
    // boolean guard alone.
    expect(isEventChannelEnabled(trap, 'email', prefs)).toBe(true);
  });

  it('falls back to the registry default when the stored value is not a boolean', () => {
    const prefs = { email: { 'user.welcome': 'yes' } } as unknown as NotificationPreferences;
    expect(isEventChannelEnabled(WELCOME, 'email', prefs)).toBe(true);
  });
});

describe('preferenceWriteFor', () => {
  it('un-muting a defaultEnabled:true event back to true sends null (a delete), never the literal true', () => {
    expect(preferenceWriteFor(WELCOME, true)).toBeNull();
  });

  it('muting a defaultEnabled:true event sends the explicit false', () => {
    expect(preferenceWriteFor(WELCOME, false)).toBe(false);
  });

  it('opting a defaultEnabled:false event back OUT to false sends null (a delete), never the literal false', () => {
    expect(preferenceWriteFor(WEEKLY_DIGEST, false)).toBeNull();
  });

  it('opting IN to a defaultEnabled:false event sends the explicit true', () => {
    expect(preferenceWriteFor(WEEKLY_DIGEST, true)).toBe(true);
  });
});

describe('browserChannelState', () => {
  it('granted: nothing disabled, nothing to say', () => {
    expect(browserChannelState('granted')).toEqual({
      disabled: false,
      note: null,
      alert: null,
    });
  });

  it('default: not disabled - a stored preference is still meaningful before permission is granted', () => {
    const state = browserChannelState('default');
    expect(state.disabled).toBe(false);
    expect(state.alert).not.toBeNull();
  });

  it('denied and unsupported are both disabled, but are not the same state', () => {
    const denied = browserChannelState('denied');
    const unsupported = browserChannelState('unsupported');

    expect(denied.disabled).toBe(true);
    expect(unsupported.disabled).toBe(true);

    // THE PAIR THIS TEST EXISTS FOR. Both look similar on screen (disabled,
    // with a banner) but the remedies are completely different - "change your
    // browser's site settings" vs. "there is nothing to configure, get a
    // different browser" - so the copy must differ, not just the boolean.
    expect(denied.note).not.toBe(unsupported.note);
    expect(denied.alert?.title).not.toBe(unsupported.alert?.title);
    expect(denied.alert?.body).not.toBe(unsupported.alert?.body);
  });

  it('denied names the browser-settings remedy, which this app cannot perform itself', () => {
    const state = browserChannelState('denied');
    expect(state.alert?.severity).toBe('warning');
    expect(state.alert?.body.toLowerCase()).toContain('browser settings');
  });

  it('unsupported does not claim the user blocked anything - there is nothing to allow', () => {
    const state = browserChannelState('unsupported');
    expect(state.alert?.severity).toBe('info');
    expect(state.alert?.body.toLowerCase()).not.toContain('block');
  });
});

describe('NotificationSettings component', () => {
  const onToggle = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "no notifications" when the registry is empty, rather than an empty matrix', () => {
    render(
      <NotificationSettings
        events={[]}
        preferences={undefined}
        onToggle={onToggle}
        browserPermission="granted"
      />,
    );

    expect(
      screen.getByText(/does not send any notifications yet/i),
    ).toBeInTheDocument();
  });

  it('an untouched account (preferences undefined) renders every control at its registry default', () => {
    render(
      <NotificationSettings
        events={[WELCOME, WEEKLY_DIGEST]}
        preferences={undefined}
        onToggle={onToggle}
        browserPermission="granted"
      />,
    );

    expect(
      screen.getByRole('switch', { name: /email notifications for welcome/i }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /email notifications for weekly digest/i }),
    ).not.toBeChecked();
  });

  it('toggling a switch calls onToggle with the channel, the event, and the null-delete when returning to default', async () => {
    const user = userEvent.setup();
    render(
      <NotificationSettings
        events={[WELCOME]}
        preferences={{ email: { 'user.welcome': false } }}
        onToggle={onToggle}
        browserPermission="granted"
      />,
    );

    const toggle = screen.getByRole('switch', { name: /email notifications for welcome/i });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('email', WELCOME, null);
  });

  it('toggling a switch away from the default sends the explicit boolean', async () => {
    const user = userEvent.setup();
    render(
      <NotificationSettings
        events={[WELCOME]}
        preferences={undefined}
        onToggle={onToggle}
        browserPermission="granted"
      />,
    );

    const toggle = screen.getByRole('switch', { name: /email notifications for welcome/i });
    expect(toggle).toBeChecked();

    await user.click(toggle);

    expect(onToggle).toHaveBeenCalledWith('email', WELCOME, false);
  });

  describe('mandatory events', () => {
    it('renders visibly locked, with the "Always on" chip and the reason', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
        />,
      );

      expect(screen.getByText('Always on')).toBeInTheDocument();
      expect(
        screen.getByText(/this is a security notification and cannot be turned off/i),
      ).toBeInTheDocument();
    });

    it('disables every channel the event declares, not just one', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /email notifications for your roles changed/i }),
      ).toBeDisabled();
      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).toBeDisabled();
    });

    it('a stale stored false for a mandatory event still renders ON - that is what the user actually receives', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={{
            email: { 'security.role_changed': false },
            browser: { 'security.role_changed': false },
          }}
          onToggle={onToggle}
          browserPermission="granted"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /email notifications for your roles changed/i }),
      ).toBeChecked();
      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).toBeChecked();
    });

    it('clicking a disabled mandatory switch never calls onToggle', async () => {
      // `pointerEventsCheck: 0` skips userEvent's CSS `pointer-events: none`
      // guard (MUI's `Mui-disabled` class), so this exercises the layer that
      // actually matters here: the native `disabled` attribute on the
      // `<input>` itself. `fireEvent.click` was deliberately NOT used - jsdom
      // still runs a checkbox's default (de)activation behaviour for a
      // `dispatchEvent`-driven click even when `disabled` is set, which
      // would make this assertion pass for the wrong reason. `userEvent`
      // simulates a real user's pointer interaction, which browsers do not
      // deliver to a disabled control at all.
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="granted"
        />,
      );

      const toggle = screen.getByRole('switch', {
        name: /email notifications for your roles changed/i,
      });
      expect(toggle).toBeDisabled();

      await user.click(toggle);

      expect(onToggle).not.toHaveBeenCalled();
    });
  });

  describe('browser channel permission states', () => {
    it('disables the browser switch, with a note, when permission is denied', () => {
      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="denied"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /browser notifications for your roles changed/i }),
      ).toBeDisabled();
      expect(screen.getByText('Browser notifications are blocked')).toBeInTheDocument();
    });

    it('does not disable the email switch when the browser channel is denied - email is unaffected', () => {
      const emailOnly: NotificationEventDef = { ...WELCOME };
      render(
        <NotificationSettings
          events={[emailOnly, ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="denied"
        />,
      );

      expect(
        screen.getByRole('switch', { name: /email notifications for welcome/i }),
      ).not.toBeDisabled();
    });

    it('does NOT call Notification.requestPermission when rendered with a "default" permission', () => {
      const originalNotification = (window as any).Notification;
      const requestPermission = vi.fn();
      (window as any).Notification = { permission: 'default', requestPermission };

      render(
        <NotificationSettings
          events={[ROLE_CHANGED]}
          preferences={undefined}
          onToggle={onToggle}
          browserPermission="default"
        />,
      );

      expect(requestPermission).not.toHaveBeenCalled();
      expect(
        screen.getByText('Browser notifications need your permission'),
      ).toBeInTheDocument();

      (window as any).Notification = originalNotification;
    });
  });

  it('isSaving disables every switch, not just the one that changed', () => {
    render(
      <NotificationSettings
        events={[WELCOME, WEEKLY_DIGEST]}
        preferences={undefined}
        onToggle={onToggle}
        isSaving
        browserPermission="granted"
      />,
    );

    expect(
      screen.getByRole('switch', { name: /email notifications for welcome/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('switch', { name: /email notifications for weekly digest/i }),
    ).toBeDisabled();
  });
});
