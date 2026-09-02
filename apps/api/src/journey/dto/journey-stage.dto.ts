import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/journey/stages — response item (issue #65, epic #50)
// =============================================================================
//
// The wire form of one `JourneyStageDef`. This endpoint describes what stages
// EXIST; it says nothing about which one the caller is in — that is
// `GET /api/journey/profile`. journey-shell.md §6.1 keeps them apart for the
// reason `docs/specs/ai-settings.md` §5 keeps `userKeyConfigured` and
// `systemReady` apart: two different questions, two different audiences, two
// different cache lifetimes.
//
// The registry's "owning epic" column is NOT here. It is documentation for
// contributors about which epic implements a transition, not a fact a browser
// has any use for, and shipping it would turn an internal planning note into
// public API.
// =============================================================================

export const journeyStageSchema = z.object({
  /**
   * Stable identifier, and the value stored in `learner_profiles.stage`.
   * Renaming one is a migration — see `journey-stages.ts`.
   */
  key: z.string(),

  /** Short human label. */
  label: z.string(),

  /** One sentence on what this stage means, in the learner's terms. */
  description: z.string(),
});

export type JourneyStageResponse = z.infer<typeof journeyStageSchema>;

export class JourneyStageDto extends createZodDto(journeyStageSchema) {}
