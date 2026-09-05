import { z } from 'zod';
import { NOTIFICATION_CHANNELS } from '../../notifications/notification-events';
import type { NotificationPreferences } from '../../notifications/notification-preferences';

// =============================================================================
// User Settings Namespaces: `coach`, `dataTables`, `navigation`,
// `notifications`, `study`, `voice`
// =============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// The user-settings shape is currently hand-maintained in five separate zod
// declarations (common/schemas/settings.schema.ts x2,
// settings/dto/update-user-settings.dto.ts x2, and
// settings/dto/user-settings-response.dto.ts) plus one plain TS interface in
// common/types/settings.types.ts. Adding a namespace to only some of them means
// the payload is silently stripped by `userSettingsSchema.parse()` and never
// round-trips through a subsequent GET.
//
// These namespaces are therefore declared ONCE, here, and imported by every
// copy. Deduplicating the pre-existing `theme` / `profile` declarations is
// deliberately out of scope (no behaviour change in this pass), but any NEW
// namespace should be added here rather than copy-pasted five times.
//
// SECURITY: THE BOUNDS BELOW ARE A CONTROL, NOT ERGONOMICS
// --------------------------------------------------------
// `user_settings.value` is a JSONB blob that the user themselves writes via
// PUT/PATCH /api/user-settings. An unbounded user-controlled record is a
// storage-exhaustion vector: without a cap on the number of table entries, the
// number of column ids per entry, and the length of each id, an authenticated
// user can inflate a single row without limit. Every limit below exists to
// close that, and must not be relaxed for convenience.
//
// CRITICAL: NO `.default()` ANYWHERE IN THIS FILE
// ------------------------------------------------
// Absent MUST mean "use the application's built-in defaults", computed at read
// time by the consumer. This is load-bearing, not style.
//
// Concretely: if `visibleColumns` defaulted to `[]` (or to today's column list),
// then the first time a user merely opened a density menu — touching a totally
// unrelated preference — the persisted entry would materialise a frozen column
// set. Every column added to that table afterwards would be silently invisible
// to that user forever, with no error and no signal that anything was wrong,
// and the only remedy would be a manual settings reset. The same argument
// applies to `density`, `pageSize`, `sort`, and `railCollapsed`. Persist only
// what the user actually chose.
//
// =============================================================================

/**
 * Maximum number of per-table entries a single user may persist.
 *
 * NOTE: this cap CANNOT be expressed in `z.record()` — zod has no "max number
 * of keys" refinement that survives the record type. It is enforced in
 * UserSettingsService after the merge instead. See that service for why
 * enforcing it here would produce a 500 rather than a 400.
 */
export const DATA_TABLE_MAX_TABLES = 40;

/** Allowed shape of a table identifier (lowercase slug). */
export const DATA_TABLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Maximum length of a table identifier and of a column identifier. */
export const DATA_TABLE_MAX_ID_LENGTH = 64;

/** Maximum number of column ids that may be persisted for a single table. */
export const DATA_TABLE_MAX_VISIBLE_COLUMNS = 60;

/** Maximum persisted page size for a single table. */
export const DATA_TABLE_MAX_PAGE_SIZE = 500;

/** Row density options exposed by the data table component. */
export const dataTableDensitySchema = z.enum([
  'compact',
  'standard',
  'comfortable',
]);

/** Sort direction options. */
export const dataTableSortDirectionSchema = z.enum(['asc', 'desc']);

/** Persisted sort state for a single table. */
export const dataTableSortSchema = z
  .object({
    field: z.string().min(1).max(DATA_TABLE_MAX_ID_LENGTH),
    direction: dataTableSortDirectionSchema,
  })
  .strict();

/**
 * Persisted preferences for a single data table.
 *
 * Every key is optional and NONE has a `.default()` — see the file header.
 */
export const dataTableEntrySchema = z
  .object({
    visibleColumns: z
      .array(z.string().min(1).max(DATA_TABLE_MAX_ID_LENGTH))
      .max(DATA_TABLE_MAX_VISIBLE_COLUMNS)
      .optional(),
    density: dataTableDensitySchema.optional(),
    sort: dataTableSortSchema.optional(),
    pageSize: z.number().int().min(1).max(DATA_TABLE_MAX_PAGE_SIZE).optional(),
  })
  .strict();

