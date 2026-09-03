import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ReadinessService } from './readiness.service';
import { ReadinessSnapshotDto, type ReadinessSnapshotResponse } from './dto/readiness-snapshot.dto';
import { ReadinessHistoryQueryDto } from './dto/readiness-history-query.dto';

// =============================================================================
// ReadinessController (issue #122, epic #55 / E6 "Readiness and Progress")
// =============================================================================
//
//   GET /api/readiness           @Auth(), no permissions
//   GET /api/readiness/history   @Auth(), no permissions
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO NEW PERMISSION STRING
// -----------------------------------------------------------------------------
//
// The same posture `JourneyController`, `PracticeController` and
// `ProgressController` already take, cited by `CLAUDE.md`'s own name for it
// rather than re-derived: "Journey/Practice/Progress add no permission
// strings, for the same reason" — every authenticated learner owns their
// own readiness data exactly as they own their own learner profile, their
// own practice attempts, and their own mastery rows. No route here accepts
// another user's id, ever — `@CurrentUser('id')` is the only source of one.
// =============================================================================

@ApiTags('Readiness')
@Controller('readiness')
export class ReadinessController {
  constructor(private readonly readinessService: ReadinessService) {}

  @Get()
  @Auth()
  @ApiOperation({
    summary: "The caller's latest readiness snapshot",
    description:
      'The caller\'s most recent `readiness_snapshots` row — lazily computed and persisted ' +
      'if none exists yet, or if the latest one is **stale**: an existing snapshot older than ' +
      'the caller\'s most recent `practice_attempts.answeredAt` (`docs/specs/readiness-model.md` ' +
      '§6). A snapshot the nightly cron just produced is never stale by this rule.\n\n' +
      '`score` is 0-100. `capReason` is `"typed_only"` while there is no spoken-answer or ' +
      'mock-interview evidence yet, or `null` once either exists at all — a distinct, binary ' +
      'signal from `score` itself, which keeps climbing gradually as more evidence arrives.\n\n' +
      '`topRecommendation` is always present: the fixed cap message while capped, otherwise the ' +
      'earnable component with the greatest weighted headroom.\n\n' +
      '`narrative`/`narrativeGeneratedAt` are `null` until issue #134 wires narrative ' +
      'generation — expected, and correct, until then.\n\n' +
      'Scoped to the caller. There is no parameter or query field that names a user.',
  })
  @ApiDataResponse(ReadinessSnapshotDto, {
    description: "The caller's latest (possibly freshly computed) readiness snapshot",
  })
  getReadiness(@CurrentUser('id') userId: string): Promise<ReadinessSnapshotResponse> {
    return this.readinessService.getLatestOrRecompute(userId);
  }

  @Get('history')
  @Auth()
  @ApiOperation({
    summary: "The caller's readiness snapshot history",
    description:
      'The caller\'s own past snapshots, **newest first**, paginated with the same ' +
      '`page`/`pageSize` shape every other list in this API uses — the trend line\'s data ' +
      'source (`docs/specs/readiness-model.md` §4, §12).\n\n' +
      'Every field on a history row is exactly what `GET /api/readiness` returns for the ' +
      'latest one, frozen as it stood the day it was computed — a `question_mastery` row this ' +
      'snapshot summarized can be rescheduled or re-promoted since, and this row still means ' +
      'exactly what it meant on the day it was written.\n\n' +
      'Scoped to the caller. An unknown query parameter — `?userId=` included — is a 400.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiDataResponse(ReadinessSnapshotDto, {
    pagination: 'flat',
    description: "A page of the caller's readiness snapshots, newest first",
  })
  @ApiResponse({ status: 400, description: 'An unknown query parameter was supplied' })
  getHistory(
    @CurrentUser('id') userId: string,
    @Query() query: ReadinessHistoryQueryDto,
  ) {
    return this.readinessService.getHistory(userId, query);
  }
}
