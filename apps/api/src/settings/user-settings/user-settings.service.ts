import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserSettingsDto } from '../dto/update-user-settings.dto';
import { PatchUserSettingsDto } from '../dto/update-user-settings.dto';
import {
  DEFAULT_USER_SETTINGS,
  UserSettingsValue,
} from '../../common/types/settings.types';
import { userSettingsSchema } from '../../common/schemas/settings.schema';
import {
  CoachPatchValue,
  CoachValue,
  DATA_TABLE_MAX_TABLES,
  DataTablesPatchValue,
  DataTablesValue,
  NavigationPatchValue,
  NavigationValue,
  NOTIFICATION_MAX_EVENTS_PER_CHANNEL,
  NotificationChannelPreferencesValue,
  NotificationsPatchValue,
  NotificationsValue,
  StudyPatchValue,
  StudyValue,
  VoicePatchValue,
  VoiceValue,
} from '../../common/schemas/user-settings-namespaces.schema';
import type { NotificationChannel } from '../../notifications/notification-events';

@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the API response projection for a stored settings value.
   *
   * Optional namespaces are emitted ONLY when present — we never put
   * `dataTables: undefined` in the body, because an absent namespace is the
   * signal to the client that it should apply its own built-in defaults.
   */
  private toResponse(
    value: UserSettingsValue,
    updatedAt: Date,
    version: number,
  ) {
    return {
      theme: value.theme,
      profile: value.profile,
      ...(value.dataTables !== undefined
        ? { dataTables: value.dataTables }
        : {}),
      ...(value.navigation !== undefined
        ? { navigation: value.navigation }
        : {}),
      ...(value.notifications !== undefined
        ? { notifications: value.notifications }
        : {}),
      ...(value.study !== undefined ? { study: value.study } : {}),
      ...(value.voice !== undefined ? { voice: value.voice } : {}),
      ...(value.coach !== undefined ? { coach: value.coach } : {}),
      updatedAt,
      version,
    };
  }

  /**
   * Get user settings for current user
   * Creates default settings if none exist
   */
  async getSettings(userId: string) {
    let settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    // Create default settings if not found
    if (!settings) {
      settings = await this.prisma.userSettings.create({
        data: {
          userId,
          value: DEFAULT_USER_SETTINGS as any,
        },
      });
      this.logger.log(`Created default settings for user: ${userId}`);
    }

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * The caller's own `voice` namespace, or `undefined` if they have never set
   * one (issue #284, epic #280).
   *
   * ---------------------------------------------------------------------------
   * A PURE READ, DELIBERATELY NOT `getSettings`
   * ---------------------------------------------------------------------------
   *
   * `getSettings` CREATES a `user_settings` row on a miss, which is right for
   * the settings screen (a learner who opened it is about to save something)
   * and wrong for every other reader: `GET /api/ai/speech/audio` asks this
   * question on a playback path, and a route that writes a row because somebody
   * pressed play is a write nobody asked for on a request that should be able
   * to serve entirely from cache. `NotificationsService` avoids `getSettings`
   * for the same reason and reads the column itself.
   *
   * ---------------------------------------------------------------------------
   * BUT IT LIVES HERE, RATHER THAN THE COLUMN BEING READ AT THE CALL SITE
   * ---------------------------------------------------------------------------
   *
   * The shape of `user_settings.value` — a JSONB blob whose namespaces are
   * SPARSE, where absent means "use the built-in default" and never "off" — is
   * this service's own contract (see
   * `common/schemas/user-settings-namespaces.schema.ts`'s header on why no
   * namespace carries a `.default()`). A consumer casting the column and
   * reaching for `.voice` would be a second place that contract is
   * interpreted, and the first to get it wrong the day the shape moves.
   *
   * Returns `undefined` — never a materialised object of defaults — so the
   * caller keeps the three-way distinction the namespace is built on: set,
   * unset, and unset-because-there-is-no-row.
   */
  async readVoicePreferences(userId: string): Promise<VoiceValue | undefined> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { value: true },
    });

    if (!row) return undefined;

    const value = row.value as unknown as UserSettingsValue | null;
    const voice = value?.voice;

    // A SHAPE CHECK, NOT A PARSE. The stored blob was validated on the way in;
    // this guards against a hand-edited or older row making a caller read a
    // property off a string. An unreadable namespace is `undefined`, which the
    // caller already handles as "the learner has expressed no preference".
    return voice && typeof voice === 'object' ? voice : undefined;
  }

  /**
   * The caller's own `coach` namespace, or `undefined` if they have never set
   * one (issue #317, epic #305).
   *
   * ---------------------------------------------------------------------------
   * A PURE READ, DELIBERATELY NOT `getSettings` — AND HERE IT MATTERS MOST
   * ---------------------------------------------------------------------------
   *
   * `getSettings` CREATES a `user_settings` row on a miss, which is right for
   * the settings screen (a learner who opened it is about to save something)
   * and wrong for this caller in particular. The persona is resolved on the
   * GRADING path: issues #319 and #320 ask this question while composing the
   * feedback for a practice attempt and the tutor's explanation stream. A row
   * written because somebody answered a civics question is a write nobody
   * asked for, on the hottest path in the product, and it would land inside
   * (or alongside) the transaction that records the attempt. `readVoicePreferences`
   * above and `NotificationsService` avoid `getSettings` for the same reason.
   *
   * ---------------------------------------------------------------------------
   * BUT IT LIVES HERE, RATHER THAN THE COLUMN BEING READ AT THE CALL SITE
   * ---------------------------------------------------------------------------
   *
   * The shape of `user_settings.value` — a JSONB blob whose namespaces are
   * SPARSE, where absent means "use the built-in default" and never "off" — is
   * this service's own contract (see
   * `common/schemas/user-settings-namespaces.schema.ts`'s header on why no
   * namespace carries a `.default()`). A consumer casting the column and
   * reaching for `.coach` would be a second place that contract is
   * interpreted, and the first to get it wrong the day the shape moves.
   *
   * Returns `undefined` — never a materialised object of defaults — so the
   * caller keeps the three-way distinction the namespace is built on: set,
   * unset, and unset-because-there-is-no-row. Resolving `undefined` to
   * `DEFAULT_COACH_PERSONA` / `DEFAULT_COACH_REACTIONS` is the CALLER's job,
   * at the point of use, which is what lets a future change to either default
   * reach every learner who never chose.
   */
  async readCoachPreferences(userId: string): Promise<CoachValue | undefined> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { value: true },
    });

    if (!row) return undefined;

    const value = row.value as unknown as UserSettingsValue | null;
    const coach = value?.coach;

    // A SHAPE CHECK, NOT A PARSE. The stored blob was validated on the way in;
    // this guards against a hand-edited or older row making a caller read a
    // property off a string. An unreadable namespace is `undefined`, which the
    // caller already handles as "the learner has expressed no preference".
    return coach && typeof coach === 'object' ? coach : undefined;
  }

  /**
   * Replace user settings (PUT)
   */
  async replaceSettings(userId: string, dto: UpdateUserSettingsDto) {
    // Validate against schema.
    //
    // WARNING: this line silently STRIPS any key the schema does not know
    // about. It is exactly the line that made adding `dataTables` /
    // `navigation` a six-file change: a namespace missing from
    // `userSettingsSchema` is accepted by the controller, dropped here, and
    // never seen again by a subsequent GET — with no error anywhere. If you
    // are adding a new namespace, add it to
    // common/schemas/user-settings-namespaces.schema.ts and wire it into
    // `userSettingsSchema` before anything else.
    const validated = userSettingsSchema.parse(dto);

    // Caps enforced here rather than in zod — see assertDataTableLimit.
    this.assertDataTableLimit(validated.dataTables);
    this.assertNotificationLimit(validated.notifications);

    const settings = await this.prisma.userSettings.upsert({
      where: { userId },
      update: {
        value: validated as any,
        version: { increment: 1 },
      },
      create: {
        userId,
        value: validated as any,
      },
    });

    // Sync display name to user table if provided
    if (validated.profile.displayName !== undefined) {
      await this.syncDisplayName(userId, validated.profile.displayName);
    }

    this.logger.log(`Settings replaced for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * Partial update user settings (PATCH)
   * Uses JSON Merge Patch semantics
   */
  async patchSettings(
    userId: string,
    dto: PatchUserSettingsDto,
    expectedVersion?: number,
  ) {
    // Get current settings
    const current = await this.getSettings(userId);

    // Optimistic concurrency check
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ConflictException(
        `Settings version mismatch. Expected ${expectedVersion}, found ${current.version}`,
      );
    }

    // Merge with existing settings
    const merged: UserSettingsValue = {
      theme: dto.theme ?? current.theme,
      profile: {
        displayName:
          dto.profile?.displayName !== undefined
            ? dto.profile.displayName
            : current.profile.displayName,
        useProviderImage:
          dto.profile?.useProviderImage !== undefined
            ? dto.profile.useProviderImage
            : current.profile.useProviderImage,
        customImageUrl:
          dto.profile?.customImageUrl !== undefined
            ? dto.profile.customImageUrl
            : current.profile.customImageUrl,
      },
    };

    // Optional namespaces: only set the key when the merge produced something,
    // so an emptied namespace collapses back to absent instead of being stored
    // as `{}` (absent means "use built-in defaults", `{}` would not).
    const mergedDataTables = this.mergeDataTables(
      current.dataTables,
      dto.dataTables,
    );
    if (mergedDataTables !== undefined) {
      merged.dataTables = mergedDataTables;
    }

    const mergedNavigation = this.mergeNavigation(
      current.navigation,
      dto.navigation,
    );
    if (mergedNavigation !== undefined) {
      merged.navigation = mergedNavigation;
    }

    const mergedNotifications = this.mergeNotifications(
      current.notifications,
      dto.notifications,
    );
    if (mergedNotifications !== undefined) {
      merged.notifications = mergedNotifications;
    }

    const mergedStudy = this.mergeStudy(current.study, dto.study);
    if (mergedStudy !== undefined) {
      merged.study = mergedStudy;
    }

    const mergedVoice = this.mergeVoice(current.voice, dto.voice);
    if (mergedVoice !== undefined) {
      merged.voice = mergedVoice;
    }

    const mergedCoach = this.mergeCoach(current.coach, dto.coach);
    if (mergedCoach !== undefined) {
      merged.coach = mergedCoach;
    }

    // Enforce the caps AFTER the merge — see assertDataTableLimit.
    this.assertDataTableLimit(merged.dataTables);
    this.assertNotificationLimit(merged.notifications);

    // Validate merged result.
    //
    // WARNING: as in replaceSettings, this call silently strips unknown keys.
    // A namespace that is not part of `userSettingsSchema` disappears right
    // here and never round-trips through GET. See the note in replaceSettings.
    const validated = userSettingsSchema.parse(merged);

    const settings = await this.prisma.userSettings.update({
      where: { userId },
      data: {
        value: validated as any,
        version: { increment: 1 },
      },
    });

    // Sync display name to user table if changed
    if (dto.profile?.displayName !== undefined) {
      await this.syncDisplayName(userId, dto.profile.displayName);
    }

    this.logger.log(`Settings patched for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return this.toResponse(value, settings.updatedAt, settings.version);
  }

  /**
   * Merge the `dataTables` namespace using JSON Merge Patch semantics,
   * PER TABLE ID.
   *
   * - patch absent            -> keep the stored namespace untouched
   * - patch is `null`         -> clear the whole namespace
   * - `{ jobs: null }`        -> delete the `jobs` entry, leave others alone
   * - `{ jobs: { pageSize } }`-> REPLACE the `jobs` entry wholesale. This is
   *   deliberately not a deep merge: a table's preferences are a single
   *   coherent view state, and a client that sends a partial entry is stating
   *   the entry it wants, so any previously stored `density` for `jobs` is
   *   discarded. Entries for other tables are never affected.
   *
   * An empty result collapses to `undefined` so the namespace disappears from
   * storage rather than persisting as `{}`.
   */
  private mergeDataTables(
    current: DataTablesValue | undefined,
    patch: DataTablesPatchValue | null | undefined,
  ): DataTablesValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: DataTablesValue = { ...(current ?? {}) };

    for (const [tableId, entry] of Object.entries(patch)) {
      if (entry === null) {
        delete merged[tableId];
      } else if (entry !== undefined) {
        merged[tableId] = entry;
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge the `navigation` namespace field-wise.
   *
   * - patch absent           -> keep the stored namespace untouched
   * - patch is `null`        -> clear the whole namespace
   * - field omitted          -> stored value untouched
   * - field set to a value   -> replaces the stored value
   * - field set to `null`    -> deletes the field, so the client falls back to
   *   its built-in default rather than to a hard-coded stored one
   *
   * As with dataTables, an empty result collapses to `undefined`.
   */
  private mergeNavigation(
    current: NavigationValue | undefined,
    patch: NavigationPatchValue | null | undefined,
  ): NavigationValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: NavigationValue = { ...(current ?? {}) };

    if (patch.railCollapsed === null) {
      delete merged.railCollapsed;
    } else if (patch.railCollapsed !== undefined) {
      merged.railCollapsed = patch.railCollapsed;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge the `study` namespace (epic #56 / E7) field-wise.
   *
   * The same five cases as {@link mergeNavigation}, and deliberately the same
   * SHAPE of merge rather than `mergeDataTables`' replace-wholesale: `study`
   * is a small flat object of INDEPENDENT scalar choices, so a learner who
   * PATCHes `{ study: { reminderEnabled: false } }` must keep the reminder
   * hour they picked last month. Replacing wholesale would silently discard it
   * and hand them back the built-in default the next time they switched
   * reminders on — a preference lost with no error anywhere.
   *
   * - patch absent           -> keep the stored namespace untouched
   * - patch is `null`        -> clear the whole namespace
   * - field omitted          -> stored value untouched
   * - field set to a value   -> replaces the stored value
   * - field set to `null`    -> deletes the field, so the reminder falls back
   *   to `DEFAULT_STUDY_REMINDER_HOUR` / `DEFAULT_STUDY_REMINDER_ENABLED`
   *   rather than to a hard-coded stored copy of today's default
   *
   * A SEPARATE METHOD RATHER THAN A SECOND CALL TO `mergeNavigation`, even
   * though the two are the same shape: `mergeNavigation` names
   * `railCollapsed` explicitly, and a shared generic "merge a flat object"
   * helper would have to accept any key — which is precisely the check the
   * field-wise form performs for free. Two short, total methods that each
   * fail to compile when their namespace gains a field beat one clever one
   * that silently accepts anything.
   *
   * As with its neighbours, an empty result collapses to `undefined` so the
   * namespace disappears rather than persisting as `{}`.
   */
  private mergeStudy(
    current: StudyValue | undefined,
    patch: StudyPatchValue | null | undefined,
  ): StudyValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: StudyValue = { ...(current ?? {}) };

    if (patch.reminderHour === null) {
      delete merged.reminderHour;
    } else if (patch.reminderHour !== undefined) {
      merged.reminderHour = patch.reminderHour;
    }

    if (patch.reminderEnabled === null) {
      delete merged.reminderEnabled;
    } else if (patch.reminderEnabled !== undefined) {
      merged.reminderEnabled = patch.reminderEnabled;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge the `voice` namespace (issue #282, epic #280; `conversationMode`
   * added by issue #307, epic #304) field-wise.
   *
   * Seven independent scalar choices, none of them a nested map — the
   * identical shape `mergeStudy` already establishes, and merged the same
   * way for the same reason: a learner who PATCHes `{ voice: { speechRate:
   * 1.1 } }` must keep the voice and auto-submit preference they already
   * set, so replacing the namespace wholesale (`mergeDataTables`' strategy)
   * would silently discard them.
   *
   * - patch absent           -> keep the stored namespace untouched
   * - patch is `null`        -> clear the whole namespace
   * - field omitted          -> stored value untouched
   * - field set to a value   -> replaces the stored value
   * - field set to `null`    -> deletes the field, so the learner falls back
   *   to the matching `DEFAULT_VOICE_*` constant rather than to a
   *   hard-coded stored copy of today's default
   *
   * A SEPARATE METHOD RATHER THAN A SHARED GENERIC HELPER, for the identical
   * reason `mergeStudy`'s own comment gives for not reusing `mergeNavigation`:
   * each method names its namespace's fields explicitly, so a field added to
   * the schema without a matching line here fails to compile instead of
   * being silently accepted and dropped.
   *
   * As with its neighbours, an empty result collapses to `undefined` so the
   * namespace disappears rather than persisting as `{}`.
   */
  private mergeVoice(
    current: VoiceValue | undefined,
    patch: VoicePatchValue | null | undefined,
  ): VoiceValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: VoiceValue = { ...(current ?? {}) };

    if (patch.autoSubmitSpoken === null) {
      delete merged.autoSubmitSpoken;
    } else if (patch.autoSubmitSpoken !== undefined) {
      merged.autoSubmitSpoken = patch.autoSubmitSpoken;
    }

    if (patch.preferPremiumVoice === null) {
      delete merged.preferPremiumVoice;
    } else if (patch.preferPremiumVoice !== undefined) {
      merged.preferPremiumVoice = patch.preferPremiumVoice;
    }

    if (patch.preferredVoice === null) {
      delete merged.preferredVoice;
    } else if (patch.preferredVoice !== undefined) {
      merged.preferredVoice = patch.preferredVoice;
    }

    if (patch.speechRate === null) {
      delete merged.speechRate;
    } else if (patch.speechRate !== undefined) {
      merged.speechRate = patch.speechRate;
    }

    if (patch.readQuestionsAloud === null) {
      delete merged.readQuestionsAloud;
    } else if (patch.readQuestionsAloud !== undefined) {
      merged.readQuestionsAloud = patch.readQuestionsAloud;
    }

    if (patch.readAnswersAloud === null) {
      delete merged.readAnswersAloud;
    } else if (patch.readAnswersAloud !== undefined) {
      merged.readAnswersAloud = patch.readAnswersAloud;
    }

    if (patch.conversationMode === null) {
      delete merged.conversationMode;
    } else if (patch.conversationMode !== undefined) {
      merged.conversationMode = patch.conversationMode;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge the `coach` namespace (issue #317, epic #305) field-wise.
   *
   * Two independent scalar choices, neither of them a nested map — the
   * identical shape `mergeVoice` and `mergeStudy` already establish, and
   * merged the same way for the same reason: the two fields answer different
   * questions (`persona` is HOW the coach speaks, `reactions` is WHETHER it
   * says anything beyond the verdict), so a learner who PATCHes
   * `{ coach: { reactions: false } }` must keep the persona they picked.
   * Replacing the namespace wholesale (`mergeDataTables`' strategy) would
   * silently drop it back to `DEFAULT_COACH_PERSONA` the moment they silenced
   * the chatter — a preference lost with no error anywhere.
   *
   * - patch absent           -> keep the stored namespace untouched
   * - patch is `null`        -> clear the whole namespace
   * - field omitted          -> stored value untouched
   * - field set to a value   -> replaces the stored value
   * - field set to `null`    -> deletes the field, so the learner falls back
   *   to `DEFAULT_COACH_PERSONA` / `DEFAULT_COACH_REACTIONS` rather than to a
   *   hard-coded stored copy of today's default
   *
   * A SEPARATE METHOD RATHER THAN A SHARED GENERIC HELPER, for the identical
   * reason `mergeVoice`'s and `mergeStudy`'s own comments give: each method
   * names its namespace's fields explicitly, so a field added to the schema
   * without a matching line here fails to compile instead of being silently
   * accepted and dropped. A generic "merge a flat object" helper would have to
   * accept any key, which is exactly the check the field-wise form performs
   * for free.
   *
   * As with its neighbours, an empty result collapses to `undefined` so the
   * namespace disappears rather than persisting as `{}`.
   */
  private mergeCoach(
    current: CoachValue | undefined,
    patch: CoachPatchValue | null | undefined,
  ): CoachValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: CoachValue = { ...(current ?? {}) };

    if (patch.persona === null) {
      delete merged.persona;
    } else if (patch.persona !== undefined) {
      merged.persona = patch.persona;
    }

    if (patch.reactions === null) {
      delete merged.reactions;
    } else if (patch.reactions !== undefined) {
      merged.reactions = patch.reactions;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge the `notifications` namespace (#126, epic #109) using JSON Merge
   * Patch semantics, PER CHANNEL and then PER EVENT KEY.
   *
   * - patch absent                       -> keep the stored namespace untouched
   * - patch is `null`                    -> clear the whole namespace
   * - `{ email: null }`                  -> clear the `email` channel, leaving
   *   any `browser` preferences alone
   * - `{ email: { 'user.welcome': null } }` -> DELETE that one event key, so
   *   the event falls back to the registry's `defaultEnabled`. This is the
   *   operation the preferences page sends when a control returns to its
   *   default; storing the default value instead would pin that user to
   *   today's default forever and re-materialise the key the sparse contract
   *   exists to keep absent.
   * - `{ email: { 'user.welcome': false } }` -> set that one key, touching
   *   nothing else on the channel.
   *
   * WHY THIS DEEP-MERGES WHERE mergeDataTables REPLACES. A data table entry is
   * one coherent view state, so a client sending it is stating the whole
   * entry. A channel's preferences are the opposite: a row of INDEPENDENT
   * per-event choices, and #126 PATCHes exactly the one key the user just
   * toggled. Replacing the channel wholesale would therefore erase every other
   * preference on that channel on every single toggle — silently re-enabling
   * mail the user had already turned off, which is the loudest possible
   * regression for a notifications feature.
   *
   * COLLAPSING IS LOAD-BEARING AT BOTH LEVELS. A channel whose last key was
   * deleted is removed rather than stored as `{}`, and an empty namespace
   * returns `undefined` so the caller omits the key entirely. Absent means
   * "use the built-in defaults"; `{}` is a second spelling of the same state
   * that the read path does not produce (`readNotificationPreferences` drops
   * empty maps too), and two spellings of one state is how the UI and the
   * dispatcher end up disagreeing about whether a user has an opinion.
   *
   * DELIBERATELY NO `mandatory` CHECK HERE. A stored `false` for a mandatory
   * event is accepted and is inert: `isChannelEnabled` (#125) tests
   * `event.mandatory` before it ever looks at stored preferences, so the value
   * is never consulted. That resolver is the single security gate on purpose —
   * it also covers rows written before an event became mandatory, and requests
   * that never went near the UI. A second gate here could only disagree with
   * the one that actually decides delivery.
   *
   * Event keys are NOT validated against the registry — see the header of
   * user-settings-namespaces.schema.ts for the three ways that breaks.
   */
  private mergeNotifications(
    current: NotificationsValue | undefined,
    patch: NotificationsPatchValue | null | undefined,
  ): NotificationsValue | undefined {
    if (patch === undefined) {
      return current;
    }

    if (patch === null) {
      return undefined;
    }

    const merged: NotificationsValue = {};

    // Copy the stored namespace one level deep. A shallow `{ ...current }`
    // would share the per-channel objects with the value we just read, and the
    // `delete` below would then mutate them in place.
    for (const [channel, events] of Object.entries(current ?? {})) {
      if (events !== undefined) {
        merged[channel as NotificationChannel] = { ...events };
      }
    }

    for (const [channel, channelPatch] of Object.entries(patch)) {
      const key = channel as NotificationChannel;

      if (channelPatch === null) {
        delete merged[key];
        continue;
      }

      if (channelPatch === undefined) {
        continue;
      }

      const events: NotificationChannelPreferencesValue = {
        ...(merged[key] ?? {}),
      };

      for (const [eventKey, choice] of Object.entries(channelPatch)) {
        if (choice === null) {
          delete events[eventKey];
        } else if (choice !== undefined) {
          events[eventKey] = choice;
        }
      }

      if (Object.keys(events).length > 0) {
        merged[key] = events;
      } else {
        // Last key deleted: the channel goes away rather than persisting as
        // `{}`. See "COLLAPSING IS LOAD-BEARING" above.
        delete merged[key];
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Enforce the per-user cap on persisted notification preferences.
   *
   * The event level is an OPEN map — event keys are registry data and are
   * deliberately not validated against the registry (see
   * user-settings-namespaces.schema.ts) — so without a cap an authenticated
   * user can inflate their own `user_settings` row without limit by PATCHing
   * arbitrary keys. The channel level is closed by the enum, so bounding the
   * entries per channel bounds the namespace.
   *
   * Enforced here, not in zod, for the same two reasons as
   * assertDataTableLimit: `z.record()` has no key-count refinement, and the
   * cap has to be checked against the MERGED result rather than the request
   * body. A ZodError thrown from the service would escape as a 500 instead of
   * the 400 the client deserves, hence the explicit BadRequestException.
   */
  private assertNotificationLimit(
    notifications: NotificationsValue | undefined,
  ): void {
    if (!notifications) {
      return;
    }

    for (const [channel, events] of Object.entries(notifications)) {
      const count = Object.keys(events ?? {}).length;
      if (count > NOTIFICATION_MAX_EVENTS_PER_CHANNEL) {
        throw new BadRequestException(
          `Too many notification preferences for channel "${channel}": ${count} exceeds the maximum of ${NOTIFICATION_MAX_EVENTS_PER_CHANNEL}. Remove preferences you no longer need (send them as null) before adding new ones.`,
        );
      }
    }
  }

  /**
   * Enforce the per-user cap on the number of persisted data table entries.
   *
   * This is a storage-exhaustion control (see
   * user-settings-namespaces.schema.ts), and it is enforced HERE rather than in
   * zod for two reasons:
   *
   * 1. `z.record()` cannot express "at most N keys" — there is no key-count
   *    refinement that survives the record type.
   * 2. Even if it could, the cap has to be checked against the MERGED result,
   *    not the request body: a 3-entry patch on top of 39 stored entries is
   *    over the cap while the body alone is not. Doing that check inside the
   *    post-merge `userSettingsSchema.parse()` would surface it as a raw
   *    `ZodError` thrown from the service — which escapes as a 500, not the
   *    400 the client deserves. Hence an explicit BadRequestException.
   */
  private assertDataTableLimit(dataTables: DataTablesValue | undefined): void {
    if (!dataTables) {
      return;
    }

    const count = Object.keys(dataTables).length;
    if (count > DATA_TABLE_MAX_TABLES) {
      throw new BadRequestException(
        `Too many data table preferences: ${count} exceeds the maximum of ${DATA_TABLE_MAX_TABLES}. Remove entries for tables you no longer use (send them as null) before adding new ones.`,
      );
    }
  }

  /**
   * Sync display name from settings to user table
   */
  private async syncDisplayName(
    userId: string,
    displayName: string | undefined,
  ) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { displayName: displayName || null },
    });
  }

  /**
   * Update profile image preference
   */
  async updateProfileImage(
    userId: string,
    useProviderImage: boolean,
    customImageUrl?: string | null,
  ) {
    return this.patchSettings(userId, {
      profile: {
        useProviderImage,
        customImageUrl,
      },
    });
  }

  /**
   * Update theme preference
   */
  async updateTheme(userId: string, theme: 'light' | 'dark' | 'system') {
    return this.patchSettings(userId, { theme });
  }
}