/** Table identifier key schema, shared by the full and patch record schemas. */
export const dataTableIdSchema = z
  .string()
  .min(1)
  .max(DATA_TABLE_MAX_ID_LENGTH)
  .regex(DATA_TABLE_ID_PATTERN);

/**
 * Full `dataTables` namespace: a map of table id -> preferences.
 *
 * zod v4 requires BOTH a key and a value schema for `z.record`.
 */
export const dataTablesSchema = z.record(
  dataTableIdSchema,
  dataTableEntrySchema,
);

/**
 * PATCH form of the `dataTables` namespace.
 *
 * The value is nullable because JSON Merge Patch uses `null` to mean "delete":
 * `{ dataTables: { jobs: null } }` removes the `jobs` entry. A non-null entry
 * REPLACES the stored entry for that table wholesale (it is not deep-merged) —
 * see UserSettingsService.mergeDataTables.
 */
export const dataTablesPatchSchema = z.record(
  dataTableIdSchema,
  dataTableEntrySchema.nullable(),
);

/**
 * Full `navigation` namespace.
 *
 * `railCollapsed` absent means "use the built-in default" — deliberately NOT
 * `.default(false)`, so that a future change to the default rail state reaches
 * users who never expressed a preference.
 */
export const navigationSchema = z
  .object({
    railCollapsed: z.boolean().optional(),
  })
  .strict();

/**
 * PATCH form of the `navigation` namespace: each field may additionally be
 * `null`, meaning "delete this field and fall back to the built-in default".
 */
export const navigationPatchSchema = z
  .object({
    railCollapsed: z.boolean().nullable().optional(),
  })
  .strict();

// =============================================================================
// User Settings Namespace: `study` (epic #56 / E7 "Habit")
// =============================================================================
//
// `docs/specs/habit-streaks.md` §7. Two fields, both about ONE question: when
// — and whether — the hourly `PracticeReminderTask` should check in on this
// learner's study habit.
//
// THE BUILT-IN DEFAULTS ARE CONSTANTS BELOW, NOT `.default()` CALLS, and this
// namespace is where that rule earns its keep most visibly. A `.default(9)`
// would materialise `reminderHour: 9` into storage the first time a learner
// touched any unrelated preference — a density menu, a rail toggle — freezing
// them at today's default hour even after a future change decided the default
// should move. That is the identical "frozen column set" failure this file's
// own header spends a paragraph on for `dataTables.visibleColumns`; here it
// would show up as a learner being reminded at 9am forever because they once
// collapsed the navigation rail.
//
// TWO SEPARATE CONTROLS, NOT ONE (§7.1). `reminderEnabled` governs whether the
// cron considers this learner AT ALL, for any of the three reminder events —
// "stop checking in on my study habit". Muting `practice.daily_reminder` in the
// `notifications` namespace above is narrower: the cron may still select that
// event for this learner, but it is not delivered, while the other two stay
// live. A settings page presenting either as the other is a bug in the copy,
// not a detail: the two answer different questions and a learner who turns off
// the wrong one keeps receiving exactly what they asked to stop.
// =============================================================================

/**
 * The hour a reminder is sent when the learner has expressed no preference.
 *
 * READ AT REMINDER TIME BY `PracticeReminderTask`, never written into a
 * `user_settings` row. That is what "absent means the built-in default" is:
 * changing this constant moves the reminder for every learner who never chose
 * an hour, which is the whole point of not persisting it.
 *
 * 9 (local, in `learner_profiles.timezone`) — morning, before a working day,
 * and late enough that it is not the middle of anybody's night in their own
 * zone. The learner picks a different one if it does not suit them.
 */
export const DEFAULT_STUDY_REMINDER_HOUR = 9;

/**
 * Whether the hourly task considers a learner who has expressed no preference.
 *
 * `true`, and each of the three reminder events then applies its OWN
 * `defaultEnabled` on top — which is how `streak.at_risk` (`defaultEnabled:
 * false`) stays opt-in even for a learner who never touched this namespace.
 * Two gates, deliberately: this one is "may we check in at all", the registry's
 * is "may we send you THIS".
 */
