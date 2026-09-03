import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ProgressService } from './progress.service';
import { ProgressMasteryDto, type ProgressMasteryResponse } from './dto/progress-mastery.dto';

// =============================================================================
// ProgressController (issue #86, epic #54 / E5 "Memory")
// =============================================================================
//
//   GET /api/progress/mastery   @Auth(), no permissions
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO NEW PERMISSION STRING
// -----------------------------------------------------------------------------
//
// The identical posture `PracticeController`, `CivicsController` and
// `JourneyController` already take, for the identical reason each states in
// its own header: every authenticated learner owns their own mastery data —
// gating this route would leave a Viewer, the default role every new account
// gets, unable to see their own progress. No route parameter carries a user
// id or a state code; `@CurrentUser('id')` is the only source of either, so
// there is no "read another learner's progress" permission to add in the
// first place.
// =============================================================================

@ApiTags('Progress')
@Controller('progress')
export class ProgressController {
  constructor(private readonly progressService: ProgressService) {}

  @Get('mastery')
  @Auth()
  @ApiOperation({
    summary: "The caller's coverage and mastery, by category",
    description:
      "Per-category coverage and mastery counts for the caller's own resolved test " +
      'version — the Progress page\'s data source (issue #94).\n\n' +
      '`byState` groups every question in the bank by the caller\'s own stored ' +
      '`question_mastery.state` (`new`, `learning`, `review`, `lapsed`, `mastered`); a ' +
      'question with no `question_mastery` row counts as `new`. `attempted` is ' +
      '`totalQuestions - byState.new`.\n\n' +
      'This is a read aggregate with no scheduling side effect of its own — it never ' +
      'calls the spaced-repetition scheduler and never writes. It answers a different ' +
      'question from `GET /api/practice/queue`\'s five flat bucket counts (due, weak, ' +
      'new, learning, mastered): that endpoint says what a session started right now ' +
      'would select next; this one says how much of the bank, and of each category, ' +
      'has actually been covered and verified.\n\n' +
      'Scoped to the caller\'s own resolved test version, read from their learner ' +
      'profile — never a query parameter, and never another learner\'s data.',
  })
  @ApiDataResponse(ProgressMasteryDto, {
    description: "Coverage and mastery, by category, for the caller's own test version",
  })
  @ApiResponse({
    status: 400,
    description: 'The caller has not finished orientation so no test version is resolved',
  })
  getMasteryProgress(
    @CurrentUser('id') userId: string,
  ): Promise<ProgressMasteryResponse> {
    return this.progressService.getMasteryProgress(userId);
  }
}
