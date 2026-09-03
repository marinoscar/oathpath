/**
 * `/settings/notifications` — the "When should I check in?" section (#143,
 * epic #56 / E7 "Habit").
 *
 * A sibling suite to `UserNotificationsPage.test.tsx` rather than an addition
 * to it, because it needs the opposite fixture: that file MOCKS
 * `useUserSettings` so it can assert the arguments the matrix hands the save
 * function, while everything below is about the REQUEST — what is on the wire,
 * and, for the test that matters most here, what is not. So `useUserSettings`
 * is real, `UserSettingsSection` is real, `StudyReminderSettings` is real, and
 * `PATCH /api/user-settings` is a recorded MSW handler.
 *
 * `useNotificationEvents` and `useBrowserNotificationPermission` are mocked for
 * the same reason the sibling file mocks them: they own their own concerns and
 * their own test files, and the matrix is present here only so the copy that
 * distinguishes this control from the matrix's toggles can be read next to
 * them.
 *
 * WHAT THESE PIN, in order of what it would cost to get wrong:
 *
 *   1. RENDERING WRITES NOTHING. `study` has no `.default()` on the server for
 *      a reason (`docs/specs/habit-streaks.md` §7); a client that saves the
 *      default it renders reintroduces exactly the failure that avoids —
 *      freezing a learner at today's 9am forever, invisibly.
 *   2. THE TIME ZONE IS NAMED. The hour is interpreted by the hourly cron in
 *      `learner_profiles.timezone`, so "9:00 AM" alone is a question, not an
 *      answer.
 *   3. Both fields persist and survive a reload, and returning to the default
 *      deletes rather than pins.
 *   4. The copy says which of the two switches is being changed (§7.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import { ORIENTED_PROFILE, profileResponse } from '../utils/journey-fixtures';
import type { NotificationEventDef, UserSettings } from '../../types';

vi.mock('../../hooks/useNotificationEvents', () => ({
  useNotificationEvents: vi.fn(),
}));

vi.mock('../../hooks/useBrowserNotificationPermission', () => ({
  useBrowserNotificationPermission: vi.fn(),
}));

import { useNotificationEvents } from '../../hooks/useNotificationEvents';
import { useBrowserNotificationPermission } from '../../hooks/useBrowserNotificationPermission';
import { LearnerProfileProvider } from '../../contexts/LearnerProfileContext';
import UserNotificationsPage from '../../pages/UserNotificationsPage';

const mockUseNotificationEvents = vi.mocked(useNotificationEvents);
const mockUseBrowserNotificationPermission = vi.mocked(
  useBrowserNotificationPermission,
);

/** One real registry event, so the matrix renders a per-event channel toggle. */
const DAILY_REMINDER: NotificationEventDef = {
  key: 'practice.daily_reminder',
  label: 'Time to practice',
  description: 'A short nudge on a day you have not practised yet.',
  channels: ['email'],
  defaultEnabled: true,
  mandatory: false,
};

/**
 * The stored settings document, mutated by the PATCH handler.
 *
 * A real document rather than a fresh fixture per request: "survives a reload"
 * is only a claim if the second `GET` can see what the first `PATCH` did.
 */
let stored: UserSettings;

/** Every `PATCH /user-settings` body, in order. THE SPY THE SUITE TURNS ON. */
let patchBodies: Array<Record<string, unknown>>;

function mockApi() {
  stored = {
    theme: 'system',
    profile: { useProviderImage: true },
    updatedAt: '2026-09-01T00:00:00.000Z',
    version: 1,
    // No `study` key at all — the untouched account, which is the normal case.
  };
  patchBodies = [];

  server.use(
    http.get('*/api/journey/profile', () =>
      HttpResponse.json({ data: profileResponse(ORIENTED_PROFILE) }),
    ),
    http.get('*/api/user-settings', () => HttpResponse.json({ data: stored })),
    http.patch('*/api/user-settings', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patchBodies.push(body);

      // Field-wise merge of the `study` namespace with `null` as DELETE — what
      // the API does (`habit-streaks.md` §7, `navigation`'s codepath). Modelled
      // rather than shortcut to `{...stored, ...body}` so a test that sends a
      // null-delete gets the absence back on the next read, exactly as it would
      // from the real server.
      if ('study' in body) {
        const patch = body.study as Record<string, unknown> | null;
        if (patch === null) {
          delete stored.study;
        } else {
          const next = { ...(stored.study ?? {}) } as Record<string, unknown>;
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) delete next[key];
            else next[key] = value;
          }
          stored.study = Object.keys(next).length > 0 ? next : undefined;
        }
      }

      stored = { ...stored, version: stored.version + 1 };
      return HttpResponse.json({ data: stored });
    }),
  );
}

function renderPage() {
  return render(
    <LearnerProfileProvider>
      <UserNotificationsPage />
    </LearnerProfileProvider>,
  );
}

/** Resolves once the settings document has loaded and the section is on screen. */
async function findHourSelect(): Promise<HTMLSelectElement> {
  return (await screen.findByLabelText('Reminder time')) as HTMLSelectElement;
}