export const DEFAULT_STUDY_REMINDER_ENABLED = true;

/**
 * Full `study` namespace.
 *
 * Both fields optional, NEITHER with a `.default()` — see the block above.
 * `reminderHour` is bounded to a real hour of a real day: 24 is not "midnight
 * tomorrow", it is a value no learner's local clock ever reads, and accepting
 * it would store a preference that silently never fires.
 */
export const studySchema = z
  .object({
    reminderHour: z.number().int().min(0).max(23).optional(),
    reminderEnabled: z.boolean().optional(),
  })
  .strict();

/**
 * PATCH form of the `study` namespace: each field may additionally be `null`,
 * meaning "delete this field and fall back to the built-in default".
 *
 * The delete is the operation that RESTORES the default rather than pinning
 * one — a learner returning their reminder to 9am sends `reminderHour: null`,
 * not `reminderHour: 9`, and keeps moving with the default if it ever changes.
 * Same shape, same reason, as `navigationPatchSchema` above.
 */
export const studyPatchSchema = z
  .object({
    reminderHour: z.number().int().min(0).max(23).nullable().optional(),
    reminderEnabled: z.boolean().nullable().optional(),
  })
  .strict();

// =============================================================================
// Inferred types — derived from the schemas above so they can never drift.
// =============================================================================

export type DataTableDensity = z.infer<typeof dataTableDensitySchema>;
export type DataTableSort = z.infer<typeof dataTableSortSchema>;
export type DataTableEntry = z.infer<typeof dataTableEntrySchema>;
export type DataTablesValue = z.infer<typeof dataTablesSchema>;
export type DataTablesPatchValue = z.infer<typeof dataTablesPatchSchema>;
export type NavigationValue = z.infer<typeof navigationSchema>;
export type NavigationPatchValue = z.infer<typeof navigationPatchSchema>;
export type StudyValue = z.infer<typeof studySchema>;
export type StudyPatchValue = z.infer<typeof studyPatchSchema>;

// =============================================================================
// User Settings Namespace: `voice` (issue #282, epic #280 "Spoken Civics Audio")
// =============================================================================
//
// Six independent scalar preferences, all about how a learner experiences
// SPOKEN questions and answers — whether a spoken answer grades itself the
// instant they release the mic, whether they hear the premium synthesized
// voice or the browser's own free one, which provider voice they hear if the
// premium path is available, how fast it speaks, and whether either side of
// a civics card plays itself automatically. None of the six governs whether
// audio is CACHED (`speech_audio_assets`, issue #282's other half) — this
// namespace is entirely about local playback behaviour a learner controls
// for themselves.
//
// SAME SHAPE AS `study`, SAME MERGE STRATEGY. Six independently-optional
// scalar fields with no nested map to deep-merge — `mergeNavigation` and
// `mergeStudy` already establish the field-wise pattern this namespace
// reuses (see `user-settings.service.ts`), never `mergeDataTables`'
// replace-wholesale.
//
// THE BUILT-IN DEFAULTS ARE CONSTANTS BELOW, NOT `.default()` CALLS — the
// identical rule this file's header states for every namespace above.
// Materialising `autoSubmitSpoken: true` (say) into storage the first time a
// learner touched an unrelated preference would freeze them at today's
// default even after a future change decided the default should move; see
// the header's `dataTables.visibleColumns` paragraph for the failure mode in
// full, and `study`'s own block for the same argument made once already.
// =============================================================================

/**
 * Whether a spoken answer grades itself the instant the learner releases the
 * microphone, with no separate confirm step.
 *
 * `true`. A confirm-before-grade step is the SAFER, more deliberate flow (and
 * still exists — this preference is what makes it recoverable, not what
 * removes it): a learner who wants to review their own transcript before it
 * is scored can turn this off. Defaulting to the faster flow matches the
 * product's general bias toward low-friction practice reps.
 */
export const DEFAULT_VOICE_AUTO_SUBMIT_SPOKEN = true;

