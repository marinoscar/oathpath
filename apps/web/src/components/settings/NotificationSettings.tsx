/**
 * The event x channel notification preferences matrix.
 *
 * Issue #126, epic #109. Rendered by `pages/UserNotificationsPage.tsx` at
 * `/settings/notifications`.
 *
 * =============================================================================
 * THE SPARSE ABSENT-KEY CONTRACT — READ THIS BEFORE CHANGING ANYTHING HERE
 * =============================================================================
 *
 * The stored document is `user_settings.value.notifications`, channel-outer:
 *
 *     { email: { 'user.welcome': false }, browser: { ... } }
 *
 * A key is present ONLY where the user deliberately chose. Absent — at the
 * namespace, the channel, or the event level — means "use the registry's
 * `defaultEnabled`", resolved at read time by the API
 * (`notifications/notification-preferences.ts`). Three properties depend on
 * that, and each breaks in a way nobody notices for weeks:
 *
 *   1. NO MIGRATION, NO BACKFILL. The feature shipped by reading a key that
 *      does not exist for anybody.
 *   2. NOBODY IS MUTED ON ARRIVAL. Every pre-existing account has no
 *      `notifications` namespace at all; if absent meant "off", the framework
 *      would ship silent for the entire user base, and the only symptom would
 *      be mail nobody receives — a failure with no error anywhere.
 *   3. AN EVENT ADDED LATER IS OPT-OUT, NOT SILENTLY OFF. A user who saved a
 *      preference today has a stored map that says nothing about an event
 *      declared next year; absent-means-default gives them that event's
 *      intended default, where a materialised blob would give them "not in my
 *      map, therefore off".
 *
 * THREE RULES THIS FILE ENFORCES, EACH THE PRECISE OPPOSITE OF THE OBVIOUS
 * IMPLEMENTATION:
 *
 *   A. EVERY CONTROL DERIVES ITS STATE (see `isEventChannelEnabled`) from the
 *      fetched preferences compared against the registry's `defaultEnabled`.
 *      There is NO local `Record<event, boolean>` state in this component, and
 *      there must never be one. The moment a defaulted local object exists, the
 *      first save serialises it and materialises every key in it.
 *
 *   B. NEVER WRITE A FULL PREFERENCES OBJECT — not on mount, not on first
 *      change. Each toggle emits exactly the one `(channel, event, value)` it
 *      changed and the page PATCHes that single key; the API deep-merges per
 *      event, so everything else stays absent.
 *
 *   C. RETURNING A CONTROL TO ITS DEFAULT SENDS A NULL-DELETE (see
 *      `preferenceWriteFor`), never the default value. Writing the default
 *      explicitly works today, and it opts that user in permanently: the key is
 *      materialised, the blob grows for no reason, and if the default ever
 *      changes that user is frozen at the old one with nothing to show why.
 *
 * NO SAVE BUTTON, DELIBERATELY. A batched save needs a full local mirror to
 * diff against, which is exactly the shape that ends up POSTing a materialised
 * object — rule A and rule B fall together the moment a Save button appears.
 * Every toggle is its own PATCH and its own snackbar.
 *
 * =============================================================================
 * RESPONSIVE WITHOUT A BREAKPOINT GATE
 * =============================================================================
 *
 * There is no `useMediaQuery` here and no `display: { xs, sm }` switch between
 * two layouts. `CLAUDE.md` names five coupled breakpoint gates that move
 * together or not at all (`Layout.tsx`'s `showRail`, `BottomNav`'s self-gate,
 * `<main>`'s padding, and `isCompactWindow` in both `SettingsHub.tsx` and
 * `AppBar.tsx`); a sixth gate here would be a sixth thing to keep in lockstep
 * for no gain.
 *
 * Instead each row is ONE flex container that wraps: the event's label and
 * description take the left, the channel switches the right, and on a narrow
 * viewport the switches simply flow underneath. Every switch carries its own
 * visible channel label, so the matrix is self-describing at every width — no
 * column header row that has to survive being wrapped away, which is precisely
 * where a table layout breaks down in a 320px drill-down.
 */