describe('UserNotificationsPage — the reminder section (#143)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi();
    mockUseNotificationEvents.mockReturnValue({
      events: [DAILY_REMINDER],
      isLoading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    mockUseBrowserNotificationPermission.mockReturnValue({
      permission: 'granted',
      refresh: vi.fn(),
    });
  });

  // ===========================================================================
  // THE RULE: absent means the built-in default, and the client honours it
  // ===========================================================================

  it('writes nothing when the page is merely rendered — the default is displayed, never persisted', async () => {
    renderPage();

    // The section is on screen with the default already showing…
    const select = await findHourSelect();
    expect(select.value).toBe('9');
    expect(screen.getByLabelText('Remind me to practice')).toBeChecked();

    // …and the profile read has settled, so nothing is still in flight that
    // could write after this assertion.
    // (Two matches — the helper text and the status line — so `findAll`.)
    await screen.findAllByText(/America\/Los_Angeles/);

    // THE ASSERTION THIS TEST EXISTS FOR. A `.default()` on the client — a
    // local defaulted object that a later save serialises, or a save-on-mount —
    // would show up here and nowhere else on screen.
    expect(patchBodies).toEqual([]);
    expect(stored.study).toBeUndefined();
  });

  it('shows an untouched account the built-in default without storing it', async () => {
    renderPage();

    const select = await findHourSelect();
    expect(select.value).toBe('9');
    expect(
      screen.getByRole('status').textContent,
    ).toContain('9:00 AM');

    // The document the server holds is still the one it started with: no
    // `study` key, so the SERVER keeps resolving the hour at reminder time and
    // a future change to the built-in default still reaches this learner.
    expect(stored.study).toBeUndefined();
    expect(patchBodies).toEqual([]);
  });

  // ===========================================================================
  // The zone the hour is read in
  // ===========================================================================

  it("names the learner's own time zone beside the hour control", async () => {
    renderPage();

    const select = await findHourSelect();

    // Beside the control, not somewhere else on the page: the helper text the
    // select itself is described by.
    const field = select.closest('.MuiFormControl-root') as HTMLElement;
    expect(within(field).getByText(/America\/Los_Angeles/)).toBeInTheDocument();

    // And in the sentence that reports what is stored, so the announced result
    // carries the zone too.
    expect(screen.getByRole('status').textContent).toContain(
      'America/Los_Angeles',
    );
  });

  // ===========================================================================
  // Persistence
  // ===========================================================================

  it('persists a chosen hour through PATCH /user-settings and shows it after a reload', async () => {
    const user = userEvent.setup();
    const view = renderPage();

    await user.selectOptions(await findHourSelect(), '18');

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ study: { reminderHour: 18 } });

    // The reload: a fresh mount reading the document the PATCH left behind.
    view.unmount();
    renderPage();

    const reloaded = await findHourSelect();
    await waitFor(() => expect(reloaded.value).toBe('18'));
    expect(screen.getByRole('status').textContent).toContain('6:00 PM');
  });

  it('persists turning check-ins off, and shows them off after a reload', async () => {
    const user = userEvent.setup();
    const view = renderPage();

    await findHourSelect();
    await user.click(screen.getByLabelText('Remind me to practice'));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ study: { reminderEnabled: false } });

    view.unmount();
    renderPage();

    await waitFor(() =>
      expect(screen.getByLabelText('Remind me to practice')).not.toBeChecked(),
    );
    // Inert rather than gone: a learner turning check-ins back on can still see
    // the hour they would return at.
    expect(await findHourSelect()).toBeDisabled();
  });

  it('sends a null-delete when a control is moved back to the built-in default', async () => {
    const user = userEvent.setup();
    renderPage();

    const select = await findHourSelect();
    await user.selectOptions(select, '18');
    await waitFor(() => expect(patchBodies).toHaveLength(1));

    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('18'));
    await user.selectOptions(select, '9');

    await waitFor(() => expect(patchBodies).toHaveLength(2));
    // NOT `{ reminderHour: 9 }`. Writing today's default pins this learner to
    // it forever; deleting the key returns them to "no opinion".
    expect(patchBodies[1]).toEqual({ study: { reminderHour: null } });
    await waitFor(() => expect(stored.study).toBeUndefined());
  });

  // ===========================================================================
  // The copy (§7.1)
  // ===========================================================================

  it('says which control is being changed, distinguishing it from the per-event channel toggles', async () => {
    renderPage();
    await findHourSelect();

    // The section names the coarse switch in the learner's words…
    expect(
      screen.getByRole('heading', { name: 'When should I check in?', level: 2 }),
    ).toBeInTheDocument();

    const scope = screen.getByText(/Turning it off here stops all study/i);
    expect(scope.textContent).toMatch(/the daily nudge/i);
    expect(scope.textContent).toMatch(/a streak about to lapse/i);

    // …and says what the matrix's own toggles do instead, which is the narrower
    // thing: one message, one channel.
    expect(scope.textContent).toMatch(
      /only silences that one message on that one channel/i,
    );

    // The narrower control it is being distinguished FROM is really on the page,
    // so the sentence above is about something the learner can see.
    expect(
      screen.getByLabelText('Email notifications for Time to practice'),
    ).toBeInTheDocument();
  });
});