/**
 * Whether the premium, synthesized voice is preferred over the browser's own
 * free `speechSynthesis`, when a premium voice is actually available.
 *
 * `true`. This preference does not ITSELF make premium audio available —
 * `speak` (the AI model role) may simply be unbound, in which case playback
 * falls back to the browser voice regardless of this setting, exactly as
 * `docs/specs/voice.md` §1's degradation rule already states for every
 * voice-adjacent feature: an unbound optional role never blocks the
 * underlying capability, it only removes the upgrade.
 */
export const DEFAULT_VOICE_PREFER_PREMIUM = true;

/**
 * How fast synthesized speech plays, as a multiplier of the provider's normal
 * rate.
 *
 * `0.95` — matches the rate already hard-coded at
 * `apps/web/src/components/voice/QuestionAudio.tsx:256`. That value exists
 * because a civics question read at conversational speed is hard to follow
 * for a learner studying in a second language; making it a namespace default
 * (rather than leaving it hard-coded) is what lets a learner who wants it
 * slower or faster say so, without changing what everyone else hears by
 * default.
 */
export const DEFAULT_VOICE_SPEECH_RATE = 0.95;

/** Minimum accepted `speechRate` — half normal speed. */
export const VOICE_SPEECH_RATE_MIN = 0.5;

/** Maximum accepted `speechRate` — double normal speed. */
export const VOICE_SPEECH_RATE_MAX = 2.0;

/**
 * Whether a civics question is read aloud automatically when it renders.
 *
 * `false`. Auto-play is opt-in: a learner who has not asked for audio should
 * not have it start speaking at them the moment a card appears.
 */
export const DEFAULT_VOICE_READ_QUESTIONS_ALOUD = false;

/**
 * Whether a civics answer is read aloud automatically when it renders.
 *
 * `false`, for the identical reason `readQuestionsAloud` is — see above.
 */
export const DEFAULT_VOICE_READ_ANSWERS_ALOUD = false;

/**
 * Shape bound for a provider voice id, e.g. `alloy`.
 *
 * SHAPE VALIDATED, MEMBERSHIP NOT — the same rule
 * `apps/api/src/ai/dto/ai-speech.dto.ts` (~line 209) already states for this
 * exact value on the synthesis request itself: the accepted set of voice ids
 * belongs to the provider, so hard-coding OpenAI's current list here would be
 * a second place that list lives — wrong on the day a second provider ships,
 * stale on the day OpenAI adds a voice. An identifier-shaped string is the
 * part this layer can genuinely own; anything else is a client bug.
 */
export const VOICE_PREFERRED_VOICE_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Full `voice` namespace.
 *
 * Every field optional, NONE with a `.default()` — see the block above.
 * `preferredVoice` UNSET (never an empty string) lets the provider choose;
 * `speechRate` is bounded to a range a learner could plausibly want to
 * listen at, not the provider's own theoretical bounds.
 */
export const voiceSchema = z
  .object({
    autoSubmitSpoken: z.boolean().optional(),
    preferPremiumVoice: z.boolean().optional(),
    preferredVoice: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(VOICE_PREFERRED_VOICE_PATTERN)
      .optional(),
    speechRate: z
      .number()
      .min(VOICE_SPEECH_RATE_MIN)
      .max(VOICE_SPEECH_RATE_MAX)
      .optional(),
    readQuestionsAloud: z.boolean().optional(),
    readAnswersAloud: z.boolean().optional(),
  })
  .strict();

/**
 * PATCH form of the `voice` namespace: each field may additionally be `null`,
 * meaning "delete this field and fall back to the built-in default" — the
 * same restore-the-default semantics `studyPatchSchema` and
 * `navigationPatchSchema` already give their own fields.
 */
export const voicePatchSchema = z
  .object({
    autoSubmitSpoken: z.boolean().nullable().optional(),
    preferPremiumVoice: z.boolean().nullable().optional(),
    preferredVoice: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(VOICE_PREFERRED_VOICE_PATTERN)
      .nullable()
      .optional(),
    speechRate: z
      .number()
      .min(VOICE_SPEECH_RATE_MIN)
      .max(VOICE_SPEECH_RATE_MAX)
      .nullable()
      .optional(),
    readQuestionsAloud: z.boolean().nullable().optional(),
    readAnswersAloud: z.boolean().nullable().optional(),
  })
  .strict();

