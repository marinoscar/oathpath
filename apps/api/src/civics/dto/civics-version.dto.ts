import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/civics/versions — response item (issue #111, epic #51)
// =============================================================================
//
// One `civics_test_versions` row. Its own call rather than a field folded into
// every question response, for the reason civics-content.md §8 gives: a version
// list changes far less often than a question list and has its own natural
// cache lifetime — the same "different audiences, different cache lifetimes"
// argument journey-shell.md §6.1 makes for keeping the stage registry and a
// learner's own stage apart.
//
// This is deliberately NOT the same DTO as `journey/dto/journey-profile.dto.ts`'s
// `civicsTestVersionSchema`, even though both describe the same table. That one
// carries `filedFrom`, derived from `test-version-resolution.ts`, because
// orientation needs to explain which test a FILING DATE selects. Nothing here
// is about filing dates, and `contentHash` — which orientation has no use for —
// is the whole point of this one.
// =============================================================================

export const civicsTestVersionSchema = z.object({
  /** `v2008` or `v2025`. The value `learner_profiles.test_version_code` holds. */
  code: z.string(),

  label: z.string(),

  /** How many questions this version's interview asks. */
  questionsAsked: z.number().int(),

  /** How many must be answered correctly to pass. */
  passThreshold: z.number().int(),

  /** The 65/20 accommodation's own figures — see `seniorEligible` on a question. */
  seniorQuestionsAsked: z.number().int(),
  seniorPassThreshold: z.number().int(),

  /**
   * sha256 over the content file the loader last applied, or null before any
   * content has been loaded for this version.
   *
   * Exposed on purpose (civics-content.md §7): it is how an admin, or an
   * automated check, confirms a deploy actually applied the content it shipped
   * — "does the live database match exactly this file in git". It is NOT the
   * hash of the official USCIS source document; that one lives in the content
   * file's own provenance block and answers the opposite question (§6).
   */
  contentHash: z.string().nullable(),
});

export type CivicsTestVersionResponse = z.infer<typeof civicsTestVersionSchema>;

export class CivicsTestVersionDto extends createZodDto(
  civicsTestVersionSchema,
) {}