import { useId } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import type {
  NotificationChannel,
  NotificationEventDef,
  NotificationPreferences,
} from '../../types';
import type { BrowserNotificationPermission } from '../../hooks/useBrowserNotificationPermission';

// =============================================================================
// Derivation — the pure half, exported so it can be reasoned about and tested
// without a DOM.
// =============================================================================

/**
 * Is this event enabled on this channel, for this user?
 *
 * THE MIRROR OF THE API'S `isChannelEnabled`, function for function, including
 * the order of its checks — `mandatory` first, then the three-level fallback.
 * Two implementations of one rule is a drift risk, and it is accepted here for
 * one reason: the alternative is a per-user "resolved preferences" endpoint,
 * i.e. the server materialising exactly the defaulted object this whole design
 * refuses to store. The UI reads the raw sparse document and applies the same
 * rule; the SERVER's copy remains the only one that decides delivery, so a
 * drift shows as a wrong checkbox, never as a wrong send.
 *
 * `mandatory` is checked BEFORE the stored value, so a preference row that
 * disables a mandatory event — one written before the event became mandatory,
 * or by a crafted PATCH — renders as ON, which is what the user will actually
 * receive. Rendering the stored `false` there would be an honest reading of the
 * document and a lie about the behaviour.
 *
 * @param preferences the raw stored namespace, or `undefined` when the user has
 *                    never saved a preference — the single most common case.
 */
export function isEventChannelEnabled(
  event: NotificationEventDef,
  channel: NotificationChannel,
  preferences: NotificationPreferences | undefined,
): boolean {
  if (event.mandatory) return true;

  const channelPrefs = preferences?.[channel];
  // Level 1: no namespace, or nothing stored for this channel.
  if (!channelPrefs) return event.defaultEnabled;

  // Level 2: `hasOwnProperty`, never `channelPrefs[key] !== undefined` and
  // never a truthiness test. A stored `false` is a real, deliberate choice and
  // must not collapse into "absent"; and an own-property check is also what
  // keeps an event key like `constructor` or `toString` from resolving to a
  // function off `Object.prototype`. This object came out of a user-writable
  // JSONB column, so that is not hypothetical.
  if (!Object.prototype.hasOwnProperty.call(channelPrefs, event.key)) {
    return event.defaultEnabled;
  }

  // Level 3: honour it only if it is a boolean. Anything else was not written
  // by this system, so it is not a choice this system will honour.
  const choice = channelPrefs[event.key];
  return typeof choice === 'boolean' ? choice : event.defaultEnabled;
}

/**
 * What to send for a control the user has just moved to `nextEnabled`.
 *
 * `null` is a JSON Merge Patch DELETE and is the WHOLE POINT of this function:
 * when the new state equals the registry default, the correct write is to
 * remove the key and return the user to "no opinion", not to pin today's
 * default into their document. See rule C in the file header.
 *
 * Both directions matter, which is why this compares against `defaultEnabled`
 * rather than special-casing "re-enabling":
 *   * default `true`, user muted it, user un-mutes  -> next `true`  -> DELETE
 *   * default `false`, user opted in, user opts out -> next `false` -> DELETE
 * and a first, non-default change stores the explicit boolean.
 */
export function preferenceWriteFor(
  event: NotificationEventDef,
  nextEnabled: boolean,
): boolean | null {
  return nextEnabled === event.defaultEnabled ? null : nextEnabled;
}

// =============================================================================
// Channel presentation
// =============================================================================

/**
 * The visible label per channel.
 *
 * Keyed by the channels this build knows about. `channelLabel` is DEFENSIVE
 * about the lookup — a newer server can declare a channel this bundle has
 * never heard of (the registry is server-owned, which is the entire point of
 * fetching it rather than mirroring it), and the right behaviour then is to
 * render the raw key rather than put an empty label on a live control.
 */
const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: 'Email',
  browser: 'Browser',
};

