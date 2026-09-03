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
  JourneyHome,
  JourneyProfile,
  JourneyProfileResponse,
  JourneyStage,
  NextAction,
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

// =============================================================================
// Home screen fixtures (issue #74, epic #50)
// =============================================================================
//
// Shaped from `apps/api/src/journey/dto/journey-home.dto.ts` and
// `dto/journey-stage.dto.ts`, and from `journey-stages.ts`'s registry.
//
// A WORD ON `JOURNEY_STAGES` BELOW, BECAUSE IT LOOKS LIKE THE DUPLICATE
// REGISTRY THE SPEC REJECTS AND IS NOT ONE. §6 forbids a copy in
// `apps/web/src/config` — a copy the APPLICATION reads, which can disagree with
// the server in a running build. This is a fixture: it is what a TEST pretends
// the server said, it is never imported by application code, and the suite that
// uses it deliberately serves a DIFFERENT list (`ALTERNATE_STAGES`) to prove the
// page renders whatever arrives rather than anything it knows.
// =============================================================================

/** The eight stages, as `GET /api/journey/stages` sends them. */
export const JOURNEY_STAGES: JourneyStage[] = [
  {
    key: 'uncertain',
    label: 'Just starting',
    description:
      "You're just getting started — that's the whole point of being here.",
  },
  {
    key: 'oriented',
    label: 'Oriented',
    description:
      "You've told us where you stand, so we can show you the right test and a real countdown.",
  },
  {
    key: 'learning',
    label: 'Learning',
    description: "You're meeting the material for the first time.",
  },
  {
    key: 'remembering',
    label: 'Remembering',
    description: 'Answers are starting to stick.',
  },
  {
    key: 'speaking',
    label: 'Speaking',
    description:
      "You're practicing saying answers out loud, not just typing them.",
  },
  {
    key: 'practicing',
    label: 'Practicing',
    description:
      "You're building real, repeated evidence toward the interview.",
  },
  {
    key: 'performing',
    label: 'Performing',
    description:
      "You're consistently doing well, including under realistic conditions.",
  },
  {
    key: 'ready',
    label: 'Ready',
    description: 'The evidence says you’re ready.',
  },
];

/**
 * A registry that is NOT the real one — different keys, different labels, a
 * different length.
 *
 * This is the whole structural argument that the stage list is not hardcoded in
 * the web app: served from MSW, the page must render THESE five stages and mark
 * THIS current one. A component holding its own eight cannot pass.
 */
export const ALTERNATE_STAGES: JourneyStage[] = [
  { key: 'alpha', label: 'Alpha stage', description: 'The first invented one.' },
  { key: 'beta', label: 'Beta stage', description: 'The second invented one.' },
  { key: 'gamma', label: 'Gamma stage', description: 'The third invented one.' },
  { key: 'delta', label: 'Delta stage', description: 'The fourth invented one.' },
  {
    key: 'epsilon',
    label: 'Epsilon stage',
    description: 'The fifth invented one.',
  },
];

/**
 * The `nextAction`s `apps/api/src/journey/next-action.ts` produces, copied from
 * that file so a test asserting "the card renders what the server sent" is
 * asserting it against the real strings.
 *
 * `practice` is E3's addition (#81, `practice-sessions.md` §12), `review` is
 * E5's (#82, `memory-model.md` §6) and `interview` is E8's (#133,
 * `mock-interview.md` §14.1) — the last two produced by `study-coach.ts`'s
 * `recommendStudyAction` rather than by `next-action.ts` itself, which has
 * neither mastery counts nor a journey stage to decide them with.
 *
 * Keyed as a TOTAL `Record` over the union on purpose: a widened union with no
 * fixture for its new member fails to compile here, which is a better reminder
 * than a suite that silently never exercises the new kind. (`tsconfig.json`
 * excludes `src/__tests__`, so that failure surfaces in an editor and in
 * review rather than in `npm run typecheck` — which is why the two members
 * added between #82 and #145 could go missing at all.)
 */
export const NEXT_ACTIONS: Record<NextAction['kind'], NextAction> = {
  orientation: {
    kind: 'orientation',
    title: 'Finish setting up your plan.',
    reason: "A couple of quick questions, then you're ready to start.",
    path: '/setup/journey',
  },
  interview_countdown: {
    kind: 'interview_countdown',
    title: '12 days until your interview',
    reason: 'Start with the material, then build up to full practice.',
    path: '/learn',
  },
  explore: {
    kind: 'explore',
    title: "See what's here so far.",
    reason:
      "The learning and practice tools are on their way. For now, take a look at what's ready.",
    path: '/learn',
  },
  practice: {
    kind: 'practice',
    title: 'Practise five questions.',
    reason: 'Answering in your own words is what makes an answer stick.',
    path: '/practice',
  },
  review: {
    kind: 'review',
    title: 'Review 4 questions.',
    reason:
      "You have 4 questions ready to review — reviewing what you've already learned keeps it from slipping.",
    path: '/practice',
  },
  /**
   * E8's rung (#133), copied from `study-coach.ts`'s own branch 5.
   *
   * `path` is the ONE next-action path that is not `/practice`, `/learn` or
   * `/setup/journey`: `NEXT_ACTION_PATHS.interview` is `/practice/interviews`,
   * because a card inviting a learner to rehearse a full interview that landed
   * them on the five-question drill page would be the "points at a route that
   * does not do what the card said" failure that map exists to prevent.
   *
   * The copy is an INVITATION, not a push — no countdown, no streak, nothing
   * they could lose. `VISION.md` forbids manufacturing pressure by name, and a
   * full rehearsal is the card most tempting to sell with urgency.
   */
  interview: {
    kind: 'interview',
    title: 'Try a practice interview.',
    reason:
      "You've done today's practice. When you have a quiet twenty minutes, a full " +
      'practice interview is the closest this gets to the real thing — and the more ' +
      'familiar the day feels, the easier it is.',
    path: '/practice/interviews',
  },
};

/**
 * A `GET /api/journey/home` body.
 *
 * `dailyGoal.tracked` is `false` and there is NO `minutesToday`, because the
 * real payload has neither — a fixture that invented one would let a component
 * that renders a fabricated number pass.
 */
export function homeResponse(overrides: Partial<JourneyHome> = {}): JourneyHome {
  return {
    stage: 'oriented',
    interviewDate: '2026-11-04',
    daysUntilInterview: 12,
    interviewPast: false,
    dailyGoal: { minutes: 15, tracked: false },
    nextAction: NEXT_ACTIONS.interview_countdown,
    ...overrides,
  };
}
