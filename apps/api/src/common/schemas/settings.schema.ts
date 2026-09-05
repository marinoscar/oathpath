import { z } from 'zod';
import {
  dataTablesSchema,
  dataTablesPatchSchema,
  navigationSchema,
  navigationPatchSchema,
  notificationsSchema,
  notificationsPatchSchema,
  studySchema,
  studyPatchSchema,
  voiceSchema,
  voicePatchSchema,
} from './user-settings-namespaces.schema';

// =============================================================================
// User Settings Schema
// =============================================================================

export const userSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().max(100).optional(),
    useProviderImage: z.boolean(),
    customImageUrl: z.string().url().nullable().optional(),
  }),
  // Optional namespaces. Absent means "use built-in defaults" — see
  // user-settings-namespaces.schema.ts for why these must never get `.default()`.
  dataTables: dataTablesSchema.optional(),
  navigation: navigationSchema.optional(),
  // `notifications` (#126) is optional for the reason the other two are, only
  // more so: absent means "use each event's registry default", and every
  // existing account is absent. Making it required — or defaulting it — would
  // materialise a preference blob for the whole user base at the first PUT
  // and freeze them at today's defaults. See notification-preferences.ts.
  notifications: notificationsSchema.optional(),
  // `study` (epic #56 / E7) is optional for the same reason: absent means the
  // built-in defaults (`DEFAULT_STUDY_REMINDER_HOUR` / `_ENABLED`) resolved at
  // reminder time, and every existing account is absent.
  study: studySchema.optional(),
  // `voice` (issue #282, epic #280) is optional for the same reason: absent
  // means the built-in defaults (`DEFAULT_VOICE_*`) resolved at read time,
  // and every existing account is absent.
  voice: voiceSchema.optional(),
});

export type UserSettingsDto = z.infer<typeof userSettingsSchema>;

// Partial schema for PATCH operations (zod v4: deepPartial removed, use manual deep partial)
export const userSettingsPatchSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  profile: z.object({
    displayName: z.string().max(100).optional(),
    useProviderImage: z.boolean().optional(),
    customImageUrl: z.string().url().nullable().optional(),
  }).optional(),
  // The outer `.nullable()` is what lets `{ "dataTables": null }` clear the
  // whole namespace; the inner nullability (in dataTablesPatchSchema) is what
  // lets `{ "dataTables": { "jobs": null } }` delete a single entry.
  dataTables: dataTablesPatchSchema.nullable().optional(),
  navigation: navigationPatchSchema.nullable().optional(),
  // Three nullable levels, three different deletes: the namespace, one
  // channel, one event key. See notificationsPatchSchema.
  notifications: notificationsPatchSchema.nullable().optional(),
  // `study: null` clears the namespace; `study: { reminderHour: null }`
  // deletes one field and restores its built-in default.
  study: studyPatchSchema.nullable().optional(),
  // `voice: null` clears the namespace; `voice: { speechRate: null }` deletes
  // one field and restores its built-in default.
  voice: voicePatchSchema.nullable().optional(),
});

// =============================================================================
// System Settings Schema
// =============================================================================

export const systemSettingsSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean(),
  }),
  features: z.record(z.string(), z.boolean()),
});

export type SystemSettingsDto = z.infer<typeof systemSettingsSchema>;

// Partial schema for PATCH operations (zod v4: deepPartial removed, use manual deep partial)
export const systemSettingsPatchSchema = z.object({
  ui: z.object({
    allowUserThemeOverride: z.boolean().optional(),
  }).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});
