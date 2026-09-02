import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/civics/versions/:code/categories — response item (#111, epic #51)
// =============================================================================
//
// One `civics_categories` row, served in `sortOrder` order.
//
// `testVersionCode` is not repeated on each item: the route already names the
// version, and every row in the response belongs to it by construction.
// =============================================================================

export const civicsCategorySchema = z.object({
  /** The FK target `civics_questions.category_id` holds, and the value the
   *  question list's `categoryId` filter takes. */
  id: z.uuid(),

  /**
   * The exam's top-level grouping, verbatim from USCIS — e.g.
   * `AMERICAN GOVERNMENT`. Free text, not an enum: presentation grouping copied
   * from the source, not a value this application branches on
   * (civics-content.md §2.1).
   */
  section: z.string(),

  /** A stable slug, e.g. `principles_of_american_democracy`. Unique per version. */
  code: z.string(),

  /** Display name, e.g. `Principles of American Democracy`. */
  name: z.string(),

  /**
   * Render order within the version.
   *
   * Served because the official categories are NOT alphabetical (Government
   * precedes History precedes Integrated Civics) and this column is the only
   * place that order is recorded. The rows arrive already sorted by it; it is
   * on the wire so a client that re-sorts locally can put them back.
   */
  sortOrder: z.number().int(),
});

export type CivicsCategoryResponse = z.infer<typeof civicsCategorySchema>;

export class CivicsCategoryDto extends createZodDto(civicsCategorySchema) {}
