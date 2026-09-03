/**
 * "When should I check in?" — the reminder-time control.
 *
 * Issue #143, epic #56 / E7 "Habit". Rendered on `/settings/notifications`
 * ALONGSIDE the event x channel matrix, never inside it.
 *
 * =============================================================================
 * WHY IT IS A SECTION ON THAT PAGE AND NOT A CELL IN THE MATRIX
 * =============================================================================
 *
 * The matrix answers "which events reach me, over which channel" — one boolean
 * per (event, channel) pair. A reminder HOUR is not a boolean and belongs to no
 * single event: it is when the hourly `PracticeReminderTask` is allowed to look
 * at this learner at all, before it has decided which of the three reminder
 * events (if any) applies. There is no cell that could hold it, so it gets its
 * own section — CONTENT inside an existing settings destination, which is why
 * this ships with no registry card, no route and no change to `destinations.ts`
 * (`CLAUDE.md`'s reachability-versus-content rule).
 *
 * =============================================================================
 * TWO SWITCHES THAT LOOK ALIKE AND ARE NOT (habit-streaks.md §7.1)
 * =============================================================================
 *
 * `study.reminderEnabled` — this control — governs whether the cron considers
 * this learner AT ALL, for any of `practice.daily_reminder`,
 * `practice.review_due` and `streak.at_risk`. Off means "stop checking in on my
 * study habit", and all three stop together.
 *
 * Muting `practice.daily_reminder` in the matrix below is narrower: the cron
 * may still select that event for this learner, it is simply not delivered,
 * while the other two stay live.
 *
 * A learner who turns off the wrong one keeps receiving exactly what they asked
 * to stop, so the copy in this component names which one is being changed. That
 * is a requirement of the design, not a nicety — do not shorten it to
 * "Notifications".
 *
 * =============================================================================
 * ABSENT MEANS THE BUILT-IN DEFAULT. NOTHING IS WRITTEN ON RENDER.
 * =============================================================================
 *
 * The same contract `NotificationSettings` keeps for the matrix, for the same
 * reason, enforced here by three properties:
 *
 *   A. THERE IS NO LOCAL STATE IN THIS COMPONENT. Both controls derive their
 *      value from the stored namespace (which is normally `undefined`) resolved
 *      against the built-in defaults below. A defaulted local object is the
 *      thing that gets serialised on the first save and materialises both keys.
 *   B. MOUNTING WRITES NOTHING. There is no effect, no save-on-render, no Save
 *      button batching a full document. A learner who opens this page and reads
 *      it has stored no opinion, and the server keeps resolving their hour at
 *      reminder time — so a later change to the default reaches them.
 *   C. MOVING A CONTROL BACK TO THE DEFAULT SENDS A NULL-DELETE (see
 *      `reminderHourWriteFor` / `reminderEnabledWriteFor`), never the default
 *      value. Writing `9` because 9 is today's default pins that learner to 9am
 *      forever, with nothing on screen to show why.
 */

import { useId } from 'react';
import {
  Box,
  Card,
  CardContent,
  FormControlLabel,
  Switch,
  TextField,
  Typography,
} from '@mui/material';

import type { StudySettings, StudySettingsPatch } from '../../types';

/**
 * The hour rendered for a learner who has chosen none.
 *
 * MIRRORS `DEFAULT_STUDY_REMINDER_HOUR` in
 * `apps/api/src/common/schemas/user-settings-namespaces.schema.ts`, and is a
 * DISPLAY default only: it is never sent, so the server's constant stays the
 * one that decides when an unopinionated learner is actually reminded. If the
 * two ever disagree, this page shows the wrong hour — it cannot cause the wrong
 * hour to be stored, because nothing stores it.
 */
export const DEFAULT_STUDY_REMINDER_HOUR = 9;

/** Mirrors `DEFAULT_STUDY_REMINDER_ENABLED`, on the same terms. */
export const DEFAULT_STUDY_REMINDER_ENABLED = true;

/**
 * The stored hour, or the built-in default.
 *
 * Own-property checked and type checked, exactly as
 * `NotificationSettings.isEventChannelEnabled` is and for the same reason: this
 * object came out of a user-writable JSONB column, so `reminderHour` could be
 * anything, and a value outside 0-23 is not a preference this build will honour
 * (the API's own schema would have rejected it).
 */
export function resolvedReminderHour(study: StudySettings | undefined): number {
  const value = study?.reminderHour;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 23
  ) {
    return DEFAULT_STUDY_REMINDER_HOUR;
  }
  return value;
}

/** The stored on/off choice, or the built-in default. A stored `false` is real. */
export function resolvedReminderEnabled(
  study: StudySettings | undefined,
): boolean {
  const value = study?.reminderEnabled;
  return typeof value === 'boolean' ? value : DEFAULT_STUDY_REMINDER_ENABLED;
}

/** What to send for an hour the learner has just picked. `null` is a DELETE. */
export function reminderHourWriteFor(hour: number): number | null {
  return hour === DEFAULT_STUDY_REMINDER_HOUR ? null : hour;
}

/** What to send for an on/off choice the learner has just made. */
export function reminderEnabledWriteFor(enabled: boolean): boolean | null {
  return enabled === DEFAULT_STUDY_REMINDER_ENABLED ? null : enabled;
}

