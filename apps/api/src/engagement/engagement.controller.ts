import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { EngagementService } from './engagement.service';
import {
  EngagementSummaryDto,
  type EngagementSummaryResponse,
} from './dto/engagement-summary.dto';

// =============================================================================
// EngagementController (issue #119, epic #56 / E7 "Habit")
// =============================================================================
//
//   GET /api/engagement/summary   @Auth(), no permissions
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO NEW PERMISSION STRING
// -----------------------------------------------------------------------------
//
// The identical posture `JourneyController`, `PracticeController`,
// `ProgressController` and `ReadinessController` already take, for the reason
// each states in its own header and `docs/specs/habit-streaks.md` §4.6 states
// again: every authenticated learner owns their own engagement data, exactly
// as they own their own learner profile, their own practice attempts and their
// own readiness snapshots. Gating this route would leave a Viewer — the
// default role every new account gets — unable to see their own streak. No
// route parameter, and no query field, carries a user id; `@CurrentUser('id')`
// is the only source of one, so there is no "read another learner's streak"
// permission to add in the first place.
// =============================================================================

@ApiTags('Engagement')
@Controller('engagement')
export class EngagementController {
  constructor(private readonly engagementService: EngagementService) {}

  @Get('summary')
  @Auth()
  @ApiOperation({
    summary: "The caller's daily goal, streak and freeze budget",
    description:
      'Everything the goal ring, the streak badge and the session-end celebration render ' +
      '(`docs/specs/habit-streaks.md` §4.6) — the measured value `journey-shell.md` §10\'s ' +
      "honest placeholder was always waiting for.\n\n" +
      '`today` is always present: a learner with no `daily_activity` row yet gets honest ' +
      'zeros and `goalMet: false`, never a null a client would have to branch on. ' +
      '`goalMet` is **monotonic** — a day that was earned stays earned, including after ' +
      'the learner raises their daily goal (§2.3).\n\n' +
      '`streak.current` counts consecutive qualifying local days ending **today or ' +
      'yesterday** (§4.1), so a learner who always practises in the evening is never shown ' +
      '`0` at 2pm on a day they fully intend to finish. A day qualifies when the goal was ' +
      'met **or** a freeze covered it. `streak.longest` is the longest such run anywhere in ' +
      'their history.\n\n' +
      'Settlement runs once, at the top of this request (§4.6): the freeze budget is ' +
      'replenished at most once per 7 days up to a ceiling of 2, and a missed day inside an ' +
      'existing streak is covered by writing a real `daily_activity` row with ' +
      '`freezeUsed: true` — bounded to 7 days back, so a learner returning after a month ' +
      'away does not get a month of retroactive protection. A read path that persists what ' +
      'it computes, exactly as `GET /api/readiness` already does.\n\n' +
      'Every `date` is a LOCAL calendar day in the caller\'s own `timezone`, never an ' +
      'instant (§3).\n\n' +
      'This is a **consistency** surface, not a readiness one: `daily_activity`, streaks ' +
      'and freezes are structurally not inputs to the readiness engine (§1), and nothing ' +
      'here carries a score.\n\n' +
      'Scoped to the caller. There is no parameter or query field that names a user.',
  })
  @ApiDataResponse(EngagementSummaryDto, {
    description: "The caller's engagement summary, after this request's settlement",
  })
  getSummary(@CurrentUser('id') userId: string): Promise<EngagementSummaryResponse> {
    return this.engagementService.getSummary(userId);
  }
}