export type VoiceValue = z.infer<typeof voiceSchema>;
export type VoicePatchValue = z.infer<typeof voicePatchSchema>;

// =============================================================================
// User Settings Namespace: `coach` (issue #317, epic #305 "The Coach's personality")
// =============================================================================
//
// Two fields, both about ONE question: what the coach sounds like when it
// speaks to this learner, and whether it speaks at all beyond the verdict.
//
// -----------------------------------------------------------------------------
// WHY THIS IS ITS OWN NAMESPACE AND NOT A FIELD ON `voice`
// -----------------------------------------------------------------------------
//
// `voice` above is about AUDIO: whether a spoken answer auto-submits, which
// synthesized voice reads a question, how fast it speaks. Every one of its six
// fields is inert for a learner who never presses play. The coach is not:
// `persona` governs WRITTEN feedback exactly as much as spoken feedback — the
// grader's `feedback` sentence on a practice attempt, the tutor's civics
// explanation stream, the on-screen reaction line after an answer — and a
// learner who has never used voice at all still has a coach, still reads its
// sentences, and still has an opinion about their tone.
//
// Folding `persona` into `voice` would therefore put a preference that applies
// to every learner behind a namespace named for a feature many of them never
// touch. Two concrete consequences, neither cosmetic: `/settings/voice` would
// own a control that has nothing to do with audio, and a deployment with no
// `speak` binding at all — which `docs/specs/voice.md` §1 is explicit is an
// ordinary, fully-working install and not a degraded one — would present its
// entire coach configuration on a page whose other controls do nothing. The
// grouping a settings page reaches for is the grouping a learner reasons in,
// and "how does this thing talk to me" is not "how does this thing sound".
//
// `docs/specs/coach-personality.md` §8 is the design record for that split.
//
// SAME SHAPE, SAME MERGE STRATEGY AS `voice` AND `study`. Two independently
// optional scalar fields with no nested map to deep-merge, so `mergeCoach`
// (`user-settings.service.ts`) is field-wise like `mergeVoice` and
// `mergeStudy`, never `mergeDataTables`' replace-wholesale.
//
// THE BUILT-IN DEFAULTS ARE CONSTANTS BELOW, NOT `.default()` CALLS — the
// identical rule this file's header states for every namespace above, and it
// matters here for a reason specific to this namespace: `persona` is the one
// field in the file whose default is a deliberate statement that NOTHING
// CHANGES for an existing learner (see `DEFAULT_COACH_PERSONA`). A
// `.default('supportive')` would materialise that statement into storage the
// first time a learner touched an unrelated preference, pinning them to it
// even after a later release moved the default — turning "nothing changes yet"
// into "nothing ever changes", silently, for exactly the accounts that never
// asked for either.
// =============================================================================

/**
 * The four personas the coach can speak in.
 *
 * -----------------------------------------------------------------------------
 * DECLARED HERE TODAY; ISSUE #318 WILL INVERT THIS
 * -----------------------------------------------------------------------------
 *
 * Epic #305 puts the persona REGISTRY — label, description, `promptFragment`,
 * `sampleLine` — in `apps/api/src/ai/coach/personas.ts`, which #318 ships and
 * which does not exist yet. When it lands, this list stops being a literal and
 * becomes `AI_COACH_PERSONAS`' own keys, exactly as `aiSettingsSchema`'s
 * `models` map is derived from `AI_MODEL_ROLES` rather than restating it.
 *
 * The reason to invert it rather than leave two lists agreeing by inspection is
 * the one `ai-model-roles.ts` already argues at length for role keys, and it
 * applies verbatim: a persona `key` is PERSISTED — it is a property value in a
 * `user_settings` row — so the two lists disagreeing is not a compile error but
 * a learner whose stored persona silently stops resolving. A duplicate plus a
 * test asserting the two match is *detection*, not prevention: the copies can
 * still disagree in a working tree, in a branch, and in any build where that
 * test is not run.
 *
 * Declaring the values here first is deliberate sequencing, not a shortcut —
 * this issue ships the settings plumbing with no AI module dependency at all,
 * and #318 replaces four string literals with one import in a single edit.
 */
