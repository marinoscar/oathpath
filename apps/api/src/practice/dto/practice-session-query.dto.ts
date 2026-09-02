import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/practice/sessions — query parameters (issue #73, epic #52)
// =============================================================================
//
// `page` / `pageSize` copied field for field from
// `allowlist/dto/allowlist-query.dto.ts`, including the 1-100 bound and the
// default of 20 — the same copy `civics/dto/civics-question-query.dto.ts`
// already made, for the same stated reason. practice-sessions.md §10 requires
// it by name: "the `page`/`pageSize` query-parameter shape `AllowlistController`
// already establishes rather than a second pagination convention". This API
// already carries two list-BODY shapes (`common/decorators/
// api-data-response.decorator.ts` on `flat` vs `nested`), which is one more
// than it should have; a third pagination INPUT shape on top of that is not a
// cost worth paying for a recent-sessions list.
//
// -----------------------------------------------------------------------------
// NO FILTERS, DELIBERATELY — AND ABSOLUTELY NO `userId`
// -----------------------------------------------------------------------------
//
// No `status`, no `kind`, no date range. "Recent sessions, newest first" is the
// one question this endpoint exists to answer, and it is the one query the
// shipped index (`@@index([userId, startedAt])`, practice-sessions.md §2.1)
// serves. A `status` filter in particular would look free and is not: it would
// invite a client to ask "do I have an open session" through this list, when
// the create-session flow already answers that authoritatively by closing any
// open session as it opens the new one (§5). A filter can be added the day a
// screen needs one, with the index question asked at the same time.
//
// The learner is `@CurrentUser('id')`. `z.strictObject` makes `?userId=…` a 400
// naming the parameter rather than something a future edit might start
// honouring — the same structural guarantee the civics query DTO documents.
// =============================================================================

export const practiceSessionQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PracticeSessionQuery = z.infer<typeof practiceSessionQuerySchema>;

export class PracticeSessionQueryDto extends createZodDto(
  practiceSessionQuerySchema,
) {}
