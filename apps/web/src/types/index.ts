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
 * Which of the three E1 recommendations the server picked.
 *
 * A CLOSED UNION, mirroring `NEXT_ACTION_KINDS` on the server, and it exists
 * for presentation only — the title, reason and path all arrive already
 * written. A component branching on `kind` to choose COPY would be a second
 * declaration of what the recommender already decided, and the two would
 * disagree the first time the server's wording is edited.
 */
export type NextActionKind = 'orientation' | 'interview_countdown' | 'explore';

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