export const COACH_PERSONAS = [
  'supportive',
  'academic',
  'playful',
  'unfiltered',
] as const;

/** The persona enum. Closed: an unknown persona is a 400, never a stored value. */
export const coachPersonaSchema = z.enum(COACH_PERSONAS);

export type CoachPersona = z.infer<typeof coachPersonaSchema>;

/**
 * The persona a learner who has expressed no preference hears.
 *
 * READ AT GENERATION TIME by whatever is composing the coach's words, never
 * written into a `user_settings` row — the same contract every constant above
 * carries, and see this namespace's block for why materialising it would be
 * worse here than elsewhere.
 *
 * `'supportive'` because it is EXACTLY TODAY'S VOICE. The grader's feedback
 * sentence and the tutor's explanation already read as an encouraging,
 * plain-spoken helper; naming that tone and making it the default means a
 * learner who never opens the setting — which is every existing account, since
 * the namespace is absent for all of them — experiences precisely zero change
 * when E14 ships. A persona epic whose default alters how the app talks to
 * people who did not ask for it would be shipping a rewrite of every existing
 * learner's experience under the heading of a preference.
 */
export const DEFAULT_COACH_PERSONA: CoachPersona = 'supportive';

/**
 * Whether the coach adds a short reaction line to an answer, beyond the verdict.
 *
 * `true`, and this is the one default in the file that is deliberately NOT the
 * conservative choice. The coverage gap epic #305 exists to close is that most
 * attempts today say nothing at all beyond correct/incorrect: a learner grinds
 * through a session and the app never once responds to them as a person.
 * Defaulting reactions OFF would ship the entire epic dark, reachable only by
 * learners who went looking for a setting whose value they cannot see until
 * they turn it on.
 *
 * It is a SEPARATE field from `persona` rather than a fifth persona value
 * (`'none'`) because the two answer different questions: `persona` is *how* the
 * coach speaks and applies to the grader's feedback and the tutor's
 * explanations regardless of this flag, while `reactions` is only about the
 * per-answer chatter. A learner who wants the playful coach's explanations
 * without a quip after every single answer must be able to say so, and a
 * `'none'` persona would silence the explanations too.
 */
export const DEFAULT_COACH_REACTIONS = true;

/**
 * Full `coach` namespace.
 *
 * Both fields optional, NEITHER with a `.default()` — see the block above.
 */
export const coachSchema = z
  .object({
    persona: coachPersonaSchema.optional(),
    reactions: z.boolean().optional(),
  })
  .strict();

/**
 * PATCH form of the `coach` namespace: each field may additionally be `null`,
 * meaning "delete this field and fall back to the built-in default" — the same
 * restore-the-default semantics `voicePatchSchema`, `studyPatchSchema` and
 * `navigationPatchSchema` already give their own fields.
 *
 * The delete is the operation that RESTORES the default rather than pinning
 * one: a learner returning to the supportive coach sends `persona: null`, not
 * `persona: 'supportive'`, and keeps moving with the default if it ever
 * changes.
 */
export const coachPatchSchema = z
  .object({
    persona: coachPersonaSchema.nullable().optional(),
    reactions: z.boolean().nullable().optional(),
  })
  .strict();

export type CoachValue = z.infer<typeof coachSchema>;
export type CoachPatchValue = z.infer<typeof coachPatchSchema>;