function channelLabel(channel: NotificationChannel): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/**
 * How the browser column must behave for a given permission state.
 *
 * SEPARATED FROM THE JSX so the honest answer to "what does `denied` do?" is
 * one readable table rather than three ternaries spread through a render.
 *
 * `disabled` is true only where the app genuinely cannot deliver AND cannot
 * recover:
 *   * `denied`      — the browser refused; nothing this application does can
 *                     undo that, only the user in their browser's site
 *                     settings. A control that looks live but can never take
 *                     effect is worse than one that explains itself.
 *   * `unsupported` — no `Notification` API at all. Nothing to configure.
 *   * `default`     — NOT disabled. The permission has not been asked for yet,
 *                     and the stored preference is still meaningful: it is what
 *                     takes effect the moment permission is granted. Disabling
 *                     it would force the user to grant permission before they
 *                     are allowed to express an opinion, which is backwards.
 *   * `granted`     — nothing to say.
 */
interface BrowserChannelState {
  disabled: boolean;
  /** Terse note beside the control. `null` when there is nothing to add. */
  note: string | null;
  /** The banner above the matrix. `null` when the channel is fully working. */
  alert: { severity: 'info' | 'warning'; title: string; body: string } | null;
}

export function browserChannelState(
  permission: BrowserNotificationPermission,
): BrowserChannelState {
  switch (permission) {
    case 'granted':
      return { disabled: false, note: null, alert: null };
    case 'denied':
      return {
        disabled: true,
        note: 'Blocked by your browser',
        alert: {
          severity: 'warning',
          title: 'Browser notifications are blocked',
          // Names the remedy AND who owns it. This application cannot re-ask
          // for a permission the user has denied, so telling them to "try
          // again here" would be a lie.
          body:
            'Your browser is blocking notifications from this site, so these ' +
            'preferences cannot take effect. Allow notifications for this site ' +
            'in your browser settings to turn them back on.',
        },
      };
    case 'unsupported':
      return {
        disabled: true,
        note: 'Not supported by this browser',
        alert: {
          severity: 'info',
          title: 'This browser cannot show notifications',
          body:
            'Browser notifications need a browser that supports them over a ' +
            'secure (HTTPS) connection. Email notifications are unaffected.',
        },
      };
    case 'default':
    default:
      return {
        disabled: false,
        note: 'Permission not granted yet',
        alert: {
          severity: 'info',
          title: 'Browser notifications need your permission',
          body:
            'Your browser has not been asked for permission yet, so these ' +
            'notifications will not appear until you allow them. Your choices ' +
            'here are saved and take effect as soon as permission is granted.',
        },
      };
  }
}

// =============================================================================
// Component
// =============================================================================

export interface NotificationSettingsProps {
  /**
   * The registry, in server order. Rendered as given and NEVER sorted — the
   * order is meaningful and is the API's to decide.
   */
  events: NotificationEventDef[];
  /**
   * The raw stored namespace. `undefined` when the user has never saved a
   * preference, which is the normal case and is NOT a loading state — every
   * control resolves to its registry default.
   */
  preferences: NotificationPreferences | undefined;
  /**
   * One toggle happened. `value` is the boolean to store, or `null` to DELETE
   * the key and restore the registry default (see `preferenceWriteFor`).
   *
   * The caller turns this into `{ notifications: { [channel]: { [key]: value } } }`
   * — one channel, one key, nothing else on the wire.
   */
  onToggle: (channel: NotificationChannel, event: NotificationEventDef, value: boolean | null) => void;
  /**
   * A save is in flight. EVERY control is disabled, not just the one that was
   * clicked, and that is on purpose: `useUserSettings` sends `If-Match` with
   * the settings version it currently holds, so two toggles racing produce two
   * PATCHes with the same expected version and the second 409s. Serialising
   * them costs a few hundred milliseconds and removes the conflict entirely.
   */
  isSaving?: boolean;
  /** Live `Notification.permission`, from `useBrowserNotificationPermission`. */
  browserPermission: BrowserNotificationPermission;
  /**
   * Ask the browser for notification permission (#127).
   *
   * FILLS THE SEAM #126 LEFT in the `default`-state banner below. The component
   * does NOT call `Notification.requestPermission()` itself — it raises this
   * callback from a click, and the page owns the call plus the `refresh()` that
   * follows it. That split is what keeps the prompt out of this component's
   * render path entirely: there is no code here that COULD fire it on mount,
   * because the API call is not in this file.
   *
   * Optional, and the button is only rendered when it is supplied. A promptless
   * host renders the same honest banner #126 shipped.
   */
  onRequestPermission?: () => void;
  /**
   * The permission prompt is open. Disables the button so a second click cannot
   * stack a second request behind the browser's modal.
   */
  isRequestingPermission?: boolean;
}

