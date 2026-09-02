import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  US_STATE_AND_TERRITORY_CODES,
  isValidStateOrTerritoryCode,
} from '../../common/constants/us-states.constants';

// =============================================================================
// PUT /api/journey/profile — request body (issue #65, epic #50)
// =============================================================================
//
// ONE WRITE ENDPOINT, TWO CALLERS: `/setup/journey` (orientation, #67) and
// `/settings/journey` (#68). journey-shell.md §6.3 settles `PUT` as the verb,
// matching `PUT /api/user-settings`.
//
// -----------------------------------------------------------------------------
// EVERY FIELD IS OPTIONAL, AND AN ABSENT KEY LEAVES THE FIELD UNCHANGED
// -----------------------------------------------------------------------------
//
// So this is a MERGE under a `PUT`, which is worth justifying rather than
// leaving as a surprise. Both callers send the whole form — orientation
// collects all six fields at once, and the settings page renders the profile
// it just fetched and posts it back — so merge-versus-replace is moot in
// practice: the request already carries every field either way.
//
// Where they differ is the failure mode when a client sends LESS than the
// whole form, and there merge is strictly the safer default. Replace semantics
// would mean a client that omits `timezone` silently resets a learner's zone
// to the column default and moves every countdown they see; merge means it
// keeps the value nobody asked to change. Neither behaviour is reachable from
// this app's own screens today, so the one that fails harmlessly wins.
//
// The one deliberate exception is `interviewDate`, where an explicit `null`
// CLEARS the date — an interview that got cancelled has to be removable, and
// with merge semantics there is otherwise no way to express "no date" at all.
// Absent still means unchanged; only an explicit null clears.
//
// -----------------------------------------------------------------------------
// THERE IS NO USER ID FIELD, AND THERE NEVER WILL BE
// -----------------------------------------------------------------------------
//
// The learner is resolved from `@CurrentUser('id')` in the controller and from
// nowhere else. A `userId` here would be an authorization decision made from
// request data, which is the whole class of bug the controller's guarantee
// exists to make impossible. There is a compile-time proof at the bottom of
// this file.
//
// -----------------------------------------------------------------------------
// THERE IS NO `completeOrientation` FLAG EITHER, AND THAT IS THE POINT
// -----------------------------------------------------------------------------
//
// Orientation completion is INFERRED SERVER-SIDE from what the profile
// actually holds after the merge (see `journey.service.ts`). A boolean the
// client sets was the obvious alternative and it loses on three counts:
//
//   1. It is spoofable. `{"completeOrientation": true}` with an empty profile
//      would mark a learner oriented, release `RequireOrientation`, and hand
//      them a product configured for a test nobody chose. Inference cannot be
//      spoofed, because the evidence IS the stored data.
//   2. It can disagree with the data. A flag and the fields it claims to
//      attest are two facts that can drift; the inference has only one.
//   3. It puts a state transition in the client's hands. `stage` moves
//      `uncertain` → `oriented` as a CONSEQUENCE of the profile being
//      complete — journey-shell.md §6.3: "a learner never POSTs a `stage`
//      value directly". There is no `stage` field here for the same reason.
// =============================================================================

/**
 * An IANA timezone this process can actually format in.
 *
 * PROBED WITH `Intl.DateTimeFormat`, DELIBERATELY, rather than checked against
 * `Intl.supportedValuesOf('timeZone')`. The probe is the authority because it
 * is the exact operation `Clock.calendarDateIn` performs on every read: that
 * method throws `RangeError` on an unknown zone rather than falling back to
 * UTC, precisely so a bad stored value cannot become a countdown that is
 * quietly off by one. Validating with anything the `Clock` would later reject
 * would move that failure from write time — where a learner can fix their own
 * input — to read time, where it is a 500 on the front page.
 *
 * `supportedValuesOf` is the narrower list and would reject legitimate zones
 * the `Clock` accepts happily: it omits link/alias names like `US/Pacific` and
 * `Asia/Calcutta`, which browsers do still hand out. Rejecting a zone the rest
 * of the system supports is a worse failure than accepting an alias.
 */
function isSupportedTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * A structurally valid BCP-47 language tag.
 *
 * `Intl.getCanonicalLocales` throws `RangeError` for anything malformed —
 * `'en_US'`, `'e'`, `'123'`, `'en-'` — and accepts anything well-formed. It
 * checks STRUCTURE, not registry membership, and that is the right line to
 * draw: this tag governs AI explanation language, so a well-formed tag we do
 * not recognise should reach the provider and be handled there, not be
 * rejected here by a list this repository would have to maintain and keep
 * current.
 */
function isWellFormedLanguageTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

/**
 * The daily goal's accepted range, in minutes.
 *
 * The floor is 1, not 0: "five minutes should matter" is the product's stated
 * position, and a goal of zero minutes is not a goal — it is an opt-out
 * wearing a number, and it would make E7's streak math answer "goal met" for
 * doing nothing.
 *
 * The ceiling is 480 (eight hours). Nobody studies civics for a working day,
 * so a larger value is a typo or a fat-fingered slider, and letting it through
 * hands the learner a goal they will fail every single day — the opposite of
 * what `VISION.md` asks this number to do.
 */
