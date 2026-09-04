export interface Role {
  name: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  profileImageUrl: string | null;
  roles: Role[];
  permissions: string[];
  isActive: boolean;
  createdAt: string;
}

export type DataTableDensity = 'compact' | 'standard' | 'comfortable';

/**
 * Navigation preferences. Every field is optional and an ABSENT field means
 * "use the built-in default" — absence is meaningful, not incidental, so never
 * backfill these with literal defaults when reading settings.
 */
export interface NavigationSettings {
  railCollapsed?: boolean;
}

/**
 * Per-table preferences, keyed by table id. As with navigation, every field is
 * optional and an ABSENT field means "use the built-in default" for that table
 * (an absent `visibleColumns` is not an empty column set).
 */
export interface DataTableSettings {
  visibleColumns?: string[];
  density?: DataTableDensity;
  sort?: { field: string; direction: 'asc' | 'desc' };
  pageSize?: number;
}

// =============================================================================
// Study — the reminder-time preference (issue #143, epic #56 / E7 "Habit")
// =============================================================================
//
// Mirrors `studySchema` / `studyPatchSchema` in
// `apps/api/src/common/schemas/user-settings-namespaces.schema.ts`, and carries
// that file's rule across the wire unchanged: BOTH FIELDS ARE OPTIONAL AND AN
// ABSENT FIELD MEANS "use the built-in default", resolved at read time by
// whoever is reading — the hourly `PracticeReminderTask` on the server, the
// control on `/settings/notifications` on the client.
//
// So the web app must never materialise these. A page that renders the default
// and saves it has frozen a learner at today's 9am forever, including after a
// future release decides the default should move — see
// `components/settings/StudyReminderSettings.tsx`, which renders the default
// without writing it and sends a NULL-DELETE when a learner returns to it.
// =============================================================================

/** The stored `study` namespace. Absent, or an absent field, means the default. */
export interface StudySettings {
  /** 0-23, in the learner's own `learner_profiles.timezone`. */
  reminderHour?: number;
  /** Whether the hourly task considers this learner AT ALL, for any reminder. */
  reminderEnabled?: boolean;
}

/**
 * PATCH form of `study`: each field may additionally be `null`, meaning "delete
 * this field and fall back to the built-in default" — the same shape, for the
 * same reason, as `NavigationSettingsPatch` below.
 */
export type StudySettingsPatch = {
  [K in keyof StudySettings]?: StudySettings[K] | null;
};

// =============================================================================
// Notifications — the registry (#124) and the stored preferences (#126, epic #109)
// =============================================================================
//
// TWO DIFFERENT SHAPES THAT ARE EASY TO CONFUSE, so they are named apart here:
//
//   * `NotificationEventDef`  — what events EXIST. Static, identical for every
//     caller, served by `GET /api/notifications/events`. The server owns it;
//     the web app never declares its own copy (see the long argument in
//     `apps/api/src/notifications/notification-events.ts`).
//   * `NotificationPreferences` — what THIS user chose, stored inside the
//     user-settings document under `notifications`.
//
// A definition is not a preference: an account with no stored preferences is
// not "no events", it is every event at its registry default.
// =============================================================================

/**
 * A delivery channel.
 *
 * Mirrors the API's `NOTIFICATION_CHANNELS`. This union is the ONE piece of the
 * registry the web app restates, and only because it is the key type of the
 * patch documents below — an open `string` there would let a typo compile.
 * It is a closed set server-side too (the PATCH schema validates the outer key
 * against the same enum and 400s on anything else), so a channel this union
 * lacks is a channel this app could not write anyway.
 *
 * Rendering is nonetheless written to survive a NEWER server that declares a
 * channel this build has never heard of — see `CHANNEL_META` in
 * `components/settings/NotificationSettings.tsx`, which falls back to the raw
 * key rather than rendering a blank label.
 */
export type NotificationChannel = 'email' | 'browser';

/**
 * One entry of the event registry, as served by `GET /api/notifications/events`.
 *
 * Field for field the API's `notificationEventSchema`. Note `mandatory` is a
 * plain `boolean` here, not `boolean | undefined`: the API normalises it on the
 * way out precisely so no client has to know that absent means "the user is in
 * charge".
 */
export interface NotificationEventDef {
  /** Stable key. What a preference is stored against; renaming one server-side is a migration. */
  key: string;
  /** Short human label — the row heading on the preferences page. */
  label: string;
  /** One sentence on what actually triggers this, in the user's terms. */
  description: string;
  /**
   * Channels this event CAN be delivered over — a capability of the event, not
   * a statement about which transports are implemented yet. A cell is rendered
   * only for a channel listed here, so `allowlist.invitation` (email only, its
   * recipient has no session by definition) never offers a browser toggle.
   */
  channels: NotificationChannel[];
  /** What an account that has expressed no preference receives. */
  defaultEnabled: boolean;
  /**
   * The user may not opt out, on ANY channel.
   *
   * A UI HINT ONLY — the gate is server-side in preference resolution, because
   * a client-side check is bypassed by any request that never went near the
   * client. Render the controls disabled WITH the reason rather than hiding
   * them: a dead toggle teaches nothing (epic #109, success criterion 5).
   */
  mandatory: boolean;
}

/**
 * One channel's stored preferences: event key -> the user's explicit choice.
 *
 * SPARSE. A key is present only where the user deliberately chose something. An
 * absent key is NOT `false` and must never be normalised into one — absent
 * means "use the registry's `defaultEnabled`", resolved at read time.
 */
export type NotificationChannelPreferences = Record<string, boolean>;

/**
 * The `notifications` namespace of the user-settings document, as stored.
 *
 * CHANNEL-OUTER, EVENT-INNER — `{ email: { 'user.welcome': false } }`. Not a
 * choice this file makes: it is the shape the API's
 * `readNotificationPreferences` parses and `isChannelEnabled` resolves, and a
 * document written event-outer would be silently ignored by the dispatcher,
 * i.e. a mute that never takes effect.
 *
 * Every level is optional, all the way down. There is deliberately no shape of
 * this value that asserts "the user has an opinion about every event".
 */
export type NotificationPreferences = Partial<
  Record<NotificationChannel, NotificationChannelPreferences>
>;

/**
 * PATCH form of one channel's preferences.
 *
 * The value is nullable because JSON Merge Patch uses `null` to mean DELETE:
 * `{ email: { 'user.welcome': null } }` removes that one event key, restoring
 * the absent (= registry default) state. That is what the preferences page
 * sends when a control returns to its default — writing the default value
 * explicitly works today and pins the user to today's default forever.
 */
export type NotificationChannelPreferencesPatch = Record<string, boolean | null>;

/**
 * PATCH form of the `notifications` namespace. Three levels of delete, each
 * meaning something different (see `UserSettingsUpdate`).
 *
 * Unlike `dataTables`, a non-null channel object is DEEP-merged per event
 * rather than replacing the channel wholesale — which is exactly what lets the
 * page send one key per toggle and leave every other preference absent.
 */
export type NotificationPreferencesPatch = Partial<
  Record<NotificationChannel, NotificationChannelPreferencesPatch | null>
>;

// =============================================================================
// The notification centre — delivered notifications (#127, epic #109)
// =============================================================================
//
// A THIRD notification shape, and the one most easily confused with the two
// above, so: `NotificationEventDef` is what CAN happen, `NotificationPreferences`
// is what the user WANTS, and `AppNotification` below is something that
// ACTUALLY HAPPENED — one row of the `notifications` table, addressed to this
// user, with its own read state.
//
// NAMED `AppNotification`, NOT `Notification`. The DOM declares a global
// `Notification` (the constructor behind the native toast), and this file's
// types are imported into modules that use BOTH — `services/browserNotifications.ts`
// raises a real `new Notification(...)` from one of these rows. A local
// interface called `Notification` would shadow the global inside every one of
// those modules, so the toast would silently be constructed from the wrong
// thing or fail to compile in a confusing place. The prefix costs one word and
// removes the collision entirely.
// =============================================================================

/**
 * One delivered notification, field for field the API's `notificationSchema`
 * (`apps/api/src/notifications/dto/notification.dto.ts`).
 *
 * THE SAME SHAPE ARRIVES TWO WAYS — fetched from `GET /api/notifications`, or
 * pushed over SSE — and that is deliberate on the API's side: a streamed event
 * is this object minus `readAt`, so both go into the same list with no second
 * mapping. See `streamEventToNotification` in `services/notificationStream.ts`,
 * which is the only place the missing field is filled in.
 */
export interface AppNotification {
  id: string;
  /**
   * The registry key that raised this (`security.role_changed`).
   *
   * For grouping, icons or filtering. NOT what is rendered — `title` and `body`
   * were rendered server-side at write time, so editing a template never
   * rewrites what a user was already told.
   */
  eventKey: string;
  /** One short line. Already length-capped by the API. Render as TEXT. */
  title: string;
  /** The detail. Plain text, never markup. */
  body: string;
  /**
   * Root-relative path to open, or `null`.
   *
   * GUARANTEED INTERNAL by the API — `sanitizeLink` validated it before the row
   * was written, so it is always a single leading `/` with no scheme and no
   * protocol-relative `//`. That is what makes it safe to hand to
   * `navigate()`. The client still refuses anything that does not start with a
   * single `/` (see `isInternalLink` in `NotificationBell.tsx`): the guarantee
   * is the server's to keep, and a client that also checks costs one comparison
   * and survives the day it is broken.
   */
  link: string | null;
  /** ISO-8601. When the user marked it read; `null` while unread. */
  readAt: string | null;
  /** ISO-8601. */
  createdAt: string;
}

/**
 * A page of `GET /api/notifications`.
 *
 * FLAT pagination (`items`/`total`/`page`/`pageSize`/`totalPages`), matching
 * `/users` and `/allowlist` rather than storage's nested `pagination` object —
 * the API deliberately picked the more common of its two existing list shapes.
 */
