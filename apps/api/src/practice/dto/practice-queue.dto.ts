import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/practice/queue — response body (issue #78, epic #54 / E5 "Memory")
// =============================================================================
//
// What the Practice page's picker needs to render its counts — "12 due", "8
// new", and so on — without re-deriving `mastery/selector.ts`'s own bucket
// rule client-side. Every count here comes from `classifyMasteryBucket`, the
// SAME function `PracticeService`'s selector uses to order a session's
// questions, so this endpoint can never disagree with what a session started
// right now would actually select.
//
// Flat and un-paginated on purpose: this is a handful of integers, not a
// list, so there is no `items`/`total`/`page` envelope to get wrong — just
// `{ data: { ... } }` from the global interceptor.
// =============================================================================

export const practiceQueueCategoryCountSchema = z.object({
  categoryId: z.uuid(),
  categoryName: z.string(),

  /** New (never-attempted, or `state: 'new'`) questions in this category. */
  newCount: z.number().int(),
});

export const practiceQueueSchema = z.object({
  /** Which bank these counts are drawn from — the caller's own resolved test version. */
  testVersionCode: z.string(),

  /** The whole bank's size for this test version (scoped to `seniorEligible` under the 65/20 exemption, exactly as session selection is). */
  total: z.number().int(),

  /**
   * Due right now: `state IN (review, lapsed)` with `dueAt <= now`. The
   * count a "Review" call-to-action badges.
   */
  due: z.number().int(),

  /**
   * Struggling: `state = lapsed` (any `dueAt`) or a `learning`/`review`
   * question meeting {@link WEAK_LAPSES_THRESHOLD}'s predicate — the same
   * WEAK bucket `mastery/selector.ts` orders second.
   */
  weak: z.number().int(),

  /** Never attempted, or `state: 'new'` — broken down by category so the picker can show where coverage is thinnest. */
  new: z.object({
    total: z.number().int(),
    byCategory: z.array(practiceQueueCategoryCountSchema),
  }),

  /**
   * Ordinary in-progress questions — attempted, not due, not struggling, not
   * yet mastered. `mastery/selector.ts`'s STEADY bucket.
   */
  learning: z.number().int(),

  /** `state: 'mastered'` — the pool `mastery/selector.ts` samples from once everything else is exhausted. */
  mastered: z.number().int(),
});

export type PracticeQueueResponse = z.infer<typeof practiceQueueSchema>;

export class PracticeQueueDto extends createZodDto(practiceQueueSchema) {}
