import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JourneyService } from './journey.service';
import { JOURNEY_STAGES } from './journey-stages';
import {
  JourneyProfileResponseDto,
  type JourneyProfileResponse,
} from './dto/journey-profile.dto';
import {
  JourneyHomeResponseDto,
  type JourneyHomeResponse,
} from './dto/journey-home.dto';
import {
  JourneyStageDto,
  type JourneyStageResponse,
} from './dto/journey-stage.dto';
import { UpdateJourneyProfileDto } from './dto/update-journey-profile.dto';

// =============================================================================
// JourneyController (issue #65, epic #50)
// =============================================================================
//
//   GET /api/journey/profile   @Auth(), no permissions
//   PUT /api/journey/profile   @Auth(), no permissions
//   GET /api/journey/home      @Auth(), no permissions
//   GET /api/journey/stages    @Auth(), no permissions
//
// -----------------------------------------------------------------------------
// NO ROUTE ACCEPTS A USER ID. THAT IS THE SECURITY BOUNDARY.
// -----------------------------------------------------------------------------
//
// `@CurrentUser('id')` is the ONLY source of a user id in this file. Not a
// path parameter, not a query parameter, not a body field — the request DTO
// carries a compile-time proof that no identity-shaped field crept into it.
//
// So there is no `GET /api/journey/profile?userId=…` to forget to authorise,
// and cross-user access is not "prevented" by a check that a refactor could
// relax: it is unreachable, because no input names another learner. Widening
// that is a signature change with a visible diff, not a query-string edit.
// This is the same structural argument `ai/ai-user-key.controller.ts` makes
// for BYOK keys and `notifications/notifications.controller.ts` makes for the
// notification centre; journey-shell.md §4.1 names it as the shape of answer
// this epic prefers wherever it is available.
//
// AN ADMIN CANNOT READ ANOTHER LEARNER'S PROFILE THROUGH THIS MODULE EITHER.
// Same property, same structure — not a permission check that could be
// loosened. `JourneyService` has no "find any learner's profile" method for a
// future controller to reach for.
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO NEW PERMISSION STRING
// -----------------------------------------------------------------------------
//
// Every authenticated user owns their own learner profile. Gating these would
// leave a Viewer — the DEFAULT role every new account gets — unable to
// complete orientation, and `RequireOrientation` hard-blocks an unoriented
// learner, so the gate would make the product unusable for the role it was
// meant to restrict. That is the same argument `ai/ai-user-key.controller.ts`
// and the user-settings controller both make.
//
// ROADMAP §7's permission set is closed and journey-shell.md §5 says plainly
// that this epic introduces nothing into it. It does not.
// =============================================================================

@ApiTags('Journey')
@Controller('journey')
export class JourneyController {
  constructor(private readonly journeyService: JourneyService) {}

  @Get('profile')
  @Auth()
  @ApiOperation({
    summary: "Get the caller's learner profile",
    description:
      'The caller\'s own profile, plus the two reference lists the orientation form ' +
      'needs: every civics test version, and the 56 US states and territories. They ' +
      'travel together because one form renders all three, and three round trips can ' +
      'disagree with each other.\n\n' +
      '**This GET creates a row on its first call for a user.** A learner who has never ' +
      'been here has no `learner_profiles` row, and returning 404 would make the first ' +
      'screen of a first login an error. The row is upserted at every column default — ' +
      '`stage: "uncertain"`, no state, no test version — which is exactly the profile ' +
      'orientation then fills in.\n\n' +
      'Scoped to the caller. There is no parameter that names a user.',
  })
  @ApiDataResponse(JourneyProfileResponseDto, {
    description: 'The caller’s profile and the orientation reference data',
  })
  getProfile(
    @CurrentUser('id') userId: string,
  ): Promise<JourneyProfileResponse> {
    return this.journeyService.getProfile(userId);
  }