/**
 * `9` -> `"9:00 AM"`.
 *
 * Hand-rolled rather than `Intl.DateTimeFormat`, deliberately. The value is an
 * HOUR NUMBER with no date and no zone attached — formatting it through `Intl`
 * means inventing a `Date`, which drags the browser's own zone into a control
 * whose whole point is that the hour is read in the LEARNER'S zone, named
 * beside it. A wrong offset here would be invisible and would mislead exactly
 * the learner this feature is for.
 */
export function formatReminderHour(hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:00 ${suffix}`;
}

const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

export interface StudyReminderSettingsProps {
  /**
   * THE RAW STORED NAMESPACE, `undefined` for every account that has never
   * touched it — which is the normal case. Deliberately not defaulted by the
   * caller: see rule A in the file header.
   */
  study: StudySettings | undefined;

  /**
   * The learner's IANA zone, or `null` when the profile could not be read.
   *
   * NAMED ON SCREEN, always. The hour is interpreted by the cron in this zone,
   * so a control that says "9:00 AM" without saying whose 9am is asking the
   * learner to guess.
   */
  timezone: string | null;

  /** True while a PATCH is in flight. Both controls go inert. */
  isSaving?: boolean;

  /** Emits the ONE field that changed, already reduced to its write form. */
  onChange: (patch: StudySettingsPatch) => void;
}

export function StudyReminderSettings({
  study,
  timezone,
  isSaving = false,
  onChange,
}: StudyReminderSettingsProps) {
  // `useId` rather than literal ids, so a second instance of this section could
  // never point every `aria-describedby` at the first one's copy.
  const idPrefix = useId();
  const scopeNoteId = `${idPrefix}-scope`;
  const hourId = `${idPrefix}-hour`;

  const enabled = resolvedReminderEnabled(study);
  const hour = resolvedReminderHour(study);

  const zoneHelp = timezone
    ? `Times are in ${timezone} — the time zone on your journey profile. Change it there if it's wrong.`
    : "We couldn't read your time zone just now. Reminders use the time zone on your journey profile.";

  return (
    <Card>
      <CardContent>
        {/* `component="h2"` under the page's single `h1`. The matrix below
            renders an `h6` element for its own title; this section is a sibling
            of it, not a child, so it takes the level the outline needs. */}
        <Typography variant="h6" component="h2" gutterBottom>
          When should I check in?
        </Typography>

        {/* THE DISTINCTION, IN THE LEARNER'S WORDS. This is the paragraph §7.1
            requires: which control is being changed, and what the other one
            does instead. */}
        <Typography
          id={scopeNoteId}
          variant="body2"
          color="text.secondary"
          sx={{ mb: 2 }}
        >
          A study check-in is a short nudge to keep your practice going. Turning
          it off here stops all study check-ins — the daily nudge, a review
          that&apos;s due, and a streak about to lapse. Turning off a single row
          in the list below only silences that one message on that one channel.
        </Typography>

        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'flex-start', sm: 'flex-start' },
            gap: 2,
          }}
        >
          <FormControlLabel
            disabled={isSaving}
            label="Remind me to practice"
            control={
              <Switch
                checked={enabled}
                onChange={(_event, next) =>
                  onChange({ reminderEnabled: reminderEnabledWriteFor(next) })
                }
                // `slotProps.input`, never `<Switch aria-describedby>`: MUI
                // forwards unknown props to the ROOT span, leaving the element
                // that actually carries `role="switch"` undescribed. Same rule
                // as `NotificationSettings`.
                slotProps={{ input: { 'aria-describedby': scopeNoteId } }}
              />
            }
          />

          {/* A NATIVE select, for the same reason `JourneyProfileForm` uses one
              for its 56 states: twenty-four options is where a phone's own
              picker stops being a downgrade. It also gives the control a real
              `<label>` through `TextField`'s own labelling. */}
          <TextField
            id={hourId}
            select
            label="Reminder time"
            value={String(hour)}
            // Inert, not hidden, when check-ins are off: hiding it would make
            // the stored hour disappear from the page, and a learner turning
            // reminders back on could not tell what time they would return at.
            disabled={isSaving || !enabled}
            onChange={(event) =>
              onChange({
                reminderHour: reminderHourWriteFor(Number(event.target.value)),
              })
            }
            helperText={zoneHelp}
            sx={{ minWidth: { xs: '100%', sm: 220 } }}
            slotProps={{
              select: { native: true },
              inputLabel: { shrink: true },
            }}
          >
            {HOURS.map((value) => (
              <option key={value} value={value}>
                {formatReminderHour(value)}
              </option>
            ))}
          </TextField>
        </Box>

        {/* THE RESULT OF A SAVE, ANNOUNCED. This renders the SERVER's answer —
            it is derived from the settings document the PATCH response replaced
            it with — so what it says is what was actually stored, and it
            updates (and is announced) only when a save has landed. The failure
            half is the section's own error alert, which carries `role="alert"`.
            Deliberately not an optimistic string set by the click handler:
            that would announce a save that had not happened yet. */}
        <Typography
          role="status"
          aria-live="polite"
          variant="body2"
          sx={{ mt: 2 }}
        >
          {enabled
            ? `We'll check in at ${formatReminderHour(hour)}${
                timezone ? `, ${timezone} time` : ''
              }.`
            : "Study check-ins are off. Everything in the list below is unchanged."}
        </Typography>
      </CardContent>
    </Card>
  );
}

export default StudyReminderSettings;