export function NotificationSettings({
  events,
  preferences,
  onToggle,
  isSaving = false,
  browserPermission,
  onRequestPermission,
  isRequestingPermission = false,
}: NotificationSettingsProps) {
  // `useId` rather than interpolating `event.key`: two instances of this
  // component (or a future second matrix on the page) would otherwise emit
  // duplicate ids, and a duplicated id silently points every `aria-describedby`
  // at the first match.
  const idPrefix = useId();

  const browser = browserChannelState(browserPermission);

  // Only relevant if some event actually declares the channel. Today only
  // `security.role_changed` does, and an event list that declares none must not
  // show a banner about a column that is not on screen.
  const showsBrowserChannel = events.some((event) => event.channels.includes('browser'));

  if (events.length === 0) {
    // A REAL ANSWER, not a loading state — the caller renders a spinner while
    // the registry is unknown. An empty matrix with no explanation reads as a
    // page that failed to load.
    return (
      <Alert severity="info">
        This application does not send any notifications yet.
      </Alert>
    );
  }

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Notifications
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Choose what reaches you, and how. Changes are saved as you make them.
        </Typography>

        {showsBrowserChannel && browser.alert && (
          <Alert severity={browser.alert.severity} sx={{ mb: 2 }}>
            <AlertTitle>{browser.alert.title}</AlertTitle>
            {browser.alert.body}
            {/*
              ===================================================================
              THE PERMISSION PROMPT (#127) — FILLING THE SEAM #126 MARKED HERE
              ===================================================================
              Rendered ONLY in the `default` state: `granted` has nothing to ask
              for, and in `denied` / `unsupported` a button would be a lie —
              neither is recoverable from inside this application, which is why
              `browserChannelState` gives those two an explanatory alert and no
              action.

              THE CLICK IS THE WHOLE MECHANISM. `Notification.requestPermission()`
              runs from this handler and NOWHERE ELSE in the app:

                * A DENIAL IS EFFECTIVELY PERMANENT. Nothing this application
                  does can undo it — only the user, in browser site settings. The
                  prompt is a ONE-SHOT RESOURCE, so spending it on somebody who
                  never asked for notifications kills the feature for them for
                  good.
                * Browsers actively penalise gestureless prompts: Chrome demotes
                  them to a quiet UI, Firefox requires the gesture outright, and
                  Safari throws. A prompt on mount frequently never reaches the
                  user while still burning the coin.

              DO NOT MOVE THIS CALL TO MOUNT, AN EFFECT, A TIMER, OR A ROUTE
              TRANSITION. The button sits inside the banner that explains what it
              does, on a page the user navigated to deliberately, which is the
              only context in which asking is fair.

              The state afterwards is re-read through
              `useBrowserNotificationPermission().refresh()` in
              `UserNotificationsPage`, so this banner becomes the `granted` or
              `denied` treatment without a reload — including the case where the
              user dismisses the prompt without choosing, which leaves the
              permission at `default` and correctly leaves this button in place.
            */}
            {browserPermission === 'default' && onRequestPermission && (
              <Box sx={{ mt: 1.5 }}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={onRequestPermission}
                  disabled={isRequestingPermission}
                  startIcon={
                    isRequestingPermission ? <CircularProgress size={16} /> : undefined
                  }
                >
                  {/* The label names the ACTION and its consequence. "Enable" or
                      "Turn on" would over-promise: this button opens the
                      browser's own prompt, and the browser — not this app —
                      decides what happens next. */}
                  {isRequestingPermission ? 'Waiting for your browser…' : 'Allow notifications'}
                </Button>
              </Box>
            )}
          </Alert>
        )}

        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {events.map((event, index) => {
            const descriptionId = `${idPrefix}-${event.key}-description`;

            return (
              <Box component="li" key={event.key}>
                {index > 0 && <Divider />}

                {/*
                  ONE WRAPPING FLEX ROW — see the header. The label block has a
                  flex BASIS rather than a width so it takes the leftover space
                  on a desktop and drops the switches onto their own line on a
                  phone, with no breakpoint gate deciding which.
                */}
                <Box
                  sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    py: 2,
                  }}
                >
                  <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <Typography variant="subtitle1" component="h3">
                        {event.label}
                      </Typography>
                      {event.mandatory && (
                        // VISIBLY LOCKED, WITH THE REASON. The alternative —
                        // hiding the row, or leaving a switch that silently
                        // refuses — is what epic #109's success criterion 5
                        // rules out: a user who cannot find the security alert
                        // in their preferences assumes it is not being sent,
                        // and a control that does nothing when clicked reads as
                        // a bug rather than as a policy.
                        <Chip
                          size="small"
                          icon={<LockIcon fontSize="small" />}
                          label="Always on"
                        />
                      )}
                    </Box>
                    <Typography id={descriptionId} variant="body2" color="text.secondary">
                      {event.description}
                      {event.mandatory && (
                        <>
                          {' '}
                          <Box component="span" sx={{ fontStyle: 'italic' }}>
                            This is a security notification and cannot be turned off.
                          </Box>
                        </>
                      )}
                    </Typography>
                  </Box>

                  <Box
                    sx={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'flex-start',
                      columnGap: 2,
                      rowGap: 0.5,
                    }}
                  >
                    {/*
                      ONLY THE CHANNELS THIS EVENT DECLARES. Rendering the full
                      channel set for every row would offer, for instance, a
                      browser toggle for `allowlist.invitation` — whose
                      recipient has no session and no open tab by definition.
                    */}
                    {event.channels.map((channel) => {
                      const checked = isEventChannelEnabled(event, channel, preferences);
                      const isBrowser = channel === 'browser';
                      const channelDisabled = isBrowser && browser.disabled;
                      const note = isBrowser ? browser.note : null;
                      const noteId = note ? `${idPrefix}-${event.key}-${channel}-note` : undefined;

                      return (
                        <Box
                          key={channel}
                          sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}
                        >
                          <FormControlLabel
                            // `mandatory` disables EVERY channel, not "all but
                            // one": the API resolves a mandatory event as
                            // all-or-nothing, so a per-channel opt-out here
                            // would render a choice the server ignores.
                            disabled={isSaving || event.mandatory || channelDisabled}
                            label={channelLabel(channel)}
                            control={
                              <Switch
                                checked={checked}
                                onChange={(_e, next) =>
                                  onToggle(channel, event, preferenceWriteFor(event, next))
                                }
                                // `slotProps.input`, never `<Switch aria-label>`:
                                // MUI forwards unknown props to the ROOT span,
                                // leaving the element that actually carries
                                // `role="switch"` nameless. Same rule as
                                // `admin/featureFlagColumns.tsx`.
                                //
                                // The name is per ROW as well as per channel —
                                // "Email" alone repeats on every row and gives a
                                // screen-reader user three identically-named
                                // switches with no way to tell them apart.
                                slotProps={{
                                  input: {
                                    'aria-label': `${channelLabel(channel)} notifications for ${event.label}`,
                                    'aria-describedby': [descriptionId, noteId]
                                      .filter(Boolean)
                                      .join(' '),
                                  },
                                }}
                              />
                            }
                            sx={{ mr: 0 }}
                          />
                          {note && (
                            // The per-control half of "disabled WITH an
                            // explanation". Terse here because the banner above
                            // carries the full remedy; between them the control
                            // is never silently inert.
                            <Typography
                              id={noteId}
                              variant="caption"
                              color="text.secondary"
                              sx={{ ml: 6, mt: -0.5 }}
                            >
                              {note}
                            </Typography>
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              </Box>
            );
          })}
        </Box>
      </CardContent>
    </Card>
  );
}

export default NotificationSettings;