// =============================================================================
// User Settings Namespace: `notifications` (issue #126, epic #109)
// =============================================================================
//
// The WRITE side of the preference contract whose READ side is
// notifications/notification-preferences.ts (#125). That file is the
// authority on the stored shape; everything here exists to make sure nothing
// can be written that it would not read back the same way.
//
//     user_settings.value.notifications = {
//       email:   { 'user.welcome': false },
//       browser: { 'security.role_changed': true },
//     }
//
// CHANNEL-OUTER, EVENT-INNER — not a choice made here. It is the shape
// `readNotificationPreferences` already parses and `isChannelEnabled` already
// resolves; a write schema that accepted event-outer would produce rows the
// dispatcher silently ignores, i.e. mutes that never take effect.
//
// SPARSE, LIKE ITS NEIGHBOURS ABOVE. No `.default()`, no materialised blob.
// Absent at any of the three levels (namespace / channel / event) means "use
// the registry's `defaultEnabled`", resolved at read time. This is why
// `mergeNotifications` collapses an emptied channel, and an emptied namespace,
// back to ABSENT rather than storing `{}` — see that method. Storing `{}`
// would be a second representation of "no opinion" for the read path and the
// UI to disagree about, and `readNotificationPreferences` deliberately drops
// empty maps for exactly the same reason.
//
// -----------------------------------------------------------------------------
// WHY CHANNEL KEYS ARE CLOSED AND EVENT KEYS ARE NOT
// -----------------------------------------------------------------------------
//
// The outer level is validated against `NOTIFICATION_CHANNELS`: an unknown
// channel is a 400. The inner level accepts ANY syntactically valid event key,
// and is deliberately NOT checked against `NOTIFICATION_EVENTS`. That
// asymmetry is not an oversight — it mirrors what the read path does with each
// level, and the rule is: THE WRITE PATH MUST ACCEPT EVERYTHING THE READ PATH
// CAN EMIT.
//
//   * `readNotificationPreferences` DROPS unknown channels. A channel the
//     registry does not declare can never be delivered, so nothing is lost by
//     refusing it on write either, and a GET can never hand a client a channel
//     that a subsequent PUT would then reject.
//
//   * `readNotificationPreferences` KEEPS unknown event keys, and says why:
//     during a rolling deploy an older pod legitimately reads a preference for
//     an event only the newer build declares. Rejecting unknown event keys on
//     write would break that in three concrete ways:
//
//       1. ROLLING DEPLOY. The preferences page renders from
//          `GET /api/notifications/events` (#124). Behind a load balancer that
//          list can come from a new pod while the resulting PATCH lands on an
//          old one, so the user's toggle 400s on a key that is perfectly real.
//
//       2. READ-MODIFY-WRITE. `PUT /api/user-settings` states the settings in
//          full, so a client GETs and PUTs back keys the server just served
//          it. Once an event is retired from the registry, that round trip
//          starts failing on the server's own data.
//
//       3. THE CLEANUP PATH WOULD BE UNREACHABLE. Deleting a stale preference
//          is `{ notifications: { email: { 'old.event': null } } }` — a
//          request that NAMES the unknown key. Validating keys against the
//          registry rejects the very request that would remove them, so a
//          retired event's preference could never be cleaned up at all.
//
// The cost of accepting them is that a typo'd key from a hand-written PATCH is
// stored and quietly does nothing. That is tolerable because it is inert:
// `isChannelEnabled` is only ever asked about REGISTERED events, so a
// preference for a key no event has cannot affect a delivery decision. The
// real risk of an open map is unbounded growth, and that is closed below by
// key format, key length, and a per-channel entry cap — the same
// storage-exhaustion control the header of this file describes for
// `dataTables`, and for the same reason: this blob is user-written.
//
// -----------------------------------------------------------------------------
// `mandatory` IS NOT ENFORCED HERE, DELIBERATELY
// -----------------------------------------------------------------------------
//
// A stored `{ 'security.role_changed': false }` is accepted by this schema and
// is harmless: `isChannelEnabled` tests `event.mandatory` BEFORE it looks at
// stored preferences, so the value is never consulted. That single gate, in
// the resolver, is the security boundary (#125) precisely because it catches
// every path — including rows written before an event became mandatory, and
// crafted requests that never went near the UI. Adding a second gate here
// would not make the system safer; it would create two enforcement points that
// can disagree, and the one that matters is the one the dispatcher reads.
// =============================================================================

/**
 * Maximum number of event preferences a single user may persist PER CHANNEL.
 *
 * As with DATA_TABLE_MAX_TABLES this cannot be expressed in `z.record()` and
 * must be checked against the MERGED result, so it is enforced in
 * UserSettingsService. See `assertNotificationLimit` there.
 *
 * Generous against a registry of a handful of events — this is a bound on
 * abuse, not a product limit — but finite, because the event level is an open
 * map that the user writes.
 */