export const DAILY_GOAL_MIN_MINUTES = 1;
export const DAILY_GOAL_MAX_MINUTES = 480;

export const updateJourneyProfileSchema = z
  .object({
    /**
     * Absent leaves the current date alone; explicit `null` clears it. See the
     * header on why this one field admits null.
     */
    interviewDate: z.iso
      .date('interviewDate must be a calendar date in YYYY-MM-DD form')
      .nullable()
      .optional(),

    /**
     * Validated against the full 56-code domain in
     * `common/constants/us-states.constants.ts` — the same constant the
     * response serves, so what the form offers and what the API accepts cannot
     * drift. Uppercased first, so a browser sending `ca` is corrected rather
     * than rejected for a difference that carries no meaning.
     */
    stateCode: z
      .string()
      .trim()
      .transform((code) => code.toUpperCase())
      .refine(isValidStateOrTerritoryCode, {
        message: `stateCode must be one of the ${US_STATE_AND_TERRITORY_CODES.length} US state or territory codes`,
      })
      .optional(),

    /**
     * A civics test version code.
     *
     * SHAPE ONLY HERE; EXISTENCE IS CHECKED AGAINST THE DATABASE in
     * `JourneyService`, against the rows actually in `civics_test_versions`,
     * and a miss is a 400. A hardcoded `z.enum(['v2008','v2025'])` would be a
     * third declaration of the version set — after the table and its seed —
     * and would reject a future revision row the moment it is inserted, which
     * is the whole reason journey-shell.md §3.1 made this a table rather than
     * a Prisma enum.
     */
    testVersionCode: z.string().trim().min(1).optional(),

    /**
     * The learner's Form N-400 filing date. NOT STORED — it is an input the
     * server resolves `testVersionCode` from, and nothing else.
     *
     * journey-shell.md §3.2: the version is "resolved once, at orientation
     * submit time, from the filing date the learner enters — not recomputed
     * live on every read", and §6.3: "the handler, not the client, resolves
     * `test_version_code`". The browser never learns the cutoff rule.
     */
    filingDate: z.iso
      .date('filingDate must be a calendar date in YYYY-MM-DD form')
      .optional(),

    /** Self-attested. The helper text asks for honesty; nothing verifies it. */
    seniorExemption: z.boolean().optional(),

    dailyGoalMinutes: z
      .number()
      .int('dailyGoalMinutes must be a whole number of minutes')
      .min(DAILY_GOAL_MIN_MINUTES)
      .max(DAILY_GOAL_MAX_MINUTES)
      .optional(),

    explanationLanguage: z
      .string()
      .trim()
      .refine(isWellFormedLanguageTag, {
        message:
          'explanationLanguage must be a well-formed BCP-47 language tag, e.g. "en" or "es-MX"',
      })
      .optional(),

    timezone: z
      .string()
      .trim()
      .refine(isSupportedTimeZone, {
        message:
          'timezone must be an IANA time zone identifier, e.g. "America/Los_Angeles"',
      })
      .optional(),
  })
  .strict()
  .refine(
    (body) => !(body.filingDate !== undefined && body.testVersionCode !== undefined),
    {
      message:
        'Send either filingDate or testVersionCode, not both — the server resolves the test version from the filing date',
      path: ['filingDate'],
    },
  );

export type UpdateJourneyProfileInput = z.infer<
  typeof updateJourneyProfileSchema
>;

export class UpdateJourneyProfileDto extends createZodDto(
  updateJourneyProfileSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no caller-supplied identity crept into the body
// -----------------------------------------------------------------------------
//
// The technique is `ai/ai-settings.schema.ts`'s no-secret-fields proof, aimed
// at a different hazard. Adding any of the names below to the schema above
// makes `UpdateJourneyProfileNamesNoUser` resolve to `never` and this file
// stops compiling — a build break at the moment of the mistake, rather than a
// security review that has to notice one new optional string.
//
// It is worth a proof rather than a convention because the failure is silent
// and total: a `userId` here would let any authenticated learner write another
// learner's profile, and the request would look entirely ordinary in a log.
//
// `stage` is on the list for the adjacent reason — it is not an identity, but
// it is the one field a client must never write, since the transition is a
// consequence the server infers (see the header).
//
// If you are here because this line went red: you are adding a field that
// names a user or sets a stage. The caller is `@CurrentUser('id')`; the stage
// is inferred in `JourneyService`.

type ForbiddenBodyFieldNames =
  | 'userId'
  | 'user_id'
  | 'id'
  | 'learnerId'
  | 'profileId'
  | 'email'
  | 'stage'
  | 'orientationCompletedAt'
  | 'completeOrientation';

export type UpdateJourneyProfileNamesNoUser = Extract<
  keyof UpdateJourneyProfileInput,
  ForbiddenBodyFieldNames
> extends never
  ? true
  : never;

export const UPDATE_JOURNEY_PROFILE_NAMES_NO_USER: UpdateJourneyProfileNamesNoUser =
  true;
