import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/interviews — query parameters (issue #133, epic #57 / E8)
// =============================================================================
//
// `page` / `pageSize` copied field for field from
// `practice/dto/practice-session-query.dto.ts`, which copied them from
// `allowlist/dto/allowlist-query.dto.ts`, which is where this API's one list
// convention lives. `docs/specs/mock-interview.md` §12 asks for it by name:
// "the same `page`/`pageSize` query-parameter shape `allowlist.controller.ts`
// and `practice.controller.ts`'s session list already use, reused rather than a
// third pagination convention invented for this module".
//
// -----------------------------------------------------------------------------
// NO FILTERS, DELIBERATELY — AND ABSOLUTELY NO `userId`
// -----------------------------------------------------------------------------
//
// No `status`, no `passedCivics`, no date range. "My interviews, newest first"
// is the one question this endpoint exists to answer, and §12 states the
// concrete reason it exists at all: "did I do better on my second mock
// interview than my first" is a real question a learner will ask, and a debrief
// that existed only as a one-time response to the `complete` call that produced
// it could not answer it. That question needs a list and a detail route,
// nothing more.
//
// It is also the one query the shipped index serves —
// `@@index([userId, startedAt])` on `mock_interviews`, whose own schema comment
// says it "mirrors `PracticeSession`'s own `[userId, startedAt]` index exactly,
// same shape, same reason". A filter can be added the day a screen needs one,
// with the index question asked at the same time.
//
// The learner is `@CurrentUser('id')`. `z.strictObject` makes `?userId=…` a 400
// naming the parameter rather than something a future edit might start
// honouring.
// =============================================================================

export const interviewQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type InterviewQuery = z.infer<typeof interviewQuerySchema>;

export class InterviewQueryDto extends createZodDto(interviewQuerySchema) {}
