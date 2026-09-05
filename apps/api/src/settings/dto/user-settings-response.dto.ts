import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  coachSchema,
  dataTablesSchema,
  navigationSchema,
  notificationsSchema,
  studySchema,
  voiceSchema,
} from '../../common/schemas/user-settings-namespaces.schema';

export const userSettingsResponseSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  profile: z.object({
    displayName: z.string().nullable().optional(),
    useProviderImage: z.boolean(),
    customImageUrl: z.string().url().nullable().optional(),
  }),
  // Emitted only when the user has stored something for the namespace; an
  // absent namespace means "client should apply its built-in defaults".
  dataTables: dataTablesSchema.optional(),
  navigation: navigationSchema.optional(),
  // Absent here is INFORMATION, not an omission: it tells the preferences page
  // the user has expressed no opinion, so every control derives its state from
  // the registry default rather than from a defaulted local object (#126).
  notifications: notificationsSchema.optional(),
  // Absent here is INFORMATION too: it tells a study-settings page that this
  // learner has chosen neither an hour nor an on/off state, so both controls
  // render the built-in default rather than a stored value.
  study: studySchema.optional(),
  // Absent here is INFORMATION too: it tells a voice-settings page that this
  // learner has expressed no spoken-audio preference, so every control
  // renders its built-in default rather than a stored value.
  voice: voiceSchema.optional(),
  // Absent here is INFORMATION too: it tells a coach-settings page that this
  // learner has chosen neither a persona nor a reactions state, so both
  // controls render the built-in default rather than a stored value — and, as
  // above, a control that saved the rendered default would pin them to it.
  coach: coachSchema.optional(),
  updatedAt: z.iso.datetime(),
  version: z.number(),
});

export class UserSettingsResponseDto extends createZodDto(
  userSettingsResponseSchema,
) {}
