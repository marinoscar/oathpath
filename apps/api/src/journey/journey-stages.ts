import type { JourneyStage as PrismaJourneyStage } from '@prisma/client';

// =============================================================================
// Journey stage registry (issue #65, epic #50)
// =============================================================================
//
// The eight stages of `VISION.md`'s "Journey to Readiness", in journey order,
// with the user-facing copy `docs/specs/journey-shell.md` §1 settles.
//
// -----------------------------------------------------------------------------
// WHERE THIS LIVES, AND WHY IT IS NOT DUPLICATED IN apps/web
// -----------------------------------------------------------------------------
//
// The API owns this list; the web reads it over `GET /api/journey/stages` and
// keeps no copy in `apps/web/src/config`. That is option 1 of the three
// `notifications/notification-events.ts` weighs, chosen here for the same
// reason it was chosen there and again in `ai/ai-model-roles.ts`: a duplicate
// with a test asserting the two agree is DETECTION rather than prevention —
// the copies can still disagree in a working tree, in a branch, and in any
// build where the test is not run.
//
// journey-shell.md §11 records the duplicate-in-`apps/web` alternative and why
// it lost, so this is a settled decision rather than a preference.
//
// -----------------------------------------------------------------------------
// THIS FILE IS NOT A NEST PROVIDER
// -----------------------------------------------------------------------------
//
// Pure data and pure functions, exactly like `notification-events.ts`, so the
// controller, the tests and any later consumer can read it without standing up
// DI for a constant. The one import below is `import type` — it is erased at
// compile time, so nothing here has a runtime dependency on Prisma either.
//
// -----------------------------------------------------------------------------
// WHAT IS DELIBERATELY ABSENT
// -----------------------------------------------------------------------------
//
// This registry is PRESENTATION data. It does not carry which epic owns a
// transition (§1's "owning epic" column is documentation for contributors, not
// a fact a browser needs), and it does not carry a learner's own stage — that
// is `GET /api/journey/profile`. journey-shell.md §6.1: "what stages exist"
// and "which one is this learner in" have different audiences and different
// cache lifetimes, so they are two endpoints rather than one merged payload.
// =============================================================================

/** One stage, as declared here and as served by `GET /api/journey/stages`. */
export interface JourneyStageDef {
  /**
   * Stable identifier. Persisted — it is a value of the `JourneyStage`
   * Postgres enum and of `learner_profiles.stage`.
   *
   * Renaming one is a migration, not a refactor. The proof below makes the
   * database's opinion and this file's opinion the same fact.
   */
  readonly key: string;

  /** Short human label. What a learner sees next to their own stage. */
  readonly label: string;

  /** One sentence, in the learner's terms, on what this stage means. */
  readonly description: string;
}

/**
 * The eight stages, in journey order. Order is meaningful: it is the sequence
 * the product shows progress along, so this array is also the render order.
 *
 * `as const` is load-bearing — {@link JourneyStageKey} is derived from it, so
 * the key union and the declarations cannot disagree.
 */
export const JOURNEY_STAGES = [
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
    description: "The evidence says you're ready.",
  },
] as const satisfies readonly JourneyStageDef[];

/**
 * The stage keys as a union type, DERIVED from the array above rather than
 * hand-written beside it.
 *
 * A hand-written union is a second declaration that can drift from the first;
 * this one cannot, because adding an entry widens it in the same edit.
 */
export type JourneyStageKey = (typeof JOURNEY_STAGES)[number]['key'];

/** The eight keys, in journey order. Frozen: this is process-lifetime state. */
export const JOURNEY_STAGE_KEYS: readonly JourneyStageKey[] = Object.freeze(
  JOURNEY_STAGES.map((stage) => stage.key),
);

/** The registry entry for `key`, or `undefined` if there is no such stage. */
export function findJourneyStage(key: string): JourneyStageDef | undefined {
  return JOURNEY_STAGES.find((stage) => stage.key === key);
}

/** Whether `key` names one of the eight stages. */
export function isJourneyStageKey(key: string): key is JourneyStageKey {
  return JOURNEY_STAGE_KEYS.includes(key as JourneyStageKey);
}

// -----------------------------------------------------------------------------
// Compile-time proof that this registry and the database enum agree
// -----------------------------------------------------------------------------
//
// `learner_profiles.stage` is a real Postgres enum (`JourneyStage`), not the
// plain-string registry idiom `NotificationDelivery.eventKey` uses — the eight
// stages are a CLOSED set, so a ninth costs a migration on purpose
// (journey-shell.md §1 and §11 have the full argument).
//
// That means there are two declarations of the same closed set: the schema's
// enum and this array. They must not drift, and the proof below is what makes
// drift a BUILD BREAK rather than a runtime surprise — a stage added to
// `schema.prisma` but not here, or renamed here but not there, stops this file
// compiling at the moment of the mistake.
//
// The technique is the one `ai/ai-settings.schema.ts` uses for its
// no-secret-fields proof: an assignable-both-ways check that resolves to
// `never` when the sets differ, assigned to a `true` that then fails to type.
//
// If you are here because this line went red: the registry above and
// `JourneyStage` in `apps/api/prisma/schema.prisma` no longer name the same
// eight values. Fix whichever one is wrong; do not delete the proof.

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

export type JourneyStagesMatchDatabaseEnum = MutuallyAssignable<
  JourneyStageKey,
  PrismaJourneyStage
>;

export const JOURNEY_STAGES_MATCH_DATABASE_ENUM: JourneyStagesMatchDatabaseEnum =
  true;
