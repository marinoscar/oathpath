import type {
  CoachValue,
  DataTablesValue,
  NavigationValue,
  NotificationsValue,
  StudyValue,
  VoiceValue,
} from '../schemas/user-settings-namespaces.schema';

// =============================================================================
// Settings Type Definitions
// =============================================================================

/**
 * User settings schema - stored in user_settings.value JSONB
 */
export interface UserSettingsValue {
  theme: 'light' | 'dark' | 'system';
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
  /**
   * Per-table view preferences, keyed by table id.
   *
   * Optional on purpose, and derived from the zod schema so the two can never
   * drift. Absent means "the user has expressed no table preferences yet" —
   * NOT "empty preferences". See user-settings-namespaces.schema.ts.
   */
  dataTables?: DataTablesValue;
  /**
   * Navigation chrome preferences. Absent means "use built-in defaults".
   */
  navigation?: NavigationValue;
  /**
   * Per-channel, per-event notification preferences (#126), channel-outer:
   * `{ email: { 'user.welcome': false } }`.
   *
   * SPARSE AND OPTIONAL AT EVERY LEVEL. Absent namespace, absent channel and
   * absent event key all mean the same thing — "use the event's
   * `defaultEnabled` from the registry" — which is what lets this feature ship
   * with no migration and no backfill, and is why an untouched account is not
   * muted. The dispatcher resolves it; see
   * notifications/notification-preferences.ts.
   */
  notifications?: NotificationsValue;
  /**
   * When — and whether — the hourly practice reminder checks in on this
   * learner (epic #56 / E7, `docs/specs/habit-streaks.md` §7).
   *
   * SPARSE, like its neighbours. Absent namespace and absent field both mean
   * "use the built-in default", resolved at reminder time by
   * `PracticeReminderTask` from `DEFAULT_STUDY_REMINDER_HOUR` and
   * `DEFAULT_STUDY_REMINDER_ENABLED` — never materialised into a row, so a
   * learner who never chose an hour keeps moving with the default if it
   * changes.
   */
  study?: StudyValue;
  /**
   * Spoken-audio playback preferences (issue #282, epic #280): whether a
   * spoken answer auto-submits, whether the premium synthesized voice is
   * preferred, which provider voice and speech rate to use, and whether
   * questions/answers play automatically.
   *
   * SPARSE, like its neighbours. Absent namespace and absent field both mean
   * "use the built-in default" (the `DEFAULT_VOICE_*` constants), resolved at
   * read time — never materialised into a row, so a learner who never
   * touched a voice preference keeps moving with the defaults if they
   * change.
   */
  voice?: VoiceValue;
  /**
   * How the coach talks to this learner (issue #317, epic #305): which of the
   * four personas its written and spoken feedback is composed in, and whether
   * it adds a per-answer reaction line at all.
   *
   * NOT PART OF `voice`, and not a subset of it — `persona` governs the
   * grader's feedback sentence and the tutor's civics explanation, both of
   * which a learner who never plays audio reads on every session. See the
   * `coach` block in user-settings-namespaces.schema.ts.
   *
   * SPARSE, like its neighbours. Absent namespace and absent field both mean
   * "use the built-in default" (`DEFAULT_COACH_PERSONA` /
   * `DEFAULT_COACH_REACTIONS`), resolved at generation time — never
   * materialised into a row, so a learner who never chose a persona keeps
   * moving with the default if it changes.
   */
  coach?: CoachValue;
}

/**
 * System settings schema - stored in system_settings.value JSONB
 */
export interface SystemSettingsValue {
  ui: {
    allowUserThemeOverride: boolean;
  };
  features: {
    [key: string]: boolean;
  };
}

/**
 * Default user settings
 */
// NOTE: `coach`, `dataTables`, `navigation`, `notifications`, `study` and
// `voice` are intentionally NOT listed here.
// Seeding them would turn "absent" into "explicitly empty", which is exactly
// the failure mode the namespaces are designed to avoid (a frozen column set
// that silently hides every column added later, a notification preference map
// that freezes a user at the defaults of the day they first saved, a reminder
// hour nobody ever chose, or a persona pinned to today's default for every
// account that never expressed an opinion about one).
export const DEFAULT_USER_SETTINGS: UserSettingsValue = {
  theme: 'system',
  profile: {
    useProviderImage: true,
  },
};

/**
 * Default system settings
 */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsValue = {
  ui: {
    allowUserThemeOverride: true,
  },
  features: {},
};
