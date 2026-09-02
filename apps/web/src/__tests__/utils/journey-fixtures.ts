/**
 * Journey profile fixtures (issue #72, epic #50).
 *
 * Shaped from `apps/api/src/journey/dto/journey-profile.dto.ts` rather than
 * invented, so a suite that passes here is exercising the payload the server
 * actually sends.
 *
 * `filedFrom` is the field that matters most: it is the server's DERIVED
 * eligibility bound, and the orientation form's test-version preview is built
 * from it. A fixture that dropped it would let a form that hardcoded the cutoff
 * pass — which is the one thing these tests exist to catch.
 */

import type {
  CivicsTestVersionOption,
  JourneyProfile,
  JourneyProfileResponse,
  UsStateOption,
} from '../../types';

/** The two seeded versions, with the bound the server derives for each. */
export const TEST_VERSIONS: CivicsTestVersionOption[] = [
  {
    code: 'v2008',
    label: '2008 Civics Test',
    questionsAsked: 10,
    passThreshold: 6,
    seniorQuestionsAsked: 10,
    seniorPassThreshold: 6,
    // No lower bound: it applies to every filing before the 2025 test's.
    filedFrom: null,
  },
  {
    code: 'v2025',
    label: '2025 Civics Test',
    questionsAsked: 20,
    passThreshold: 12,
    seniorQuestionsAsked: 10,
    seniorPassThreshold: 6,
    filedFrom: '2025-10-20',
  },
];

/**
 * A short state list — enough to select from, including a territory.
 *
 * The real response carries all 56. A territory is in here on purpose: a form
 * that quietly assumed 50 states would pass a fixture that only had states.
 */
export const STATES: UsStateOption[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'CA', name: 'California' },
  { code: 'NY', name: 'New York' },
  { code: 'TX', name: 'Texas' },
  { code: 'PR', name: 'Puerto Rico' },
];

/** A brand-new learner: every column default, nothing answered. */
export const UNORIENTED_PROFILE: JourneyProfile = {
  stage: 'uncertain',
  interviewDate: null,
  stateCode: null,
  testVersionCode: null,
  seniorExemption: false,
  dailyGoalMinutes: 5,
  explanationLanguage: 'en',
  timezone: 'UTC',
  orientationCompletedAt: null,
};

/** The same learner after a successful orientation save. */
export const ORIENTED_PROFILE: JourneyProfile = {
  stage: 'oriented',
  interviewDate: '2026-11-04',
  stateCode: 'CA',
  testVersionCode: 'v2008',
  seniorExemption: false,
  dailyGoalMinutes: 15,
  explanationLanguage: 'es',
  timezone: 'America/Los_Angeles',
  orientationCompletedAt: '2026-09-02T10:00:00.000Z',
};

/** Wrap a profile in the three-part payload both `GET` and `PUT` answer with. */
export function profileResponse(
  profile: JourneyProfile,
  overrides: Partial<JourneyProfileResponse> = {},
): JourneyProfileResponse {
  return {
    profile,
    testVersions: TEST_VERSIONS,
    states: STATES,
    ...overrides,
  };
}
