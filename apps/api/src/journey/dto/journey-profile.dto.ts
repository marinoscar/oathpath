import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { JOURNEY_STAGE_KEYS } from '../journey-stages';

// =============================================================================
// GET/PUT /api/journey/profile — response body (issue #65, epic #50)
// =============================================================================
//
// THREE THINGS IN ONE RESPONSE, and that is deliberate rather than lazy: the
// caller's own profile, the civics test versions, and the state/territory
// list.
//
// This is the argument `ai/dto/ai-model-catalog.dto.ts` makes for shipping the
// model catalog and the role registry together, applied here: the orientation
// form needs all three to render ONE control set — a state select, a test
// version the filing date resolves into, and the profile values that select
// their initial state — and fetching them separately would mean three round
// trips whose results can disagree (a test version added between two calls),
// plus three loading states for one form.
//
// The web reads the two reference lists from HERE rather than holding its own
// copies, which is the same one-registry reasoning `journey-stages.ts` states
// for the stage list. `common/constants/us-states.constants.ts` says so from
// the constant's side: #65 "validates `state_code` against this list and
// serves it to the orientation form — this file is the single source for both,
// so the accepted set can't drift between validation and the UI."
//
// THERE IS NO USER ID IN THIS RESPONSE, and no field that names another user.
// The payload describes the caller's own profile plus two public reference
// lists; a client has nothing here it could use to address anybody else, which
// matches the controller's guarantee that nothing can address anybody else on
// the way in either.
// =============================================================================

/** The caller's own `learner_profiles` row, as sent. */
export const journeyProfileSchema = z.object({
  /**
   * One of the eight `journey-stages.ts` keys. Enumerated from the registry
   * rather than restated, so a stage added there widens this schema in the
   * same edit instead of making the endpoint publish a value its own
   * documentation calls impossible.
   */
  stage: z.enum(JOURNEY_STAGE_KEYS),

  /**
   * `YYYY-MM-DD`, or null when the learner has no interview booked yet.
   *
   * A CALENDAR DATE, NOT AN INSTANT — the column is `@db.Date` for the reason
   * journey-shell.md §3.2 gives: an interview is booked for a day, and later
   * changing the learner's `timezone` must not silently move which day that
   * is. Sending it as a timestamp would hand a client the chance to do exactly
   * that shifting locally.
   */
  interviewDate: z.string().nullable(),

  /** Two-letter state or territory code, null until orientation. */
  stateCode: z.string().nullable(),

  /**
   * The resolved civics test, null until orientation.
   *
   * NULL MEANS "NOT YET RESOLVED", never "the 2008 test". Defaulting this
   * would make an unverified claim about the learner and leave nothing on
   * screen able to distinguish "filed before the cutoff" from "nobody has
   * asked yet" — journey-shell.md §3.2 and §10.
   */
  testVersionCode: z.string().nullable(),

  /** Self-attested 65/20 accommodation. Changes what we ask them to practice. */
  seniorExemption: z.boolean(),

  dailyGoalMinutes: z.number().int(),

  /** BCP-47. Governs AI explanations only; questions stay in English. */
  explanationLanguage: z.string(),

  /** IANA zone name. Every countdown in this API is computed in it. */
  timezone: z.string(),

  /**
   * When orientation was completed, or null.
   *
   * SERVER-SET, ALWAYS. There is no request field that writes it — see
   * `update-journey-profile.dto.ts` for why a client flag was rejected.
   */
  orientationCompletedAt: z.iso.datetime().nullable(),
});

/** One `civics_test_versions` row, plus one derived field. */
export const civicsTestVersionSchema = z.object({
  code: z.string(),
  label: z.string(),
  questionsAsked: z.number().int(),
  passThreshold: z.number().int(),
  seniorQuestionsAsked: z.number().int(),
  seniorPassThreshold: z.number().int(),

  /**
   * The earliest Form N-400 filing date this version applies to, or null when
   * it has no lower bound.
   *
   * DERIVED FROM `test-version-resolution.ts`, NOT A COLUMN. The eligibility
   * rule is about filing dates rather than about the test's shape, and putting
   * it in a seeded row would give the 20 Oct 2025 cutoff a second home — the
   * precise drift journey-shell.md §11 rejects. It travels here so the
   * orientation form can explain which test a date selects without the browser
   * learning the rule either.
   */
  filedFrom: z.string().nullable(),
});

/** One selectable state or territory. */
export const usStateOptionSchema = z.object({
  code: z.string(),
  name: z.string(),
});

export const journeyProfileResponseSchema = z.object({
  profile: journeyProfileSchema,

  /** Every row in `civics_test_versions`, in a stable order. */
  testVersions: z.array(civicsTestVersionSchema),

  /**
   * The 50 states, the federal district, and the five populated territories.
   *
   * All 56 — `DC`, `PR`, `GU`, `VI`, `AS`, `MP` included. Not an oversight to
   * catch later: the civics content's accepted answer for "who are your
   * state's senators" already covers residents of these territories
   * explicitly, so a learner in Guam has to be able to record a real value
   * from day one.
   */
  states: z.array(usStateOptionSchema),
});

export type JourneyProfile = z.infer<typeof journeyProfileSchema>;
export type CivicsTestVersionOption = z.infer<typeof civicsTestVersionSchema>;
export type JourneyProfileResponse = z.infer<
  typeof journeyProfileResponseSchema
>;

export class JourneyProfileResponseDto extends createZodDto(
  journeyProfileResponseSchema,
) {}
