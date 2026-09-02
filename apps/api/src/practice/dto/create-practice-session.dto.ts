import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// POST /api/practice/sessions — request body (issue #73, epic #52)
// =============================================================================
//
// -----------------------------------------------------------------------------
// TWO KINDS, NOT FIVE, AND THE VALIDATOR IS WHERE THAT IS TRUE
// -----------------------------------------------------------------------------
//
// `practice_sessions.kind` is a five-value Postgres enum — `quick`, `category`,
// `review`, `weak`, `mixed` — and practice-sessions.md §4 explains why all five
// are declared in the database while E3 wires only the first two: `review`,
// `weak` and `mixed` are E5's spaced-repetition selections, and an enum value
// added after real rows exist is a migration over live data, where declaring it
// now and never producing it costs nothing.
//
// This schema is the concrete place "E3 never produces the other three" is
// enforced. A request for `{"kind":"review"}` is a 400 naming the field, not a
// session with a kind nothing in this epic knows how to select questions for.
// When E5 ships, it constructs those sessions from its own scheduler — this DTO
// widening is a deliberate edit with a diff, not a value that leaked through.
//
// -----------------------------------------------------------------------------
// `categoryId` IS REQUIRED IFF `kind` IS `category`, AND BOTH HALVES MATTER
// -----------------------------------------------------------------------------
//
// The pairing is expressed with `superRefine` rather than a discriminated union
// so that BOTH failures name `categoryId` in the error path — a client that
// forgot it and a client that sent one it should not have both get a message
// about the field they actually got wrong, instead of "no union member
// matched".
//
// The second half is the one that is easy to leave out and worth stating: a
// `quick` session carrying a `categoryId` is REJECTED, not silently ignored.
// `practice_sessions.categoryId` is null for every kind but `category`
// (practice-sessions.md §2.1), so accepting the field and dropping it would
// hand a client a session that quietly ignored the only filter they asked for —
// five questions from the whole bank, presented as five questions from one
// section, with nothing in the response saying otherwise.
//
// `z.strictObject` for the same reason the civics query DTO uses one: an
// unknown key is a 400 naming it, so a client written against a misremembered
// contract fails loudly rather than practising something other than what it
// asked for.
//
// -----------------------------------------------------------------------------
// THERE IS NO USER ID FIELD, AND THERE NEVER WILL BE
// -----------------------------------------------------------------------------
//
// The learner is `@CurrentUser('id')` and nothing else. There is a compile-time
// proof at the bottom of this file, the same one
// `journey/dto/update-journey-profile.dto.ts` carries.
//
// There is no `testVersionCode` either, and that is the same rule wearing a
// different hat: which question bank a learner studies is resolved from THEIR
// OWN `learner_profiles` row, so a request cannot practise against a bank they
// are not sitting. A field here would be a client-supplied answer to a question
// only the server's data can answer honestly.
// =============================================================================

/** The default size of a "Quick 5" — the product's own name for the flow. */
export const DEFAULT_PLANNED_COUNT = 5;

/**
 * The most questions one session may plan.
 *
 * Not a database constraint and not a statement about how much a learner may
 * practise — they can start another session the moment this one completes.
 * It is a bound on ONE request, so that `plannedCount: 100000` is a 400 rather
 * than a selector query that scans the whole bank to build a session no learner
 * will finish. Twenty is comfortably above the twenty-question 2025 interview
 * and the ten-question 2008 one, which are the two real sizes this product
 * models.
 */
export const MAX_PLANNED_COUNT = 20;

export const createPracticeSessionSchema = z
  .strictObject({
    /**
     * The two kinds E3 wires. See this file's header on the other three.
     */
    kind: z.enum(['quick', 'category']),

    /**
     * The `civics_categories` row to draw from. Required for `category`,
     * rejected for `quick` — see the header.
     *
     * Validated against the learner's OWN test version in the service: a
     * category id belonging to a different bank is a 404, because from the
     * caller's position that category does not exist.
     */
    categoryId: z.uuid().optional(),

    /**
     * How many questions this session intends to ask.
     *
     * A request, not a guarantee. The service clamps it down to the number of
     * questions actually selectable for this learner — a category with three
     * unseen questions left cannot plan five — because `plannedCount` is what
     * the summary screen renders "4 of 5" from, and a planned count larger than
     * the bank could supply would render a session that can never be finished
     * as a session the learner failed to finish.
     */
    plannedCount: z
      .number()
      .int()
      .min(1)
      .max(MAX_PLANNED_COUNT)
      .default(DEFAULT_PLANNED_COUNT),
  })
  .superRefine((body, ctx) => {
    if (body.kind === 'category' && body.categoryId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message:
          'categoryId is required when kind is "category" — a category session has to name the section it draws from',
      });
    }

    if (body.kind !== 'category' && body.categoryId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryId'],
        message:
          'categoryId is only accepted when kind is "category" — a quick session draws across the whole test version',
      });
    }
  });

export type CreatePracticeSessionInput = z.infer<
  typeof createPracticeSessionSchema
>;

export class CreatePracticeSessionDto extends createZodDto(
  createPracticeSessionSchema,
) {}

// -----------------------------------------------------------------------------
// Compile-time proof that no caller-supplied identity or bank crept in
// -----------------------------------------------------------------------------
//
// If you are here because this line went red: you are adding a field that names
// a user or picks a question bank from the request. The caller is
// `@CurrentUser('id')`; the bank is that caller's own
// `learner_profiles.test_version_code`.

type ForbiddenCreateSessionFieldNames =
  | 'userId'
  | 'user_id'
  | 'id'
  | 'learnerId'
  | 'email'
  | 'testVersionCode'
  | 'stateCode'
  | 'status'
  | 'summary';

export type CreatePracticeSessionNamesNoUser = Extract<
  keyof CreatePracticeSessionInput,
  ForbiddenCreateSessionFieldNames
> extends never
  ? true
  : never;

export const CREATE_PRACTICE_SESSION_NAMES_NO_USER: CreatePracticeSessionNamesNoUser =
  true;
