import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/readiness/history — query parameters (issue #122, epic #55 / E6)
// =============================================================================
//
// `page`/`pageSize` copied field for field from
// `practice/dto/practice-session-query.dto.ts` — the `page`/`pageSize`
// query-parameter shape `AllowlistController` established first and this
// API has already standardized on, rather than a second (or third)
// pagination input shape for one more newest-first list.
//
// No filters, and no `userId` — `z.strictObject` makes `?userId=…` a 400
// naming the parameter rather than something a future edit might start
// honouring, the identical structural guarantee
// `practiceSessionQuerySchema` documents.
// =============================================================================

export const readinessHistoryQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ReadinessHistoryQuery = z.infer<typeof readinessHistoryQuerySchema>;

export class ReadinessHistoryQueryDto extends createZodDto(readinessHistoryQuerySchema) {}
