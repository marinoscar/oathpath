import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/progress/mastery — response body (issue #86, epic #54 / E5 "Memory")
// =============================================================================
//
// Coverage and mastery, by category, for the Progress page (issue #94) to
// render — "how much of the bank have I touched, and how well do I know each
// section" — as opposed to `GET /api/practice/queue`'s five flat bucket
// counts, which answer "what should a session serve me right now". Both read
// the same `question_mastery` rows for the same caller; they differ in shape
// because they answer different questions, not because either duplicates the
// other (memory-model.md §8 vs §5).
//
// `byState`'s five keys mirror `mastery/scheduler.ts`'s own `MasteryState`
// union exactly, inline, the same convention every other state/outcome enum
// in this API already uses (`practice-session.dto.ts`'s `status`,
// `practice-attempt.dto.ts`'s `outcome`) rather than a shared exported array.
//
// `categoryName`, not the spec prose's own `name`: `mastery-model.md` §8's
// worked JSON uses `name`, but this endpoint's sibling, `GET
// /api/practice/queue`, already shipped `categoryId`/`categoryName` on its
// own `new.byCategory` rows (issue #78). Two endpoints reading the same
// `question_mastery` rows for the same caller should not invent two words for
// the same field, so this DTO follows the shipped precedent over the spec's
// prose example.
// =============================================================================

const masteryStateCountsSchema = z.object({
  new: z.number().int(),
  learning: z.number().int(),
  review: z.number().int(),
  lapsed: z.number().int(),
  mastered: z.number().int(),
});

const progressMasteryCategorySchema = z.object({
  categoryId: z.uuid(),
  categoryName: z.string(),

  /** How many of this category's questions exist in the caller's test version. */
  totalQuestions: z.number().int(),

  /** This category's questions, bucketed by the caller's own mastery state. */
  byState: masteryStateCountsSchema,

  /** Convenience duplicate of `byState.mastered` — the number the Progress page's per-category ring reads directly. */
  masteredCount: z.number().int(),
});

export const progressMasterySchema = z.object({
  /** Which bank this is scoped to — the caller's own resolved test version. */
  testVersionCode: z.string(),

  /** The whole bank's size for this test version. Unfiltered by `seniorEligible` — this is coverage of the full official bank, not of a session's own candidate pool. */
  totalQuestions: z.number().int(),

  /** `totalQuestions - byState.new` — how many questions have ever produced a schedulable outcome. */
  attempted: z.number().int(),

  /** Every question in the bank, bucketed by the caller's own mastery state. A question with no `question_mastery` row counts as `new`. */
  byState: masteryStateCountsSchema,

  /** One entry per category in the version, in the same render order `GET /api/civics/versions/{code}/categories` already uses. */
  categories: z.array(progressMasteryCategorySchema),
});

export type ProgressMasteryResponse = z.infer<typeof progressMasterySchema>;

export class ProgressMasteryDto extends createZodDto(progressMasterySchema) {}