  @Put('profile')
  @Auth()
  @ApiOperation({
    summary: "Update the caller's learner profile",
    description:
      'Both the orientation screen and the journey settings page write here.\n\n' +
      '**Every field is optional and an absent key leaves that field unchanged.** An ' +
      'explicit `null` on `interviewDate` clears it — that is the one field where null ' +
      'is meaningful, because a cancelled interview has to be removable.\n\n' +
      '**`filingDate` and `testVersionCode` are alternatives, and sending both is a 400.** ' +
      'When a filing date is given the SERVER resolves which civics test applies, against ' +
      'a cutoff the browser never learns.\n\n' +
      '**Orientation completion is inferred, not declared.** There is no ' +
      '`completeOrientation` flag to send: once the profile holds a test version, a state, ' +
      'a timezone, a daily goal and an explanation language, the server sets ' +
      '`orientationCompletedAt` and moves the stage from `uncertain` to `oriented`, once. ' +
      'A later save changes neither.\n\n' +
      'Scoped to the caller. There is no parameter or body field that names a user, and no ' +
      '`stage` field — the transition is a consequence, never a request.',
  })
  @ApiDataResponse(JourneyProfileResponseDto, {
    description: 'The updated profile, in the same shape as the GET',
  })
  @ApiResponse({
    status: 400,
    description:
      'Unknown state code, unknown test version, malformed timezone or language tag, ' +
      'a daily goal outside 1–480 minutes, or both `filingDate` and `testVersionCode`',
  })
  updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateJourneyProfileDto,
  ): Promise<JourneyProfileResponse> {
    return this.journeyService.updateProfile(userId, dto);
  }

  @Get('home')
  @Auth()
  @ApiOperation({
    summary: "The caller's home screen data",
    description:
      "Answers `VISION.md`'s first two home questions — *Where am I?* and *What should I " +
      'do next?* — from the server, so that no two screens can answer them differently.\n\n' +
      '`daysUntilInterview` is a count of whole **calendar** days in the learner’s own ' +
      'timezone, not an elapsed-milliseconds division, so it stays correct across a ' +
      'daylight-saving boundary. It is negative once the date has passed and null when no ' +
      'interview is booked.\n\n' +
      '`dailyGoal.tracked` is `false` for the whole of this release, and there is ' +
      'deliberately **no `minutesToday`**: nothing measures practice time yet, and a ' +
      'displayed `0` would be indistinguishable from a learner who genuinely did nothing ' +
      'today.\n\n' +
      '`nextAction` is produced by a pure function over the profile — no model call — so ' +
      'two consecutive loads give the same answer. Its `kind` is one of `orientation`, ' +
      '`interview_countdown`, `practice` or `explore`, and each maps to one fixed, real ' +
      'route — E3 (#52) added `practice` and re-pointed `interview_countdown` at ' +
      '`/practice` once the practice loop existed to send a learner to. A client MUST ' +
      'tolerate a `kind` it does not recognise rather than throwing: E5 and E8 add ' +
      '`review` and `interview` to this same union.',
  })
  @ApiDataResponse(JourneyHomeResponseDto, {
    description: 'Stage, countdown, goal placeholder and the next action',
  })
  getHome(@CurrentUser('id') userId: string): Promise<JourneyHomeResponse> {
    return this.journeyService.getHome(userId);
  }

  @Get('stages')
  @Auth()
  @ApiOperation({
    summary: 'List the journey stages',
    description:
      'The eight stages of the journey to readiness, in order, with the copy the UI ' +
      'renders. Readable by **any authenticated user** — every learner displays their own ' +
      'stage against it.\n\n' +
      'This describes what stages *exist*. Which one the caller is in comes from ' +
      '`GET /api/journey/profile`; the two are separate because they have different ' +
      'audiences and different cache lifetimes.',
  })
  @ApiDataResponse(JourneyStageDto, {
    isArray: true,
    description: 'The journey stage registry, in journey order',
  })
  listStages(): JourneyStageResponse[] {
    // Mapped field by field rather than returned directly, for the reason
    // `NotificationsController.listEvents` gives: the response shape is
    // decided here, in code that is about the response shape. A spread would
    // make it a consequence of whatever the registry happens to hold, so a
    // field added later for an internal consumer would silently become public
    // API. It also hands out copies rather than the registry's own frozen
    // objects.
    return JOURNEY_STAGES.map((stage) => ({
      key: stage.key,
      label: stage.label,
      description: stage.description,
    }));
  }
}