export interface NotificationListResponse {
  items: AppNotification[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * The badge number.
 *
 * Returned by `GET /api/notifications/unread-count` AND by BOTH mark-read
 * endpoints — which is why marking one read costs a single round trip: the
 * client already holds the row it marked, and the count is the only thing it
 * cannot compute for itself. Do not follow a mark-read with a count fetch.
 */
export interface UnreadCountResponse {
  unreadCount: number;
}

/**
 * One `event: notification` frame's payload, as `NotificationStreamService`
 * publishes it.
 *
 * `AppNotification` WITHOUT `readAt` — not an oversight and not a different
 * model: a notification is unread by definition at the instant it is
 * published, so the field would carry no information. Everything else is
 * identical, which is the property that lets a streamed event be pushed
 * straight into the fetched list.
 *
 * Carries NO user id. The recipient is implicit in which stream it arrived on;
 * the API omits it specifically so no client is ever tempted to filter on it.
 */
export type NotificationStreamEvent = Omit<AppNotification, 'readAt'>;

export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  profile: {
    displayName?: string;
    useProviderImage: boolean;
    customImageUrl?: string | null;
  };
  navigation?: NavigationSettings;
  dataTables?: Record<string, DataTableSettings>;
  /**
   * Per-channel, per-event notification preferences (#126, epic #109).
   *
   * OPTIONAL, AND ABSENT IS THE NORMAL CASE — not a loading state and not
   * "notifications off". No account has this key until it deliberately changes
   * a preference, so `settings.notifications ?? {}` resolves every event to its
   * registry default. Never backfill it with a materialised object.
   */
  notifications?: NotificationPreferences;
  /**
   * When — and whether — this learner is reminded to practise (#143, epic #56).
   *
   * OPTIONAL, AND ABSENT IS THE NORMAL CASE, exactly as `notifications` above:
   * no account has this key until the learner moves one of the two controls, and
   * absent resolves to the built-in defaults (hour 9, enabled). Never backfill.
   */
  study?: StudySettings;
  updatedAt: string;
  version: number;
}

/**
 * PATCH form of `navigation`: each field may additionally be `null`, meaning
 * "delete this field and fall back to the built-in default".
 */
export type NavigationSettingsPatch = {
  [K in keyof NavigationSettings]?: NavigationSettings[K] | null;
};

/**
 * PATCH form of `dataTables`: the per-table VALUE may be `null` to delete that
 * table's entry. Note the asymmetry with navigation — a non-null entry REPLACES
 * the stored entry wholesale rather than being deep-merged, so its fields are
 * plain optionals and are NOT individually nullable. The server rejects
 * `{ [id]: { sort: null } }`; omit the field or replace the whole entry.
 */
export type DataTablesPatch = Record<string, DataTableSettings | null>;

/**
 * Payload accepted by `PATCH /api/user-settings`.
 *
 * This deliberately is NOT `Partial<UserSettings>`: the endpoint uses JSON
 * Merge Patch semantics, where `null` is a DELETE signal rather than a value.
 *   - `{ navigation: null }`                    clears the whole namespace
 *   - `{ navigation: { railCollapsed: null } }` deletes just that field
 *   - `{ dataTables: null }`                    clears the whole namespace
 *   - `{ dataTables: { [id]: null } }`          deletes just that table's entry
 *   - `{ notifications: null }`                 clears the whole namespace
 *   - `{ notifications: { email: null } }`      clears one channel
 *   - `{ notifications: { email: { k: null } }}` deletes ONE event key, restoring
 *                                               the registry default for it
 * Omitting a key leaves the stored value untouched. Server-owned fields
 * (`updatedAt`, `version`) are not patchable and so are absent here.
 */
export interface UserSettingsUpdate {
  theme?: UserSettings['theme'];
  profile?: Partial<UserSettings['profile']>;
  navigation?: NavigationSettingsPatch | null;
  dataTables?: DataTablesPatch | null;
  /**
   * Notification preferences (#126). The channel object is DEEP-merged per
   * event key server-side, which is what allows the preferences page to send
   * exactly the one key it changed and leave every other preference absent.
   */
  notifications?: NotificationPreferencesPatch | null;
  /**
   * Reminder preferences (#143). Field-wise merged server-side like
   * `navigation`, so a control sends only the one field it changed — and sends
   * `null` for it when the learner has moved back to the built-in default.
   */
  study?: StudySettingsPatch | null;
}

export interface SystemSettings {
  ui: {
    allowUserThemeOverride: boolean;
  };
  features: Record<string, boolean>;
  updatedAt: string;
  updatedBy: { id: string; email: string } | null;
  version: number;
}

export interface AuthProvider {
  name: string;
  authUrl: string;
}

export interface AllowedEmailEntry {
  id: string;
  email: string;
  addedBy: { id: string; email: string } | null;
  addedAt: string;
  claimedBy: { id: string; email: string } | null;
  claimedAt: string | null;
  notes: string | null;
}

export interface AllowlistResponse {
  items: AllowedEmailEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface UserListItem {
  id: string;
  email: string;
  displayName: string | null;
  providerDisplayName: string | null;
  profileImageUrl: string | null;
  providerProfileImageUrl?: string | null;
  isActive: boolean;
  roles: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UsersResponse {
  items: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * What `GET /api/auth/device/activate?code=…` returns for a pending code.
 *
 * EVERY FIELD UNDER `clientInfo` IS ATTACKER-CHOSEN. `POST /auth/device/code`
 * is `@Public()`, its body is stored verbatim in the `device_codes.client_info`
 * JSONB column, and this endpoint hands that column back wholesale. The types
 * below describe what a WELL-BEHAVED client sends, not what will arrive — see
 * `components/device-activation/credential.ts`, which is the only place this
 * object is allowed to be interpreted.
 */
export interface DeviceActivationInfo {
  userCode: string;
  // Optional because the API declares it optional (`clientInfo?` on
  // DeviceActivateResponseDto) and because a row written by hand or by an older
  // build can carry `null`. It was typed as required, which let call sites do
  // `deviceInfo.clientInfo.deviceName` and crash the whole activation page on a
  // shape the server is allowed to send.
  clientInfo?: {
    deviceName?: string;
    userAgent?: string;
    ipAddress?: string;
    // `string`, NOT the `'session' | 'pat'` union (#141). Two reasons, both
    // load-bearing: rows created before #141 have no `tokenType` at all, and
    // the column is not re-validated on read, so an unexpected value is a
    // shape we must be able to represent in order to defend against it. Typing
    // it as the union here would make `readCredentialKind`'s unknown-value
    // branch look like dead code and invite someone to delete it.
    tokenType?: string;
  };
  expiresAt: string;
}

export interface DeviceAuthorizationResponse {
  success: boolean;
  message: string;
}

// Personal Access Tokens
export type PatDurationUnit = 'minutes' | 'days' | 'months';

export interface PersonalAccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  durationValue: number;
  durationUnit: PatDurationUnit;
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface PatCreatedResponse {
  token: string;
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Email settings — issue #124, epic #109.
//
// These mirror the payloads of `/api/email-settings`, which are NOT part of the
// system settings document: email is its own controller writing its own
// `system_settings` row, with its own version counter and its own save
// semantics (see `EmailSettingsInput` below), so it gets its own types rather
// than another branch of `SystemSettings`. Everything the web app knows about
// the wire format lives here and in `services/api.ts`'s email block — if the
// API's field names move, those two files are the whole reconciliation.
//
// THE SHAPE IS FLAT, because the API's is. `emailSettingsSchema`
// (`apps/api/src/email/email-settings.schema.ts`) is one object whose
// `sesRegion` / `smtpHost` / `smtpPort` / `smtpUsername` are siblings of
// `fromAddress` and `provider`, and both DTOs derive from it rather than
// restating it. An earlier draft of this file grouped them into `ses: {…}` and
// `smtp: {…}` sub-objects. That typechecked perfectly and was wrong on the
// wire in both directions: every read came back `undefined`, and every write
// was dropped by zod, which strips unknown keys. Do not re-nest — the types
// here are not free to be tidier than the payload they describe.
// ---------------------------------------------------------------------------

/**
 * Which transport sends mail. Mirrors `EMAIL_PROVIDER_KINDS` in the API's
 * `email-settings.schema.ts`.
 *
 * There is deliberately no `'disabled'` member. "Off" is not a transport, it is
 * `EmailSettings.enabled === false` — see the note there. The absence of a
 * chosen transport is `provider: null`, which is why every use of this type on
 * the wire is written `EmailProviderKind | null` rather than made optional.
 */
export type EmailProviderKind = 'ses' | 'smtp';

/**
 * What the API will tell us about the stored SMTP password — which is
 * everything except the password.
 *
 * The password itself is written into the encrypted credential store (epic
 * #108) and is unreadable through the API by construction: the response DTO
 * carries a compile-time proof that it has no field able to hold one. This
 * status object is what makes the blank password box honest; without it the UI
 * would render an empty field with no way to say whether submitting it keeps
 * something or keeps nothing.
 */
export interface SmtpPasswordStatus {
  /** Is a password stored at all? */
  configured: boolean;

  /**
   * The credential store's OWN mask — `••••` plus at most the last four
   * characters — derived once on write by the code that held the plaintext.
   *
   * Null when nothing is stored, and also null for a secret too short to mask
   * safely, so the UI must read correctly without it. Better than a fixed
   * placeholder: an admin who has just rotated a credential can see WHICH one
   * is live rather than only that one exists.
   */
  hint: string | null;

  /** When the stored password was last written. Null when nothing is stored. */
  updatedAt: string | null;

  /** Who last wrote it. Null when nothing is stored, or that user was deleted. */
  updatedByUserId: string | null;
}

/**
 * `GET /api/email-settings`, and the body of a successful `PUT`.
 *
 * The optional fields are optional in the same sense the API means: the key is
 * ABSENT when nothing is configured (`stripUnsetSettingFields` removes empty
 * values before the row is written), never present-and-empty. Read them with
 * `?? ''` and do not test them for `''`.
 */
export interface EmailSettings {
  /**
   * `null` means "no transport chosen", the state of every fresh install. It
   * is a persisted value, not a missing key.
   */
  provider: EmailProviderKind | null;

  /**
   * The master switch, a SEPARATE AXIS from `provider`. Nothing is sent while
   * this is false.
   *
   * Two fields rather than one because the pair carries something a single
   * three-way choice cannot: an admin who switches mail off for a maintenance
   * window keeps the transport and every field belonging to it, and turning it
   * back on costs no retyping. `provider: null, enabled: false` (never
   * configured) and `provider: 'smtp', enabled: false` (deliberately off) are
   * genuinely different states, and collapsing them would lose the second one.
   */
  enabled: boolean;

  /** SES region override, e.g. `us-east-1`. Absent means the deployment's `S3_REGION`. */
  sesRegion?: string;

  smtpHost?: string;
  smtpPort?: number;

  /**
   * REQUIRE TLS — not nodemailer's `secure` flag, which the API derives itself
   * from the port (465 is TLS from the first byte; everything else gets
   * required STARTTLS). Absent is treated as `true` by the provider, so the UI
   * must default it to on rather than to off.
   */
  smtpUseTls?: boolean;

  /** Absent means unauthenticated submission — a real configuration for an IP-authorised relay. */
  smtpUsername?: string;

  fromAddress?: string;
  fromName?: string;

  /** Everything the UI may know about the stored password. See {@link SmtpPasswordStatus}. */
  smtpPasswordStatus: SmtpPasswordStatus;

  /**
   * Why the STORED configuration could not be read, when it could not be. Null
   * on the normal path.
   *
   * The read endpoint degrades instead of throwing: a hand-edited row or a bad
   * migration would otherwise take down the one screen capable of repairing
   * it. When this is set, every settings field above is a DEFAULT rather than
   * the deployment's real configuration — which is why the page has to say so.
   * An admin who is not told is editing a form that does not describe their
   * system, and "saving" it overwrites the row they came to fix.
   *
   * Field paths only, never stored values.
   */
  settingsError: string | null;

  /** Bumped on every write. Pass back as `If-Match` on the next PUT. */
  version: number;

  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/**
 * A settings field an admin left empty.
 *
 * An HTML form cannot express "absent": a cleared text input submits `''` and a
 * reset controlled component submits `null`. The API's
 * `updateEmailSettingsSchema` wraps every optional field in a `blankable`
 * union that accepts both, and converts them to "absent" exactly once, in
 * `EmailSettingsService.update`. So the web app sends what the admin did —
 * they cleared the box — instead of reimplementing that conversion here and
 * getting a seventh copy of it slightly wrong.
 */
export type Blankable<T> = T | '' | null;

/**
 * `PUT /api/email-settings`.
 *
 * A full replacement, not a patch, plus the version the caller believed it was
 * replacing (sent as `If-Match` — see `updateEmailSettings` in
 * `services/api.ts`, not carried in this body).
 *
 * `provider` and `enabled` are REQUIRED and are NOT blankable: `null` is a real
 * persisted value for `provider`, so the API keeps it distinct from an emptied
 * box, and stripping it would drop a required key and fail the parse.
 *
 * BLANK PRESERVES (the #115 contract, restated by #124). `smtpPassword`
 * omitted — or sent as an empty string — leaves the stored password exactly as
 * it is; a non-empty value replaces it. There is deliberately NO way to erase a
 * password by clearing the field, because "I left the box alone" and "I want no
 * password" are the same gesture, and guessing wrong in the destructive
 * direction silently breaks mail for everyone. Note it is the ONE field this
 * app omits rather than sending as `''`: for every other field `''` means "not
 * configured", and for this one it means "unchanged".
 */
export interface EmailSettingsInput {
  provider: EmailProviderKind | null;
  enabled: boolean;
  sesRegion?: Blankable<string>;
  smtpHost?: Blankable<string>;
  smtpPort?: Blankable<number>;
  smtpUseTls?: Blankable<boolean>;
  smtpUsername?: Blankable<string>;
  fromAddress?: Blankable<string>;
  fromName?: Blankable<string>;
  smtpPassword?: string;
}

/**
 * `POST /api/email-settings/test` — the result of a real send attempt.
 *
 * A FAILED SEND IS A 200 WITH `success: false`, not a rejected promise: the
 * request succeeded, the mail did not. That is why the page branches on this
 * field and never on "did the call throw" — the single most likely way this
 * page could end up claiming success while the provider refused the message.
 *
 * Every field is present on a real response (nullable rather than optional in
 * the API's DTO). They are optional HERE because the hook also builds this
 * shape locally when the CALL itself fails — a 403, a 500, a dropped
 * connection — which is still a failed test and belongs in the same red
 * region, but has no recipient, no provider and no timestamp to report.
 */
export interface EmailTestResult {
  success: boolean;

  /**
   * Where it went — the caller's own address, taken from the session. Echoed
   * back so the UI states the destination as fact rather than assuming it.
   */
  sentTo?: string;

  /**
   * Which transport carried, or refused, the message. Null when nothing was
   * attempted because no provider was configured. Worth showing: an admin who
   * has just switched from SMTP to SES needs to know which one produced the
   * error in front of them.
   */
  providerKind?: EmailProviderKind | null;

  /** Provider message id on success — the string that correlates this attempt with a provider-side log. */
  messageId?: string | null;

  /**
   * The provider's VERBATIM error on failure — `535 Authentication failed`,
   * `MessageRejected: Email address is not verified`. Diagnosing mail
   * configuration is this page's entire job (#124), so this string is rendered
   * as-is and never replaced with a friendlier summary. Already redacted and
   * length-capped by the API's `SecretRedactor`.
   */
  error?: string | null;

  /** When the attempt was made. */
  attemptedAt?: string;
}

// =============================================================================
// AI configuration (epic #25)
// =============================================================================
//
// Two scopes, two shapes. The ADMIN half (`AiSettings`) is the server key, the
// provider choice, the master switch and the role → model bindings; the USER
// half (`AiKeyStatus`, `AiStatus`, `AiUsage`) is each person's own key and
// what it has cost them.
//
// NEITHER KEY IS REPRESENTABLE HERE. `AiSettings` carries `apiKeyStatus` — a
// masked, non-secret description — and `AiSettingsInput` carries a write-only
// `apiKey`. There is deliberately no type on which a key can travel back from
// the server, matching the API's own compile-time proofs.

/** Providers the API can be configured to use. Mirrors `AI_PROVIDER_KINDS`. */
export type AiProviderKind = 'openai';

/**
 * A model's capability family, as the API classifies it.
 *
 * `other` holds ids the classifier did not recognise, plus image and
 * moderation models. They are hidden from the default view and reachable under
 * "show all models" — the guarantee that an upstream naming change can never
 * leave an admin with an empty dropdown and no workaround.
 */
export type AiCapabilityFamily =
  | 'text'
  | 'realtime'
  | 'transcribe'
  | 'tts'
  | 'embedding'
  | 'other';

/**
 * What the admin page may know about the stored SERVER key.
 *
 * NOT THE KEY. `hint` is the credential store's own mask (`••••` plus at most
 * four trailing characters, and nothing at all below eight), derived on write
 * by code that already held the plaintext.
 *
 * A boolean alone would not be enough: an admin who has just rotated a key
 * needs to see WHICH value is live, and "when, and by whom" is the difference
 * between "my change saved" and "I am looking at a colleague's value from
 * months ago".
 */
export interface AiApiKeyStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

/** The AI configuration, as `GET /api/ai-settings` returns it. */
export interface AiSettings {
  /** `null` is "no provider chosen" — the state of every fresh install. */
  provider: AiProviderKind | null;

  /**
   * Master switch, a SEPARATE AXIS from `provider` so an admin can turn AI off
   * without losing the configuration they would otherwise have to rebuild.
   */
  enabled: boolean;

  /** Role key → model id. `null` means the role is not bound. */
  models: Record<string, string | null>;

  /** The text-family generation floor. See `AiModelCatalog.minGeneration`. */
  minModelGeneration: number;

  apiKeyStatus: AiApiKeyStatus;

  /**
   * Why the stored configuration could not be read, when it could not be.
   *
   * FIELD PATHS ONLY, never stored values. The API degrades to defaults plus
   * this message rather than 500ing, because a 500 would make the one screen
   * capable of repairing the row the one screen the broken row takes down.
   */
  settingsError: string | null;

  /** Bumped on every write; sent back as `If-Match` on the next save. */
  version: number;

  updatedAt: string | null;
  updatedBy: { id: string; email: string } | null;
}

/**
 * The PUT body.
 *
 * `apiKey` is WRITE-ONLY and BLANK PRESERVES: omit it (or send it empty) to
 * keep the stored key. The page omits the field entirely rather than sending
 * `''` — the API treats them identically, but omitting is what the request
 * visibly says, and a reviewer reading the network tab sees no key field at
 * all on a save that did not change one.
 */
export interface AiSettingsInput {
  provider: AiProviderKind | null;
  enabled: boolean;
  models: Record<string, string | null>;
  minModelGeneration?: number;
  apiKey?: string;
}

/** One model the admin may bind, as classified by the API. */
export interface AiModel {
  id: string;
  family: AiCapabilityFamily;
  /** `null` means the generation could not be parsed — never "old". */
  generation: number | null;
  createdAt: string | null;
}

/**
 * One model role, read from the API rather than duplicated here.
 *
 * THE WEB KEEPS NO COPY OF THIS LIST, deliberately — the same reasoning
 * `getNotificationEvents` documents. A second declaration is a second thing to
 * drift, and `wired` in particular is a per-DEPLOYMENT fact (it accounts for
 * what the configured provider can actually serve), so a static copy would be
 * wrong on any deployment whose provider differs.
 */
export interface AiModelRole {
  key: string;
  label: string;
  description: string;
  capability: AiCapabilityFamily;
  /** False renders inert: declared in the IA, nothing dispatches to it. */
  wired: boolean;
}

/** `GET /api/ai-settings/models`. */
export interface AiModelCatalog {
  models: AiModel[];
  roles: AiModelRole[];
  /**
   * No server key is stored, so nothing was attempted.
   *
   * DISTINCT FROM `error`: this is the state of every fresh install, and
   * rendering it as a failure makes a brand-new system look broken.
   */
  notConfigured: boolean;
  /** A real provider refusal, verbatim and redacted. Null otherwise. */
  error: string | null;
  minGeneration: number;
  showAll: boolean;
}

/** Whether one bound model is reachable on the key that was tested. */
export interface AiRoleReachability {
  roleKey: string;
  modelId: string;
  reachable: boolean;
  /** The provider's verbatim message for THIS role. Null when reachable. */
  error: string | null;
}

/**
 * The outcome of a connection test, admin or per-user.
 *
 * `success` IS THE ONLY SUCCESS SIGNAL. Both test endpoints answer HTTP 200
 * even when the test failed, because a refused connection is a successful
 * diagnosis and this app's error envelope would suppress the detail. A caller
 * that treats a resolved promise as "it works" reports success for every
 * misconfiguration there is.
 */
export interface AiTestResult {
  success: boolean;
  /**
   * Did the key itself authenticate?
   *
   * SEPARATE FROM `success` because the remedies differ. A key that fails here
   * is wrong or revoked. A key that passes here and still fails overall
   * belongs to an organisation without access to the bound models — and told
   * only "the test failed", a user would replace a perfectly good key.
   */
  authenticated: boolean;
  roles: AiRoleReachability[];
  providerKind: AiProviderKind | null;
  error: string | null;
  attemptedAt?: string;
}

/** What a user may know about their OWN stored key. Never the key. */
export interface AiKeyStatus {
  configured: boolean;
  hint: string | null;
  updatedAt: string | null;
}

/**
 * `GET /api/ai/status` — TWO INDEPENDENT FACTS, and no combined flag.
 *
 *   `userKeyConfigured === false` -> hard block into `/setup/ai-key`
 *   `systemReady === false`       -> NOT a block; point-of-use messaging
 *
 * Merging them tells a user blocked by missing ADMIN configuration to add a
 * key they already have. Do not add a `ready` helper to this type.
 */
export interface AiStatus {
  userKeyConfigured: boolean;
  systemReady: boolean;
  /** Master switch, so a message can name the control that is off. */
  enabled: boolean;
  providerConfigured: boolean;
  /** Wired roles with no model bound, by key. Names only. */
  unboundRoles: string[];
}

/**
 * Why an AI call was NOT ATTEMPTED — `AiUnavailableCause` on the API, closed.
 *
 * A CLOSED SET OF FOUR, and the closure is load-bearing: every consumer
 * branches on it exhaustively, which is why `state_required` is its own
 * terminal frame on the explanation stream rather than a fifth member here.
 * That fact is not about AI at all (the learner has not set their state), it
 * is answered on a different screen, and adding it would force a re-audit of
 * every branch that reads this union.
 *
 * NOTHING WAS SPENT AND NOTHING IS BROKEN when one of these arrives. It is not
 * an error, and it must never be rendered as one — see
 * `components/ai/ExplainPanel.tsx`.
 */
export type AiUnavailableCause =
  /** The caller has no personal key stored. THE ONLY ONE THAT IS THEIR DOING. */
  | 'no_user_key'
  /** An administrator turned the master switch off. */
  | 'ai_disabled'
  /** No model is bound to the role this feature needs. */
  | 'role_unbound'
  /** The configured provider cannot serve the role, or none is configured. */
  | 'capability_unsupported';

/** One row of a usage breakdown, by model or by role. */
export interface AiUsageBreakdown {
  key: string;
  calls: number;
  totalTokens: number;
}

/**
 * `GET /api/ai/usage` — RECORDED USAGE, NOT A BILL.
 *
 * Token counts are not dollars, this application carries no price table, and
 * `callsWithUnknownUsage` counts calls whose consumption was never reported. A
 * page rendering this must say so and link to the user's OpenAI dashboard;
 * presenting an approximate figure as a bill is the failure to avoid.
 */
export interface AiUsage {
  since: string;
  calls: number;
  successfulCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** The honest caveat on every figure above. */
  callsWithUnknownUsage: number;
  byModel: AiUsageBreakdown[];
  byRole: AiUsageBreakdown[];
}

// =============================================================================
// Speech — transcription and synthesis (epic #58 / E9)
// =============================================================================

/**
 * `POST /api/ai/speech/transcribe` — TWO FIELDS AND NOTHING ELSE.
 *
 * `docs/specs/voice.md` §9 fixes this shape: no usage event id, no model id, no
 * provider metadata, and — §4 — no audio, in either direction. The response is
 * narrow on purpose, so a later change to the endpoint has one compatibility
 * surface instead of six.
 */
export interface SpeechTranscription {
  /** What the recognizer heard. Shown to the learner to confirm BEFORE grading. */
  text: string;

  /**
   * How sure the recognizer was, 0..1 — or `null`.
   *
   * `null` MEANS UNKNOWN. IT DOES NOT MEAN ZERO, and the difference decides
   * whether a learner is treated fairly: a consumer that reads `null` as `0`
   * compares it against the low-confidence threshold, wins that comparison
   * every time, and marks a perfectly clear answer `misheard` — on every
   * provider that simply does not report a score. That is the exact
   * knowledge-vs-recognition conflation `VISION.md` line 228 forbids, arriving
   * through a falsy check rather than through a policy decision.
   *
   * So: branch on `confidence === null` FIRST, and only then on its value.
   * `AiUsage`'s own nullable fields carry the identical rule for the identical
   * reason ("null means unknown, never zero").
   */
  confidence: number | null;
}

// =============================================================================
// Journey — the learner profile and its two reference lists (epic #50)
// =============================================================================
//
// Mirrors `apps/api/src/journey/dto/journey-profile.dto.ts` and
// `update-journey-profile.dto.ts`. Two things about this shape are load-bearing
// and easy to undo by accident:
//
//   1. THE WEB KEEPS NO COPY OF THE TEST VERSIONS OR THE STATE LIST. Both
//      travel on the profile response, for the same one-registry reason
//      `getNotificationEvents` and the AI model roles document: a second
//      declaration is a second thing to drift, and the API validates
//      `stateCode` against the very list it serves.
//
//   2. THE FILING-DATE CUTOFF IS NOT IN THIS FILE, AND MUST NEVER BE. Which
//      civics test a filing date selects is server logic
//      (`test-version-resolution.ts`, where the date appears exactly once in
//      the repository). The browser learns it only as
//      `CivicsTestVersionOption.filedFrom`, which is data — so a future
//      carve-out is one server edit rather than one server edit plus a
//      forgotten constant in the UI.
// =============================================================================

/** The eight `journey-stages.ts` keys, in journey order. */
export type JourneyStageKey =
  | 'uncertain'
  | 'oriented'
  | 'learning'
  | 'remembering'
  | 'speaking'
  | 'practicing'
  | 'performing'
  | 'ready';

/** The caller's own `learner_profiles` row. There is no user id in it. */
export interface JourneyProfile {
  stage: JourneyStageKey;
  /** `YYYY-MM-DD`, or null when no interview is booked. A DAY, not an instant. */
  interviewDate: string | null;
  stateCode: string | null;
  /**
   * The resolved civics test, or null.
   *
   * NULL MEANS "NOT YET RESOLVED", never "the 2008 test" — nothing on screen
   * may present a default here as if the learner had told us something.
   */
  testVersionCode: string | null;
  seniorExemption: boolean;
  dailyGoalMinutes: number;
  /** BCP-47. Governs AI explanations only; questions stay in English. */
  explanationLanguage: string;
  /** IANA zone name. Every countdown in the API is computed in it. */
  timezone: string;
  /**
   * When orientation was completed, or null.
   *
   * SERVER-SET. This is the literal field `RequireOrientation` checks, and
   * there is no request field that writes it.
   */
  orientationCompletedAt: string | null;
}

/** One `civics_test_versions` row, plus the one derived eligibility field. */
export interface CivicsTestVersionOption {
  code: string;
  label: string;
  questionsAsked: number;
  passThreshold: number;
  seniorQuestionsAsked: number;
  seniorPassThreshold: number;
  /**
   * The earliest Form N-400 filing date this version applies to, or null when
   * it has no lower bound.
   *
   * DERIVED SERVER-SIDE, not a column. It is here so the orientation form can
   * tell a learner which test their date selects without the browser learning
   * the cutoff rule.
   */
  filedFrom: string | null;
}

/** One selectable state or territory. All 56, `DC` and the territories included. */
export interface UsStateOption {
  code: string;
  name: string;
}

/** `GET /api/journey/profile` and the body `PUT` answers with. */
export interface JourneyProfileResponse {
  profile: JourneyProfile;
  testVersions: CivicsTestVersionOption[];
  states: UsStateOption[];
}

/**
 * `PUT /api/journey/profile` — every field optional, absent means unchanged.
 *
 * THREE ABSENCES ARE DELIBERATE AND ENFORCED BY THE SERVER:
 *
 *   * no `userId` — the learner is `@CurrentUser('id')` and nothing else;
 *   * no `stage` and no `orientationCompletedAt` — both are consequences the
 *     server infers from what the profile holds after the merge;
 *   * `filingDate` and `testVersionCode` are ALTERNATIVES. Sending both is a
 *     400, because there is no principled way to choose between a date and a
 *     code that contradicts it. This app's forms send `filingDate` and let the
 *     server resolve the version.
 *
 * `interviewDate: null` is the one explicit clear: absent leaves a booked date
 * alone, null removes it.
 */
export interface UpdateJourneyProfileInput {
  interviewDate?: string | null;
  stateCode?: string;
  testVersionCode?: string;
  filingDate?: string;
  seniorExemption?: boolean;
  dailyGoalMinutes?: number;
  explanationLanguage?: string;
  timezone?: string;
}

// =============================================================================
// Journey — the home screen payload and the stage registry (issue #74, epic #50)
// =============================================================================
//
// Mirrors `apps/api/src/journey/dto/journey-home.dto.ts` and
// `dto/journey-stage.dto.ts` field for field. Two absences below are the whole
// point of the design and are easy to "helpfully" undo:
//
//   1. THERE IS NO `minutesToday`, AND NO CLIENT-SIDE DEFAULT FOR ONE. Nothing
//      measures practice time in E1, so the ring has nothing to draw. A `0`
//      invented here would be indistinguishable, to the learner reading it,
//      from a real zero — `docs/specs/journey-shell.md` §10 rules exactly that
//      out. `dailyGoal.tracked` is the honest flag instead, and it is `false`
//      for the whole of this release.
//
//   2. THERE IS NO LOCAL STAGE LIST. `JourneyStage` is the shape of one item
//      the server sends, never an array the web declares. §6 keeps the registry
//      in the API for the same reason `notification-events.ts` and
//      `ai-model-roles.ts` do: a second copy is detection instead of
//      prevention. `JourneyStageKey` above is a TYPE, which carries no copy and
//      no ordering — the eight labels and their order come down the wire.
// =============================================================================

/**
 * One item from `GET /api/journey/stages`.
 *
 * `key` is deliberately a plain `string`, not `JourneyStageKey`: this is
 * whatever the server declares, and a client union that disagreed with it would
 * be the duplicate registry §6 rejects, wearing a type annotation.
 */
export interface JourneyStage {
  key: string;
  label: string;
  description: string;
}

/**
 * Which recommendation the server picked.
 *
 * A CLOSED UNION, mirroring `NEXT_ACTION_KINDS` on the server, and it exists
 * for presentation only — the title, reason and path all arrive already
 * written. A component branching on `kind` to choose COPY would be a second
 * declaration of what the recommender already decided, and the two would
 * disagree the first time the server's wording is edited.
 *
 * WIDENED BY EXACTLY ONE MEMBER IN E3 (#81, epic #52): `practice`.
 * `docs/specs/practice-sessions.md` §12 specifies it — `NEXT_ACTION_PATHS`
 * gains `practice: '/practice'` and the `interview_countdown` branch re-points
 * at it now that Practice has real content to send a learner to. WIDENED BY
 * ONE MORE MEMBER IN E5 (#82, epic #54): `review`, produced by
 * `study-coach.ts`'s `recommendStudyAction` and ranked between
 * `interview_countdown` and `practice` — see that file for the full ordering.
 * It shares `/practice` with `interview_countdown` and `practice` (three
 * kinds naming one destination, not a duplicated branch); the Practice page
 * reads `nextAction.kind` to decide which action to put forward first. WIDENED
 * BY ONE MORE MEMBER IN E8 (#140, epic #57): `interview`. The API ships it
 * today — `NEXT_ACTION_KINDS` has the member and `NEXT_ACTION_PATHS` maps it to
 * `/practice/interviews`, the one path in that map that is deliberately NOT
 * `/practice` (a card inviting a learner to rehearse a whole interview that
 * landed them on the five-question drill would be the "points at a route that
 * does not do what the card said" failure that map exists to prevent). It is
 * ranked between `practice` and `explore` by `study-coach.ts` and offered only
 * at stage `practicing` or beyond; `docs/specs/mock-interview.md` §14.1 has the
 * ordering argument.
 *
 * **This being a closed union is a compile-time convenience, not a runtime
 * guarantee.** The value arrives over the wire from a server that deploys
 * independently of this bundle, so a browser holding an older build WILL see a
 * `kind` that is not in this union the day a new one ships. That is exactly why
 * `NextUpCard` looks its `kind` up with a fallback instead of indexing a total
 * `Record` and rendering whatever comes back: a `TypeError` on the front page
 * is a far worse outcome than a generic glyph beside copy that is already
 * correct, because the server wrote every word of it.
 */
export type NextActionKind =
  | 'orientation'
  | 'interview_countdown'
  | 'review'
  | 'explore'
  | 'practice'
  | 'interview';

/** The one recommendation Home renders — `journey-shell.md` §4. */
export interface NextAction {
  kind: NextActionKind;
  /** Server-written. Rendered verbatim. */
  title: string;
  /** Server-written. Rendered verbatim. */
  reason: string;
  /**
   * One of the recommender's own hardcoded paths — never assembled from user
   * input, and never a route that redirects to `/` (§4.1).
   */
  path: string;
}

/** The daily-goal widget's data. See the `minutesToday` note above. */
export interface DailyGoal {
  /** The learner's own target, which they chose. A real fact. */
  minutes: number;
  /** Whether anything is being measured against it. `false` throughout E1. */
  tracked: boolean;
}

/** `GET /api/journey/home`. */
export interface JourneyHome {
  stage: JourneyStageKey;
  /** `YYYY-MM-DD`, or null when no interview is booked. */
  interviewDate: string | null;
  /**
   * Whole CALENDAR days to the interview, in the learner's own timezone;
   * negative once past, null when unset.
   *
   * SERVER-COMPUTED, and never recomputed in the browser: a client dividing a
   * timestamp difference by 86 400 000 gets the wrong answer across a DST
   * boundary, and "13 days" versus "14 days" is not a rounding detail to
   * somebody counting down to their naturalization interview (§4.4, §9.1).
   */
  daysUntilInterview: number | null;
  /** Its own fact, not derived from a negative count. Today is NOT past. */
  interviewPast: boolean;
  dailyGoal: DailyGoal;
  nextAction: NextAction;
}

// =============================================================================
// Civics — the admin dynamic-answer surface (#126, epic #51)
// =============================================================================
//
// Mirrors `apps/api/src/civics/dto/civics-dynamic-answer.dto.ts` and
// `update-civics-dynamic-answer.dto.ts`. Two properties of this shape are
// load-bearing and easy to undo by accident:
//
//   1. THIS IS NOT THE LEARNER'S VIEW OF AN ANSWER. The learner-facing shape
//      is resolved per caller and deliberately carries no effective dates. Here
//      the dates ARE the subject: `effectiveTo: null` is the only "this is the
//      current row" signal the table has, and a correction entered ahead of
//      time opens a row that is not yet what a learner is served.
//
//   2. A CORRECTION IS A NEW ROW, NOT AN EDIT. Nothing in this file names an
//      answer row to update; the address of a correction is the SLOT
//      (`questionId` + `stateCode`). The response's `previous`/`current` pair
//      is what lets the UI say the previous answer was closed rather than
//      overwritten — see `civics-content.md` §4.
// =============================================================================

/**
 * The two scopes this surface administers.
 *
 * `none` is absent on purpose, and its absence is load-bearing: a static answer
 * is corrected through a reviewed content change, and `PUT` rejects a
 * `none`-scope question with a 400 (`civics-content.md` §9).
 */
export type CivicsAdminScope = 'national' | 'state';

/** One `civics_answers` row, as an administrator sees it. */
export interface CivicsDynamicAnswer {
  id: string;
  /** The accepted answer, verbatim. */
  text: string;
  /** Which slot this row occupies. Always `0` for well-formed dynamic content. */
  sort: number;
  /** The state this answer is for, or null for a `national` answer. */
  stateCode: string | null;
  /** When a human last confirmed this text against the authoritative source. */
  verifiedAt: string;
  /** When this became correct IN THE REAL WORLD — not when the row was written. */
  effectiveFrom: string;
  /** When it stopped being correct, or null for the OPEN row. */
  effectiveTo: string | null;
  /** The citation this row's text and dates come from. */
  sourceNote: string | null;
}

/** The question fields an administrator needs to recognise what they are editing. */
export interface CivicsDynamicQuestion {
  questionId: string;
  testVersionCode: string;
  /** The official question number within its version — how a reviewer names it. */
  number: number;
  prompt: string;
  categoryId: string;
  dynamicScope: CivicsAdminScope;
}

/** One question with every answer that is currently OPEN for it. */
export interface CivicsDynamicAnswerItem extends CivicsDynamicQuestion {
  /**
   * The open row per slot — one for a `national` question, one per state that
   * has an answer for a `state` question.
   */
  answers: CivicsDynamicAnswer[];
  /**
   * State codes with NO open answer — the gap list.
   *
   * Empty for a `national` question. A learner in one of these states currently
   * has an unanswerable question, which is invisible anywhere else.
   */
  missingStateCodes: string[];
}

/** `GET /api/civics/dynamic-answers` — the flat paginated list body. */
export interface CivicsDynamicAnswerPage {
  items: CivicsDynamicAnswerItem[];
  /** Counts QUESTIONS, not answer rows: a state question's 56 answers are one unit. */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Civics content — the question bank the learner reads (epic #51, API #111)
// =============================================================================
//
// Shaped field for field from `apps/api/src/civics/dto/`, not from memory. The
// three DTO files there are the contract; these interfaces are the browser's
// half of it, and nothing else in the web app may invent a field name for this
// domain.
//
// THERE IS NO `testVersionCode` INPUT AND NO `stateCode` INPUT ANYWHERE BELOW.
// Both resolution inputs are read server-side from the caller's own
// `learner_profiles` row (`civics-content.md` §8), and the query DTO is a
// `z.strictObject`, so an invented `?stateCode=TX` is a 400 rather than a
// parameter something might one day start honouring.
// =============================================================================

/** How a question's answers vary. A property of the question, fixed at transcription. */
export type CivicsDynamicScope = 'none' | 'national' | 'state';

/** One `civics_categories` row — `GET /api/civics/versions/:code/categories`. */
export interface CivicsCategory {
  id: string;
  /** The exam's top-level grouping, verbatim from USCIS — e.g. `AMERICAN GOVERNMENT`. */
  section: string;
  /** A stable slug, e.g. `principles_of_american_democracy`. */
  code: string;
  name: string;
  /**
   * Render order within the version.
   *
   * The official categories are NOT alphabetical (Government precedes History
   * precedes Integrated Civics). The rows arrive already sorted by it; it is on
   * the wire so a client that groups locally can put them back.
   */
  sortOrder: number;
}

/** One row of `GET /api/civics/questions`. No answers — those are per-caller. */
export interface CivicsQuestionSummary {
  id: string;
  /** The official question number within its version — `1..100` on `v2008`. */
  number: number;
  prompt: string;
  categoryId: string;
  testVersionCode: string;
  /** Membership in the 65/20 accommodation's subset. Never affects answers. */
  seniorEligible: boolean;
  dynamicScope: CivicsDynamicScope;
}

/** One resolved answer. Only currently-correct rows ever appear. */
export interface CivicsAnswer {
  id: string;
  text: string;
  /** Which slot this answer occupies among simultaneously accepted ones. */
  sort: number;
  /** The state this answer is for, or null for a national or static answer. */
  stateCode: string | null;
  /** When a human reviewer last confirmed this exact text. `current as of …`. */
  verifiedAt: string;
  /** The citation this row's text and dates come from. Public on purpose. */
  sourceNote: string | null;
}

/**
 * Whether the answers below are THIS caller's answers, and if not, why.
 *
 * `state_required` is the case a client MUST handle: a `state`-scope question
 * asked by a learner with no `state_code` on their profile. `answers` is empty
 * and `verifiedAt` is null. Render the question with a prompt to set their
 * state — never an error, never a blank, and never another state's answer.
 */
export type CivicsAnswerResolution = 'resolved' | 'state_required';

/** `GET /api/civics/questions/:id`. */
export interface CivicsQuestionDetail extends CivicsQuestionSummary {
  /** The question's category, inlined — one screen, one round trip. */
  category: CivicsCategory;
  answerResolution: CivicsAnswerResolution;
  /**
   * The state code the answers were resolved against, or null.
   *
   * Null for a `none`- or `national`-scope question AND for an unresolved one;
   * `answerResolution` is what tells those apart. It exists so a learner who
   * moved and forgot to update their plan can see WHICH state they are reading.
   */
  resolvedForStateCode: string | null;
  /**
   * The most recent `verifiedAt` across the resolved answers, or null.
   *
   * DERIVED SERVER-SIDE. "Current as of …" renders from this one field rather
   * than from a max the browser computes, so two screens cannot disagree about
   * how fresh the same fact is.
   */
  verifiedAt: string | null;
  /** Every currently accepted answer, in slot order. Empty on `state_required`. */
  answers: CivicsAnswer[];
}

/** `GET /api/civics/questions` — the `flat` pagination shape, as `/allowlist`. */
export interface CivicsQuestionListResponse {
  items: CivicsQuestionSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** `PUT /api/civics/dynamic-answers` — the request body. */
export interface CivicsAnswerCorrection {
  questionId: string;
  /** Required for a `state` question, REJECTED for a `national` one. */
  stateCode?: string;
  text: string;
  /** REQUIRED. The citation the new text and its date come from. */
  sourceNote: string;
  /**
   * `YYYY-MM-DD` or a full ISO timestamp — the real-world date of the change.
   *
   * Omitted, the server clock stands in, which is the honest value when no
   * precise date is knowable. Never sent as `''`: an empty string is not a
   * date, and the field is omitted instead.
   */
  effectiveFrom?: string;
}

/** `PUT /api/civics/dynamic-answers` — the closed row and the newly opened one. */
export interface CivicsAnswerCorrectionResult extends CivicsDynamicQuestion {
  stateCode: string | null;
  /**
   * The row this write CLOSED, already carrying its new `effectiveTo` — or null
   * when the slot had no open row (the gap `missingStateCodes` reports).
   *
   * On the wire so the UI can say what was superseded rather than reading like
   * the in-place edit the lifecycle refuses to perform.
   */
  previous: CivicsDynamicAnswer | null;
  /** The row this write OPENED. Now the current answer. */
  current: CivicsDynamicAnswer;
}

// =============================================================================
// Practice — sessions, attempts and the deterministic verdict (epic #52)
// =============================================================================
//
// Hand-written mirrors of `apps/api/src/practice/dto/*.ts`. This application
// generates no client, so these are transcriptions, and they are transcribed
// FIELD BY FIELD against those Zod schemas rather than approximated — the same
// discipline the civics and journey blocks above follow.
//
// -----------------------------------------------------------------------------
// THE ONE PROPERTY OF THIS BLOCK THAT IS LOAD-BEARING
// -----------------------------------------------------------------------------
//
// `PracticeQuestion` HAS NO ANSWER FIELD, and it must never grow one. The API
// carries a compile-time proof of exactly that (`practice-question.dto.ts`'s
// `PracticeQuestionCarriesNoAnswer`), because the failure is silent and total:
// the endpoints keep returning 200, every test keeps passing, and the product
// quietly stops being a practice product. `docs/specs/practice-sessions.md` and
// `VISION.md` both put it plainly — if the accepted answer is in the payload
// that carries the prompt, the exercise is multiple choice wearing a text box,
// and recognition is not preparation.
//
// The web half of that promise is `PracticeSessionState.nextQuestion` being
// this type and nothing wider, and `PracticeSessionPage` never fetching a
// question detail. The answers appear in exactly two shapes, both of which
// arrive only AFTER an attempt has been recorded:
// `PracticeAttemptResult.acceptedAnswers` and `PracticeAttempt.answerSnapshot`.
// =============================================================================

/** How a question's answers vary. Same three values as `CivicsDynamicScope`. */
export type PracticeDynamicScope = 'none' | 'national' | 'state';

/**
 * A question as practice serves it: THE PROMPT AND NOTHING ELSE.
 *
 * No answers, no `answerResolution`, no `verifiedAt`, no `testVersionCode` (the
 * enclosing session already names exactly one). See this block's header.
 */
export interface PracticeQuestion {
  id: string;
  /** The official number within its version — `1..100` on `v2008`. */
  number: number;
  prompt: string;
  categoryId: string;
  dynamicScope: PracticeDynamicScope;
}

/** One accepted answer, frozen into an attempt's snapshot as it stood then. */
export interface PracticeSnapshotAnswer {
  id: string;
  text: string;
  /** The answer slot's order, as the server sent it. Never re-sorted here. */
  sort: number;
  /** Set when the answer is state-specific; null for a national one. */
  stateCode: string | null;
  verifiedAt: string;
}

/**
 * What an attempt was graded AGAINST, frozen at the instant it was graded.
 *
 * Never re-resolved. A dynamic answer ("who is the Speaker of the House")
 * changes by design (`civics-content.md` §4), and a debrief that re-resolved it
 * would tell a learner they used to be wrong about something they still know.
 */
export interface PracticeAnswerSnapshot {
  resolvedAt: string;
  /** `state_required` means no answer could be resolved — NOT that there is none. */
  answerResolution: CivicsAnswerResolution;
  resolvedForStateCode: string | null;
  answers: PracticeSnapshotAnswer[];
}

/** `correct` | `partial` | `incorrect` | `skipped`. `partial` is E4's. */
export type PracticeOutcome = 'correct' | 'partial' | 'incorrect' | 'skipped';

/**
 * Who or what made the call. Read TOGETHER with `outcome`, never merged into it.
 *
 * "Was it right" and "how do we know" are independent facts: a summary tally
 * needs only the first, and E5's mastery model must discount `self` against the
 * other two (`practice-sessions.md` §9).
 */
export type PracticeGradingMethod = 'exact' | 'self' | 'ai';

/**
 * Why a response missed, when a grader actually ran — `PracticeFailureCause`.
 *
 * SIX VALUES, and this build renders all six even though only four can be
 * produced today: `misheard` needs E9's transcription confidence and `nervous`
 * needs E8's interview timing, so `grading.ts` coerces a model that offers
 * either one to `unknown`. A row written by a later epic must still be
 * readable by a browser holding this bundle — the same argument
 * `components/practice/outcome.ts` makes for its own open-set lookups.
 *
 * NULL AND `unknown` ARE DIFFERENT ANSWERS and must never be collapsed. Null
 * (the field's type on `PracticeAttempt`) means no grader ran at all —
 * `gradingMethod: 'exact'` or `'self'`. `unknown` means one ran, returned a
 * valid verdict, and honestly could not tell which of the other five this was.
 * `ai-evaluation.md` §8: one is an absence of evidence, the other is evidence
 * of ambiguity.
 */
export type PracticeFailureCause =
  | 'not_known'
  | 'not_recalled'
  | 'expression'
  | 'misheard'
  | 'nervous'
  | 'unknown';

/**
 * The grader's structured verdict, verbatim — `gradingVerdictSchema` on the
 * API, and exactly three fields.
 *
 * NOT ONE OF THEM CAN CARRY AN ANSWER. There is no `correctAnswer`, no
 * `alsoAccept`, no free-form field except `feedback`, which is one sentence for
 * the learner and is never promoted to truth (`ai-evaluation.md` §7). The
 * accepted answers on this screen come from the attempt's own frozen snapshot,
 * never from anything a model said.
 */
export interface PracticeAiFeedback {
  verdict: 'correct' | 'partial' | 'incorrect';
  failureCause: PracticeFailureCause;
  /** One short sentence, capped at 240 characters server-side. */
  feedback: string;
}

/** One row of `practice_attempts` — the evidence every later epic reads. */
export interface PracticeAttempt {
  id: string;
  /** Null for an attempt with no session (E8's mock-interview shape). */
  sessionId: string | null;
  questionId: string;
  /** The prompt travels with the attempt, so a debrief needs no second read. */
  question: PracticeQuestion;
  source: 'practice' | 'mock_interview';
  inputMode: 'typed' | 'spoken';
  promptMode: 'read' | 'heard';
  /** The learner's raw input, verbatim, or null for a skip. */
  responseText: string | null;
  outcome: PracticeOutcome;
  gradingMethod: PracticeGradingMethod;
  /** The learner had the accepted answer in front of them for this question. */
  revealed: boolean;
  hintUsed: boolean;
  /** Milliseconds, or null when the client could not report one. Never 0. */
  durationMs: number | null;

  // ---------------------------------------------------------------------------
  // The AI grading rung's output — ALL THREE NULL TOGETHER (issue #116, E4)
  // ---------------------------------------------------------------------------
  //
  // A DETERMINISTICALLY GRADED ATTEMPT CARRIES NULL FOR ALL THREE, and that is
  // the ordinary case rather than a degraded one: `gradingMethod: 'exact'` (a
  // match, a skip, or a miss whose grading call was unavailable or failed) and
  // `gradingMethod: 'self'` never produce any of these values.
  //
  // Nullable rather than optional, mirroring the DTO exactly, and for the
  // reason the whole ladder exists: a client that received an ABSENT field
  // could reasonably render a placeholder cause behind nothing, and the one
  // thing this product must not do is show a learner a diagnosis of themselves
  // that no grader ever made. `null` is a value a component can branch on.

  /** Why the response missed, when a grader ran. Never a guess. */
  failureCause: PracticeFailureCause | null;

  /** The grader's verdict, verbatim. See {@link PracticeAiFeedback}. */
  aiFeedback: PracticeAiFeedback | null;

  /**
   * The `ai_usage_events` row this attempt's grading call produced, for
   * tracing a verdict to what it cost. Null when no call was made AND when the
   * usage write itself failed — nothing on screen reads it.
   */
  aiUsageEventId: string | null;

  // ---------------------------------------------------------------------------
  // Voice (issue #104, epic #58 / E9)
  // ---------------------------------------------------------------------------

  /**
   * For a spoken attempt: the text the learner CONFIRMED they said.
   *
   * Null for a typed attempt and for a skip — there was no recognition step to
   * record. The CONFIRMED text, not the recogniser's raw output: the learner
   * saw it and could edit it before anything was graded, which is the whole
   * anti-penalty mechanism behind `docs/specs/voice.md` §3.
   */
  transcript: string | null;

  /**
   * How sure the recogniser was about that transcription, 0..1 — or null.
   *
   * NULL MEANS UNKNOWN, NEVER ZERO, exactly as on {@link SpeechTranscription}.
   * On the wire so a client can explain its own behaviour to itself, NEVER so
   * it can be shown to a learner as a number: "41% confident" is a diagnostic
   * detail somebody studying for a naturalization interview has no way to act
   * on. What they see is the transcript, editable.
   */
  asrConfidence: number | null;

  /**
   * The earlier attempt this one supersedes, or null.
   *
   * Set only on a retry. The superseded attempt stays in the table — it is
   * evidence that a mishearing happened — but the server excludes it from
   * `progress.answered` and from the stored summary, so a mishearing and its
   * correction read as ONE answered question.
   */
  retryOfAttemptId: string | null;

  answeredAt: string;
  answerSnapshot: PracticeAnswerSnapshot;
}

/**
 * The tally a completed session persists — computed by the server from the
 * attempt rows that were actually written, never from anything a client sent.
 *
 * A cached rendering, so the summary screen need not re-aggregate. If it ever
 * disagreed with the attempts, the attempts are right.
 */
export interface PracticeSessionSummary {
  plannedCount: number;
  answered: number;
  correct: number;
  partial: number;
  incorrect: number;
  skipped: number;
  /** Of the correct ones, how many were the learner's own call. */
  selfMarked: number;
  revealed: number;
  hintUsed: number;
  /** Null — never 0 — when no attempt reported a duration. */
  totalDurationMs: number | null;
  /** How many attempts `totalDurationMs` covers, so a partial total reads as one. */
  timedAttempts: number;
}

/**
 * `quick` and `category` are the only kinds E3 produces.
 *
 * `review`, `weak` and `mixed` are declared in the database (and here) for E5's
 * spaced-repetition scheduler; the create endpoint REFUSES them today with a
 * 400. They are in this union because a session row read back could carry one
 * once E5 ships, and a client that narrowed the union would fail to render its
 * own history.
 */
export type PracticeSessionKind =
  | 'quick'
  | 'category'
  | 'review'
  | 'weak'
  | 'mixed';

export type PracticeSessionStatus = 'in_progress' | 'completed' | 'abandoned';

export interface PracticeSession {
  id: string;
  kind: PracticeSessionKind;
  status: PracticeSessionStatus;
  testVersionCode: string;
  /** Set only for a `category` session. */
  categoryId: string | null;
  plannedCount: number;
  startedAt: string;
  completedAt: string | null;
  /** Null while `in_progress` — there is nothing to summarise yet. */
  summary: PracticeSessionSummary | null;
}

/**
 * A row of the recent-sessions list.
 *
 * Carries LIVE counts alongside the stored `summary`, because an `in_progress`
 * or `abandoned` session has no summary and still has real attempts behind it:
 * a learner who answered three of five and left should see three, not a blank
 * row.
 */
export interface PracticeSessionListItem extends PracticeSession {
  answeredCount: number;
  correctCount: number;
}

/**
 * How far through the session the learner is.
 *
 * `answered` is counted from the persisted attempts on EVERY response, never
 * incremented in the browser — so two tabs and a resumed session all agree.
 */
export interface PracticeProgress {
  answered: number;
  planned: number;
}

/** What `POST /api/practice/sessions` answers with. */
export interface PracticeSessionState {
  session: PracticeSession;
  /** Prompt only, and null once the session has nothing left to ask. */
  nextQuestion: PracticeQuestion | null;
  progress: PracticeProgress;
}

/** `GET /api/practice/sessions/:id` — resume, or review afterwards. */
export interface PracticeSessionDetail extends PracticeSessionState {
  /** Oldest first — the order they were answered in. */
  attempts: PracticeAttempt[];
}

/** `GET /api/practice/sessions` — the flat pagination shape. */
export interface PracticeSessionPage {
  items: PracticeSessionListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * `POST /api/practice/sessions/:id/attempts` — the graded attempt.
 *
 * `acceptedAnswers` is here and NOWHERE EARLIER. This is the moment the answer
 * has been earned: the learner has produced a response (or skipped, or
 * revealed) and the attempt is already recorded, so showing them what was
 * accepted is feedback rather than a hint.
 */
export interface PracticeAttemptResult {
  attempt: PracticeAttempt;
  /** What the grade was made against. Empty on `state_required`. */
  acceptedAnswers: PracticeSnapshotAnswer[];
  nextQuestion: PracticeQuestion | null;
  progress: PracticeProgress;
}

/** `POST /api/practice/sessions` — the request body. */
export interface CreatePracticeSessionInput {
  /** Only these two are accepted; anything else is a 400. */
  kind: 'quick' | 'category';
  /** REQUIRED when `kind` is `category`, REJECTED otherwise. */
  categoryId?: string;
  /** Defaults to 5 server-side, and is clamped down to what is available. */
  plannedCount?: number;
}

/**
 * `POST /api/practice/sessions/:id/attempts` — the request body.
 *
 * THERE IS NO VERDICT FIELD, and there must never be one. The server re-runs
 * the matcher itself; the only route by which a learner's own judgement enters
 * the record is the separate self-mark endpoint, which stamps
 * `gradingMethod: 'self'` precisely so E5 can weigh it differently.
 */
export interface RecordPracticeAttemptInput {
  questionId: string;
  /** OMITTED for a skip — a skip carrying text is a 400, not a silent choice. */
  responseText?: string;
  /** OMITTED, never `0`, when the client cannot measure it. */
  durationMs?: number;
  skipped?: boolean;
  revealed?: boolean;
  hintUsed?: boolean;

  // ---------------------------------------------------------------------------
  // Voice (issue #104, epic #58 / E9)
  // ---------------------------------------------------------------------------
  //
  // Five client-reported facts, and NOT ONE OF THEM IS A VERDICT — the rule
  // above still holds. The server cannot observe any of them for itself for
  // one concrete reason: the recording never reaches it (`voice.md` §4, and
  // `useAudioCapture`'s header), so there is no artefact anywhere from which
  // "was this spoken", "was the prompt heard", or "how well was it heard"
  // could be reconstructed later. Not sending them now means they are gone.
  //
  // All five are OPTIONAL, and the server defaults `inputMode`/`promptMode` to
  // the pre-E9 values, so a caller that knows nothing about voice keeps writing
  // exactly the row it always wrote.
  //
  // THE SERVER REJECTS COMBINATIONS THAT CONTRADICT EACH OTHER (a 400), and a
  // caller should mirror the rules rather than discover them: `transcript` and
  // `asrConfidence` only with `inputMode: 'spoken'`; a non-skipped spoken
  // attempt MUST carry a `transcript`; a skip carries neither.

  /** How the answer was produced. Defaults to `typed` server-side. */
  inputMode?: 'typed' | 'spoken';

  /** How the QUESTION reached the learner. Defaults to `read` server-side. */
  promptMode?: 'read' | 'heard';

  /**
   * The transcript the learner CONFIRMED, after seeing and being able to edit
   * it. Never the recogniser's raw output as it arrived.
   */
  transcript?: string;

  /**
   * The recogniser's confidence, 0..1.
   *
   * OMITTED — never `0` — when the recogniser did not report one. A defaulted
   * `0` is not inert: it is below the threshold the server reads as a probable
   * mishearing, so it would route a perfectly good answer to
   * `failureCause: 'misheard'`. See {@link SpeechTranscription.confidence}.
   */
  asrConfidence?: number;

  /**
   * This attempt supersedes an earlier attempt at the same question in the
   * same session.
   *
   * The one legitimate second attempt at a question inside one session. The
   * server admits it only when it names THIS caller's attempt, in THIS session,
   * at THIS question, which is not itself a retry and has not already been
   * superseded — a 409 otherwise, and a 404 for anybody else's id.
   */
  retryOfAttemptId?: string;
}

// =============================================================================
// Practice queue counts — `GET /api/practice/queue` (issue #78, epic #54 / E5)
// =============================================================================
//
// Mirrors `apps/api/src/practice/dto/practice-queue.dto.ts` field for field.
// Every count comes from `mastery/selector.ts`'s `classifyMasteryBucket` — the
// SAME function `POST /api/practice/sessions` uses to order a session's
// questions — so this can never disagree with what starting a session right
// now would actually select. There is no `kind: 'review' | 'weak' | 'mixed'`
// request this page can make yet: those `PracticeSessionKind` values are
// declared but unwired (`CLAUDE.md`'s "Adding a practice session kind"), so
// `/practice` biases its existing `quick`/`category` actions toward this data
// rather than requesting a kind the API would 400 on.

/** One category's share of the `new` bucket — never-attempted questions. */
export interface PracticeQueueCategoryCount {
  categoryId: string;
  categoryName: string;
  newCount: number;
}

/** `GET /api/practice/queue` — flat counts, not a list, so no page envelope. */
export interface PracticeQueue {
  /** The caller's own resolved test version — never sent, only read back. */
  testVersionCode: string;
  /** The whole bank's size, scoped exactly like session creation is. */
  total: number;
  /** `state IN (review, lapsed)` with `dueAt` already passed. */
  due: number;
  /** A `lapsed` question (any `dueAt`), or a struggling `learning`/`review` one. */
  weak: number;
  new: {
    total: number;
    /** In the test version's own category order — never re-sorted. */
    byCategory: PracticeQueueCategoryCount[];
  };
  /** Attempted, not due, not weak, not yet mastered. */
  learning: number;
  mastered: number;
}

// =============================================================================
// Progress — `GET /api/progress/mastery` (issue #94, epic #54 / E5 "Memory")
// =============================================================================

/**
 * The five buckets `question_mastery.state` and `mastery/scheduler.ts`'s own
 * `MasteryState` union already use. A string, not a closed union, for the
 * same open-set reason `PracticeOutcome`-adjacent types in this file take one:
 * a browser holding this bundle must still render a sixth state a later
 * migration adds, rather than fail to compile against rows it has never seen.
 */
export type MasteryState = 'new' | 'learning' | 'review' | 'lapsed' | 'mastered';

/** Every question in some scope, bucketed by the caller's own mastery state. */
export type MasteryStateCounts = Record<MasteryState, number>;

/** One category's coverage and mastery — one row of `ProgressMastery.categories`. */
export interface ProgressMasteryCategory {
  categoryId: string;
  categoryName: string;
  /** How many of this category's questions exist in the caller's test version. */
  totalQuestions: number;
  byState: MasteryStateCounts;
  /** Convenience duplicate of `byState.mastered`. */
  masteredCount: number;
}

/** `GET /api/progress/mastery` — the caller's coverage and mastery, by category. */
export interface ProgressMastery {
  /** Which bank this is scoped to — the caller's own resolved test version. */
  testVersionCode: string;
  /** The whole bank's size for this test version. */
  totalQuestions: number;
  /** `totalQuestions - byState.new`. */
  attempted: number;
  byState: MasteryStateCounts;
  /** In the same render order `GET /api/civics/versions/{code}/categories` uses. */
  categories: ProgressMasteryCategory[];
}

// =============================================================================
// Readiness — `GET /api/readiness`, `GET /api/readiness/history`
// (issues #139/#142, epic #55 / E6 "Readiness and Progress")
// =============================================================================
//
// Mirrors `apps/api/src/readiness/dto/readiness-snapshot.dto.ts` and
// `dto/readiness-history-query.dto.ts` field for field —
// `docs/specs/readiness-model.md` §2, §4, §5, §8 is the design these types
// are a wire mapping of, not a re-derivation of it.
//
// `spoken`/`interview` are STRUCTURALLY ZERO until E9/E8 ship (§2.7-§2.8),
// and `english` is real as of E10 (`docs/specs/english-test.md` §6) but still
// reads `0` for a learner with no reading or writing practice in its 30-day
// window — the frontend's own honesty rule (matching `ProgressMastery`'s own
// empty-state convention) is to render "No evidence yet" for those three
// rather than a `0%` presented as a failing score, and, for `english`, to do
// so ONLY when nothing was attempted. See `components/progress/readiness.ts`.

/**
 * The eight components, in the exact order `readiness-engine.ts`'s own
 * `READINESS_COMPONENT_KEYS` declares them. The order is load-bearing beyond
 * readability there (it is the tie-break order for `topRecommendation`); here
 * it is reused only as the render order a client is expected to iterate in.
 */
export type ReadinessComponentKey =
  | 'coverage'
  | 'recall'
  | 'retention'
  | 'consistency'
  | 'remediation'
  | 'english'
  | 'spoken'
  | 'interview';

/** One component's normalized value, its weight, and what it contributed. */
export interface ReadinessComponentResult {
  /** Normalized `[0, 1]`. */
  value: number;
  weight: number;
  /** `value * weight`. */
  contribution: number;
}

export type ReadinessComponents = Record<ReadinessComponentKey, ReadinessComponentResult>;

/**
 * `english`'s evidence, as E10 computes it (`docs/specs/english-test.md`
 * §6.2), fed by the `english_attempts` table.
 *
 * The two sentence counts are distinct sentences ATTEMPTED in the trailing
 * 30-day window; the two credit values are what those attempts earned (a
 * `correct` sentence scores `1.0`, a `partial` `0.5` — so the credit fields
 * are deliberately NOT integers, exactly as the API's own zod schema notes).
 *
 * The counts exist so a renderer can tell "no practice yet" apart from
 * "practised and missed" — both earn `0` credit and both score the component
 * at `0`, but only one of them is an absence of evidence.
 */
export interface ReadinessEnglishEvidence {
  readingSentences: number;
  writingSentences: number;
  readingCredit: number;
  writingCredit: number;
}

/**
 * `english`'s PRE-E10 evidence shape, kept because it is still on the wire —
 * not as history.
 *
 * `GET /api/readiness/history` NEVER recomputes a stored snapshot (it casts
 * the row it read rather than re-parsing it), so snapshots written before E10
 * deployed keep serving this field verbatim, forever. A client reading the
 * history list across that deploy boundary therefore sees BOTH shapes in one
 * response, which is why `ReadinessEvidenceCounts['english']` is a union
 * rather than the new shape alone: narrowing is forced at the one place that
 * reads it (`components/progress/readiness.ts`) instead of left to a runtime
 * check a future edit could quietly drop.
 *
 * The retired field counted civics answers spoken in English and was always a
 * literal `0`, so a legacy row means exactly "no evidence" — see
 * `readinessEnglishSentencesAttempted`.
 */
export interface LegacyReadinessEnglishEvidence {
  distinctQuestionsCorrectSpokenInEnglish: number;
}

/** §5's `evidenceCounts` table, one shape per component, verbatim. */
export interface ReadinessEvidenceCounts {
  coverage: { distinctQuestionsAttempted: number; totalQuestionsInVersion: number };
  recall: {
    qualifyingAttempts: number;
    correctCount: number;
    partialCount: number;
    incorrectCount: number;
    skippedCount: number;
  };
  retention: { masteredCount: number; reviewCount: number; totalAttemptedQuestions: number };
  consistency: { distinctPracticeDaysInLast14: number };
  remediation: { everWeakCount: number; remediatedCount: number };
  english: ReadinessEnglishEvidence | LegacyReadinessEnglishEvidence;
  spoken: { attempts: number };
  interview: { attempts: number };
}

/**
 * `'typed_only'` while there is no spoken-answer or mock-interview evidence
 * at all (§3); `null` the instant either kind exists, even one attempt.
 */
export type ReadinessCapReason = 'typed_only' | null;

/**
 * §8.2 — the single next action a snapshot recommends. `componentKey: null`
 * means the fixed cap message (§3), verbatim, not a component pick — title,
 * reason and path are ALWAYS rendered as the server wrote them, the same
 * "the server wrote the copy" discipline `NextUpCard` already follows for
 * `nextAction`.
 */
export interface ReadinessTopRecommendation {
  componentKey: ReadinessComponentKey | null;
  title: string;
  reason: string;
  path: string;
}

/** `GET /api/readiness`, and one row of `GET /api/readiness/history`. */
export interface ReadinessSnapshotResponse {
  id: string;
  /** When this snapshot was computed — `Clock.now()`, ISO 8601. */
  computedAt: string;
  /** 0-100. */
  score: number;
  /** The learner's `JourneyStage` at the moment this snapshot was computed. */
  stage: JourneyStageKey;
  components: ReadinessComponents;
  evidenceCounts: ReadinessEvidenceCounts;
  capReason: ReadinessCapReason;
  topRecommendation: ReadinessTopRecommendation;
  /**
   * The Progress Guide's one AI-generated paragraph (issue #134). `null`
   * whenever AI is unavailable or not yet generated — absence is silent,
   * never rendered as an error (`docs/specs/readiness-model.md` §9).
   */
  narrative: string | null;
  narrativeGeneratedAt: string | null;
}

/**
 * `GET /api/readiness/history` — the same flat pagination shape
 * `PracticeSessionPage` and `AllowlistResponse` already use, newest first.
 */
export interface ReadinessHistoryResponse {
  items: ReadinessSnapshotResponse[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// =============================================================================
// Engagement — `GET /api/engagement/summary`
// (issue #138, epic #56 / E7 "Habit")
// =============================================================================
//
// Mirrors `apps/api/src/engagement/dto/engagement-summary.dto.ts` field for
// field. NOTHING readiness-shaped is here, and that is structural rather than
// incidental: `docs/specs/habit-streaks.md` §1 keeps engagement out of the
// readiness engine's inputs entirely, and §8 keeps readiness's vocabulary off
// the surfaces these types feed. There is no `score` on this shape to render,
// and no client-side arithmetic that could manufacture one.
// =============================================================================

/** Today's row — always present, with honest zeros for a day nothing has happened on. */
export interface EngagementDay {
  /** `YYYY-MM-DD` — a LOCAL calendar day in `timezone`, never an instant. */
  date: string;
  practiceSeconds: number;
  attempts: number;
  correct: number;
  /** Monotonic: once true for a day, never false again. */
  goalMet: boolean;
}

/** One of the last 14 local days — a day with no row reports zeros. */
export interface EngagementRecentDay {
  date: string;
  goalMet: boolean;
  /** True only for a day settlement covered with a freeze — a recorded freeze, never a fabricated practice day. */
  freezeUsed: boolean;
  practiceSeconds: number;
}

/** `GET /api/engagement/summary`. */
export interface EngagementSummary {
  /** The learner's own daily goal, in minutes — what the ring is measured against. */
  dailyGoalMinutes: number;
  today: EngagementDay;
  streak: {
    /** Consecutive qualifying local days ending today OR yesterday. */
    current: number;
    /** The longest such run anywhere in this learner's history. */
    longest: number;
  };
  freezes: {
    /** Held right now. Protection the learner already has — never a countdown. */
    remaining: number;
    /** The ceiling, sent by the server so no client hardcodes it. */
    max: number;
  };
  /** The IANA zone every `date` above was computed in. */
  timezone: string;
  /** The last 14 local days, OLDEST FIRST. */
  recentDays: EngagementRecentDay[];
}

// =============================================================================
// Mock interview — `POST /api/interviews`, `GET /api/interviews/:id`,
// `POST /api/interviews/:id/complete` (issue #140, epic #57 / E8)
// =============================================================================
//
// Hand-written mirrors of `apps/api/src/interviews/dto/interview.dto.ts` and
// `dto/interview-debrief.dto.ts`, transcribed FIELD BY FIELD against those Zod
// schemas rather than approximated — the same discipline the practice, civics
// and readiness blocks above follow. The SSE frames the turn endpoint answers
// with are NOT here: they live in `services/interviewStream.ts` beside the
// decoder that produces them, exactly as the explain frames live in
// `services/explainStream.ts`.
//
// -----------------------------------------------------------------------------
// THE ONE PROPERTY OF THIS BLOCK THAT IS LOAD-BEARING
// -----------------------------------------------------------------------------
//
// **NO SHAPE HERE CARRIES A VERDICT WHILE THE INTERVIEW IS RUNNING.** There is
// no outcome field on {@link InterviewTurnRecord}, no `civicsCorrect` on
// {@link InterviewProgress}, and {@link InterviewDetail.debrief} is null until
// the interview is `completed`. That is `docs/specs/mock-interview.md` §10 as a
// shape rather than as a rule somebody has to remember: the engine knew whether
// each answer was right the moment it graded it, recorded it, and used it to
// choose the next question — and deliberately does not send it, because the
// real interview gives no per-question feedback and a rehearsal that does is
// coaching a learner to expect reassurance the actual event will never give.
//
// A client that widened any of these types "so the screen can show progress
// better" would defeat that from this end, with every endpoint still returning
// 200 and every other test still passing.
// =============================================================================

/** `mock_interviews.status`. */
export type InterviewStatus = 'in_progress' | 'completed' | 'abandoned';

/** Text or voice. `text` for every interview this epic can produce; E9/E11 wire the other. */
export type InterviewMode = 'text' | 'voice';

/**
 * The six phases of an interview, in the order they are conducted.
 *
 * `reading` and `writing` are DECLARED AND SKIPPED in text mode: the officer
 * says plainly that this rehearsal does not include those tests yet, and the
 * phase is recorded as `skipped` rather than omitted. A learner who was never
 * told they exist could walk into the real interview believing they rehearsed a
 * segment they never saw — `mock-interview.md` §2.4 states the cost in full,
 * and it is why the web renders those turns honestly instead of hiding them.
 */
export type InterviewPhase =
  | 'smalltalk'
  | 'n400'
  | 'civics'
  | 'reading'
  | 'writing'
  | 'closing';

/** Who spoke. */
export type InterviewTurnRole = 'officer' | 'applicant';

/** Why the civics phase ended — the engine's own stop rule. */
export type InterviewStopReason =
  | 'threshold_reached'
  | 'threshold_unreachable'
  | 'all_asked';

/**
 * One interview's header row.
 *
 * `passedCivics` is `false` on every `in_progress` row, which is honest rather
 * than premature — the civics phase has not finished, so it has not been
 * passed. Nothing on the live interview screen renders it; it belongs to the
 * debrief and to the history list (#145).
 */
export interface Interview {
  id: string;
  mode: InterviewMode;
  status: InterviewStatus;
  /** The bank and pass rule this interview was created against. */
  testVersionCode: string;
  /** Frozen from the profile at start time, never re-read at completion. */
  seniorExemption: boolean;
  /** The per-interview choice, made before the interview started (§8.1). */
  transcriptRetained: boolean;
  startedAt: string;
  completedAt: string | null;
  civicsAsked: number;
  civicsCorrect: number;
  passedCivics: boolean;
}

/**
 * One line of the transcript.
 *
 * `text` MAY BE EMPTY, AND EMPTY IS MEANINGFUL. With `transcriptRetained: false`
 * an applicant turn is written with `text: ''` deliberately (§8.2): the
 * interview's structure survives — a turn happened, in this phase, in this
 * order, naming this question — while the learner's own words do not.
 *
 * A renderer must therefore never present an empty applicant turn as "said
 * nothing". The web's answer is simpler than a disclaimer: the interview screen
 * renders the OFFICER's turns only, so there is no place for that
 * misreading to occur at all. See `InterviewPage.tsx`'s header.
 */
export interface InterviewTurnRecord {
  id: string;
  turnIndex: number;
  role: InterviewTurnRole;
  phase: InterviewPhase;
  /** Set only on a civics OFFICER turn — which question was read. */
  questionId: string | null;
  text: string;
  createdAt: string;
}

/**
 * How far through the civics section this interview is.
 *
 * PACING, NEVER SCORE. There is no `civicsCorrect` here even though the header
 * row above has one: "6 of 10 asked" is a fact the real interview also gives a
 * learner, and "4 of 6 correct" is a running score it never does.
 */
export interface InterviewProgress {
  civicsAsked: number;
  /** N, from the `civics_test_versions` row. Never a constant in this bundle. */
  civicsPlanned: number;
}

/** What `POST /api/interviews` returns: the interview and the opening turn. */
export interface InterviewState {
  interview: Interview;
  /**
   * The officer turns this exchange produced, in order — usually one.
   *
   * AN ARRAY BECAUSE ONE EXCHANGE CAN PRODUCE SEVERAL: the reading and writing
   * phases consume no applicant answer and neither does the closing statement,
   * so the last civics answer of an interview is followed by three officer
   * turns at once.
   */
  officerTurns: InterviewTurnRecord[];
  progress: InterviewProgress;
  /** True once the only remaining action is `complete`. */
  awaitingCompletion: boolean;
}

/** The civics section's result — only ever inside a debrief. */
export interface InterviewCivicsResult {
  /** N — how many questions the ask-list was drawn for. From the version row. */
  planned: number;
  /** How many the early stop or the exhausted plan actually reached. */
  asked: number;
  correct: number;
  /** T — how many had to be correct. From the version row, never a constant. */
  threshold: number;
  passed: boolean;
  /** True when `asked < planned` — the stop rule fired before the plan ran out. */
  stoppedEarly: boolean;
  stopReason: InterviewStopReason;
}

/** One civics question as it was actually asked and graded. */
export interface InterviewDebriefQuestion {
  questionId: string;
  number: number;
  prompt: string;
  categoryName: string;
  outcome: PracticeOutcome;
  /** From the FROZEN answer snapshot on the attempt row, never a live re-query. */
  acceptedAnswers: string[];

  /**
   * How this answer reached the officer — `practice_attempts.input_mode`
   * (issue #160, epic #60 / E11).
   *
   * PER QUESTION, NOT PER INTERVIEW: a dropped realtime connection falls back
   * to the text transport with the same interview id, so one interview can
   * genuinely carry both.
   */
  inputMode: 'typed' | 'spoken';

  /**
   * The recogniser was not confident it heard what was said —
   * `failure_cause: 'misheard'` on the row.
   *
   * A SEPARATE FACT FROM `outcome`, never a ninth outcome value. Both are
   * rendered: the outcome is what the grading ladder concluded about the words
   * it was given, and this is whether we believe those were the learner's.
   */
  misheard: boolean;

  /** The recogniser's own confidence. Null means UNKNOWN, never low. */
  asrConfidence: number | null;
}

/**
 * How the spoken half of this interview went — three counts over its own
 * `practice_attempts` rows (issue #160).
 *
 * `correct` is exactly what readiness's `spoken` component counts, which is
 * what lets the readiness band and the question list on one screen explain
 * each other.
 */
export interface InterviewSpokenSummary {
  answers: number;
  correct: number;
  misheard: number;
}

/**
 * One conducted English segment — the reading or the writing test, as scored
 * (issue #160).
 *
 * A segment the interview did not conduct is ABSENT, never an entry with
 * zeros: `phases` is where "this rehearsal did not include the reading test"
 * is said.
 */
export interface InterviewSegmentResult {
  kind: 'reading' | 'writing';
  outcome: 'correct' | 'partial' | 'incorrect';
  /** The sentence itself. For writing this is the reveal, read after the fact. */
  sentence: string;
  /** The word error rate the outcome was computed from. Never re-derived here. */
  wer: number;
}

/** Whether this rehearsal conducted a phase, or named it and skipped it. */
export interface InterviewPhaseStatus {
  kind: InterviewPhase;
  status: 'completed' | 'skipped';
}

/** The readiness recompute this completion produced. */
export interface InterviewReadinessSummary {
  score: number;
  previousScore: number | null;
  delta: number | null;
  capReason: ReadinessCapReason;
  /** The fixed cap copy, server-written, or null. Rendered verbatim. */
  capMessage: string | null;
  interviewComponent: { value: number; evidenceCount: number };
  /**
   * The `spoken` component — `min(distinctQuestionsCorrectSpoken / 20, 1)`.
   *
   * `evidenceCount` is the learner's LIFETIME count across every source, not
   * this interview's own. How many came from this interview is
   * `InterviewDebrief.spoken.correct`, and the two answer different questions.
   */
  spokenComponent: { value: number; evidenceCount: number };
  /** The snapshot's own next action, whole — never a subset chosen on screen. */
  recommendation: ReadinessTopRecommendation;
}

/**
 * The debrief — the FIRST moment any performance information exists where the
 * learner can see it.
 *
 * Declared here in full even though this epic's slice renders none of it: the
 * debrief screen is issue #145, and `InterviewDetail.debrief` below is typed
 * against this shape so that screen inherits a transcription that was checked
 * against the API's own Zod schema rather than one written from memory later.
 */
export interface InterviewDebrief {
  civics: InterviewCivicsResult;
  questions: InterviewDebriefQuestion[];
  /** How the spoken half went. All zeros on a text interview, never absent. */
  spoken: InterviewSpokenSummary;
  /** The segments this interview conducted, reading first. Empty in text mode. */
  segments: InterviewSegmentResult[];
  phases: InterviewPhaseStatus[];
  /** Category names with at least one miss. Deterministic, never model-written. */
  focusAreas: string[];
  readiness: InterviewReadinessSummary;
}

/**
 * What `GET /api/interviews/:id` returns — one route for a live interview and
 * for a finished one.
 *
 * `debrief` is null while the interview is not `completed`. A debrief available
 * mid-interview would be the verdict no turn frame is allowed to carry,
 * reachable through a second door.
 */
export interface InterviewDetail {
  interview: Interview;
  /** The whole transcript so far, oldest first. */
  turns: InterviewTurnRecord[];
  progress: InterviewProgress;
  awaitingCompletion: boolean;
  debrief: InterviewDebrief | null;
}

/**
 * The whole body of `POST /api/interviews`.
 *
 * ONE FIELD, and the omissions are the design: there is no `testVersionCode`
 * and no `seniorExemption`, because both are read from the caller's own
 * `learner_profiles` row and a request that could set either would let a
 * learner sit a smaller pool against a lower pass mark and be told they passed
 * a test they were never given.
 */
export interface CreateInterviewInput {
  /**
   * Whether this interview keeps the learner's own words. Defaults to `false`
   * in the DTO *and* at the database level; the web sends it explicitly anyway,
   * because on this screen it is a choice a learner actually made.
   */
  transcriptRetained?: boolean;
}

/**
 * A row in the caller's interview history — `GET /api/interviews`.
 *
 * The header row and nothing else, exactly as the API's own
 * `interviewListItemSchema` declares it (an alias of `interviewSchema`, not a
 * narrower shape). §12 states what the endpoint is for and therefore what a row
 * has to carry: "did I do better on my second mock interview than my first" is
 * the question, and `civicsAsked` / `civicsCorrect` / `passedCivics` on the
 * header already answer it. A learner who wants the per-question detail opens
 * the interview's debrief.
 *
 * Declared as its own name rather than used as `Interview` at the call site so
 * that the day the API narrows the list row — a real possibility, since a list
 * has no need for `transcriptRetained` — this alias is the one place that
 * changes.
 */
export type InterviewListItem = Interview;

/** `GET /api/interviews` — the same flat pagination shape every list uses. */
export interface InterviewPage {
  items: InterviewListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// =============================================================================
// English — `GET /api/english/next`, `POST /api/english/attempts`,
// `GET /api/english/progress` (issue #136, epic #59 / E10)
// =============================================================================
//
// Hand-written mirrors of `apps/api/src/english/dto/*.ts`, field for field
// against those Zod schemas rather than approximated — the same discipline the
// Practice and Interview blocks above already state for themselves.
//
// THE ONE PROPERTY OF THIS BLOCK THAT IS LOAD-BEARING
// ---------------------------------------------------
//
// `RecordEnglishAttemptInput` has FOUR fields and none of them is a verdict.
// There is no `outcome`, no `wer`, no `diff`, no `errors` — scoring happens on
// the server, against sentence text the client is not trusted to echo back, and
// `record-english-attempt.dto.ts` carries a compile-time proof that no
// verdict-shaped field can be added to it. A client that widened this type "so
// the screen can show the result sooner" would be a client that decides its own
// grade, and the evidence table E6 reads would record whatever it decided.
//
// `EnglishAttemptResult` is DISCRIMINATED ON `status`, and both arms are HTTP
// 200. `misheard` is NOT an outcome: it is the ABSENCE of a recorded failure —
// no `english_attempts` row was written at all (`docs/specs/english-test.md`
// §3). A caller that folded it into the failure branch would be showing a
// learner a failure the server deliberately declined to record.
// =============================================================================

/** Which segment of the interview a sentence belongs to. */
export type EnglishSegmentKind = 'reading' | 'writing';

/**
 * The three outcomes an `english_attempts` row can hold.
 *
 * THREE, not `PracticeOutcome`'s four: there is no `skipped` here. A declined
 * segment produces no row at all rather than a `skipped` row — see
 * `docs/specs/english-test.md` §5.1.
 */
export type EnglishOutcome = 'correct' | 'partial' | 'incorrect';

/** One step of the word-level alignment. */
export type EnglishDiffOpKind = 'match' | 'substitute' | 'delete' | 'insert';

/**
 * One operation of the reference-to-hypothesis alignment.
 *
 * `reference` is null on an `insert` (the learner said a word that is not in
 * the sentence); `hypothesis` is null on a `delete` (a sentence word they did
 * not say). Both are present on a `match` and a `substitute`.
 *
 * These are NORMALISED tokens, not the sentence's original spelling: the
 * scorer aligns `normalizeAnswer`'s output on both sides, so "first" arrives
 * here as `1` and "President of the United States" as the single token
 * `president`. A screen rendering them is showing what was actually compared.
 */
export interface EnglishDiffOp {
  kind: EnglishDiffOpKind;
  reference: string | null;
  hypothesis: string | null;
  /** Position in the normalised reference. Insertions repeat the position. */
  referenceIndex: number;
}

/** One sentence from the bank — `GET /api/english/next`. */
export interface EnglishSentence {
  id: string;
  kind: EnglishSegmentKind;
  /** Which vocabulary revision this bank is. */
  version: string;
  ordinal: number;
  /**
   * The sentence itself.
   *
   * Returned for BOTH segments, writing included, because dictation defaults to
   * the browser's own speech synthesis and that needs the string client-side.
   * The WRITING screen must never render it (`docs/specs/english-test.md` §4);
   * the READING screen must — reading is a test of reading it.
   */
  text: string;
  /** The USCIS vocabulary categories this sentence's own words resolve to. */
  vocabTags: string[];
  /** The SCORER's token count, not a naive space split. */
  wordCount: number;
}

/** `GET /api/english/next` — `sentence: null` means the bank is empty. */
export interface EnglishNextResponse {
  sentence: EnglishSentence | null;
}

/**
 * The whole body of `POST /api/english/attempts`.
 *
 * `asrConfidence` is READING-ONLY and **absent means unknown — never send 0**.
 * A `0` is a confident claim that the recogniser was certain it heard nothing,
 * which the server reads as a mishearing and stamps on a perfectly good answer.
 *
 * `replayCount` is WRITING-ONLY; a non-zero count on a reading attempt is a
 * 400, because a reading sentence is shown rather than dictated.
 */
export interface RecordEnglishAttemptInput {
  sentenceId: string;
  /** What is actually scored — for reading, the learner-CONFIRMED transcript. */
  responseText: string;
  asrConfidence?: number;
  replayCount?: number;
}

/** The scoring fields both arms of the attempt response carry. */
export interface EnglishScoreFields {
  sentenceId: string;
  kind: EnglishSegmentKind;
  /** The sentence as composed — on a writing attempt, this is the reveal. */
  text: string;
  responseText: string;
  wer: number;
  errors: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceTokenCount: number;
  diff: EnglishDiffOp[];
  normalizedReference: string;
  normalizedHypothesis: string;
}

/** A row WAS written. */
export interface EnglishAttemptScored extends EnglishScoreFields {
  status: 'scored';
  attemptId: string;
  outcome: EnglishOutcome;
  answeredAt: string;
  asrConfidence: number | null;
  replayCount: number;
}

/**
 * NOTHING was written.
 *
 * The recogniser reported confidence below the threshold on a reading attempt
 * that did not score `correct`. The diff still comes back — so the learner can
 * see what was heard — but no `english_attempts` row exists and no failure is
 * on their record. Offer a retry; never render this as a miss.
 */
export interface EnglishAttemptMisheard extends EnglishScoreFields {
  status: 'misheard';
  asrConfidence: number;
  confidenceThreshold: number;
}

export type EnglishAttemptResult = EnglishAttemptScored | EnglishAttemptMisheard;

/** One sentence's history — `GET /api/english/progress`. */
export interface EnglishSentenceProgress {
  sentenceId: string;
  kind: EnglishSegmentKind;
  text: string;
  ordinal: number;
  vocabTags: string[];
  attempts: number;
  bestOutcome: EnglishOutcome | null;
  lastOutcome: EnglishOutcome | null;
  lastWer: number | null;
  lastAnsweredAt: string | null;
}

/** The same evidence rolled up by USCIS vocabulary category. */
export interface EnglishVocabTagProgress {
  tag: string;
  sentencesTotal: number;
  sentencesAttempted: number;
  sentencesPassed: number;
  attempts: number;
}

/** Reading and writing totals, always both. */
export interface EnglishKindProgress {
  kind: EnglishSegmentKind;
  sentencesTotal: number;
  sentencesAttempted: number;
  sentencesPassed: number;
  attempts: number;
  /** `null` — never `0` — when there are no attempts. A mean of zero is a
   *  perfect record, the opposite of no record. */
  averageWer: number | null;
  version: string | null;
}

/** `GET /api/english/progress` — three grains of the same evidence. */
export interface EnglishProgress {
  sentences: EnglishSentenceProgress[];
  vocabTags: EnglishVocabTagProgress[];
  byKind: EnglishKindProgress[];
}