export const NOTIFICATION_MAX_EVENTS_PER_CHANNEL = 100;

/** Maximum length of a persisted event key. */
export const NOTIFICATION_MAX_EVENT_KEY_LENGTH = 64;

/**
 * Allowed shape of an event key: the `<area>.<event>` convention
 * `NOTIFICATION_EVENTS` documents, as a syntactic bound.
 *
 * THIS IS A BOUND, NOT A REGISTRY CHECK (see the header). It must therefore
 * stay at least as permissive as the registry's own key convention: if a
 * future event key adopts a character this pattern rejects, preferences for
 * that event become unwritable — a toggle that 400s with no registry change in
 * sight. Widen this deliberately if that convention ever changes.
 */
export const NOTIFICATION_EVENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

/** Event key schema, shared by the full and patch record schemas. */
export const notificationEventKeySchema = z
  .string()
  .min(1)
  .max(NOTIFICATION_MAX_EVENT_KEY_LENGTH)
  .regex(NOTIFICATION_EVENT_KEY_PATTERN);

/**
 * One channel's preferences: event key -> the user's explicit choice.
 *
 * `boolean` only. `readNotificationPreferences` discards any other value, so
 * accepting one here would persist a preference that can never take effect.
 */
export const notificationChannelPreferencesSchema = z.record(
  notificationEventKeySchema,
  z.boolean(),
);

/**
 * Full `notifications` namespace: channel -> that channel's preferences.
 *
 * `partialRecord` (not `record`) over the channel enum: every channel is
 * OPTIONAL. A plain `z.record` with an enum key requires the full key set,
 * which would force a client that only ever touched email to also state a
 * `browser` object — the materialised blob this whole namespace avoids.
 *
 * The key set is derived from `NOTIFICATION_CHANNELS`, so adding `'push'`
 * there widens this schema in the same edit and there is no second list to
 * forget.
 */
export const notificationsSchema = z.partialRecord(
  z.enum(NOTIFICATION_CHANNELS),
  notificationChannelPreferencesSchema,
);

/**
 * PATCH form of one channel's preferences.
 *
 * The value is nullable because JSON Merge Patch uses `null` to mean "delete":
 * `{ email: { 'user.welcome': null } }` removes that one event key, restoring
 * the ABSENT (= registry default) state. That is the operation #126 sends when
 * a control returns to its default — writing the default value explicitly
 * would pin the user to today's default forever, which is the staleness the
 * sparse contract exists to prevent.
 */
export const notificationChannelPreferencesPatchSchema = z.record(
  notificationEventKeySchema,
  z.boolean().nullable(),
);

/**
 * PATCH form of the `notifications` namespace.
 *
 * Three levels of delete, each meaning something different:
 *   `{ notifications: null }`                       -> clear the namespace
 *   `{ notifications: { email: null } }`            -> clear the email channel
 *   `{ notifications: { email: { 'k': null } } }`   -> delete one event key
 *
 * Unlike `dataTablesPatchSchema`, a non-null channel object is DEEP-merged
 * per event rather than replacing the channel wholesale — see
 * UserSettingsService.mergeNotifications for why.
 */
export const notificationsPatchSchema = z.partialRecord(
  z.enum(NOTIFICATION_CHANNELS),
  notificationChannelPreferencesPatchSchema.nullable(),
);

export type NotificationChannelPreferencesValue = z.infer<
  typeof notificationChannelPreferencesSchema
>;
export type NotificationsValue = z.infer<typeof notificationsSchema>;
export type NotificationsPatchValue = z.infer<typeof notificationsPatchSchema>;

/**
 * Compile-time guard: what this schema accepts must remain assignable to the
 * shape the dispatcher reads (`NotificationPreferences`, #125).
 *
 * Exported only so it is not an unused local — nothing should reference it.
 * If it ever resolves to `false`, the write path and the read path have drifted
 * apart and stored preferences would stop resolving; fix the schema rather than
 * this alias.
 */
export type NotificationsValueMatchesDispatcherShape = [
  NotificationsValue,
] extends [NotificationPreferences]
  ? true
  : false;
