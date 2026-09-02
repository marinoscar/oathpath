import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CivicsService } from './civics.service';
import {
  CivicsTestVersionDto,
  type CivicsTestVersionResponse,
} from './dto/civics-version.dto';
import {
  CivicsCategoryDto,
  type CivicsCategoryResponse,
} from './dto/civics-category.dto';
import { CivicsQuestionQueryDto } from './dto/civics-question-query.dto';
import {
  CivicsQuestionDetailDto,
  CivicsQuestionSummaryDto,
  type CivicsQuestionDetail,
} from './dto/civics-question.dto';

// =============================================================================
// CivicsController (issue #111, epic #51)
// =============================================================================
//
//   GET /api/civics/versions                    @Auth(), no permissions
//   GET /api/civics/versions/:code/categories   @Auth(), no permissions
//   GET /api/civics/questions                   @Auth(), no permissions
//   GET /api/civics/questions/:id               @Auth(), no permissions
//
// -----------------------------------------------------------------------------
// NO ROUTE ACCEPTS A USER ID OR A STATE. THAT IS THE SECURITY BOUNDARY.
// -----------------------------------------------------------------------------
//
// `@CurrentUser('id')` is the ONLY source of a user id in this file, and the
// caller's `state_code` is read from that user's own `learner_profiles` row —
// never from a path parameter, a query parameter, or a header. The query DTO is
// a `z.strictObject`, so `?stateCode=TX` is a 400 rather than a parameter
// something might one day start honouring.
//
// So there is no `GET /api/civics/questions/:id?stateCode=…` to forget to
// authorise, and "resolve this question as if I lived somewhere else" is not
// prevented by a check a refactor could relax — it is unreachable, because no
// input names a state or another learner. This is the identical structural rule
// `journey.controller.ts` states for its own routes, and civics-content.md §8
// requires it here.
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS, AND NO NEW PERMISSION STRING
// -----------------------------------------------------------------------------
//
// Civics content is the core product material every authenticated learner
// reads. Gating it would leave a Viewer — the DEFAULT role every new account
// gets — unable to study, which is the entire product. That is the same
// argument `journey.controller.ts` and `ai/ai-user-key.controller.ts` both
// make, and civics-content.md §8 makes it for these four routes by name: the
// closed permission set (ROADMAP §7) gains nothing from gating a read of public
// exam content.
//
// The ADMIN dynamic-answer surface is a different matter — it reuses
// `system_settings:read`/`:write` (§9) — but that is issue #117, not this one.
// Nothing here writes.
// =============================================================================

@ApiTags('Civics')
@Controller('civics')
export class CivicsController {
  constructor(private readonly civicsService: CivicsService) {}

  @Get('versions')
  @Auth()
  @ApiOperation({
    summary: 'List the civics test versions',
    description:
      'Every `civics_test_versions` row: the two official question banks and the shape ' +
      'of each interview — how many questions are asked and how many must be right, ' +
      'both for the ordinary case and for the 65/20 senior accommodation.\n\n' +
      '`contentHash` is a sha256 over the content file the loader last applied, or null ' +
      'before any content has been loaded. It answers "does the live database match ' +
      'exactly the content file in git" — it is **not** a hash of the official USCIS ' +
      'source document.\n\n' +
      'Its own call rather than a field on every question, because a version list ' +
      'changes far less often than a question list and has its own cache lifetime.',
  })
  @ApiDataResponse(CivicsTestVersionDto, {
    isArray: true,
    description: 'Every civics test version, in code order',
  })
  listVersions(): Promise<CivicsTestVersionResponse[]> {
    return this.civicsService.listVersions();
  }

  @Get('versions/:code/categories')
  @Auth()
  @ApiOperation({
    summary: "List a version's categories",
    description:
      "The version's categories in `sortOrder` — the order the official material uses, " +
      'which is not alphabetical (Government precedes History precedes Integrated ' +
      'Civics).\n\n' +
      'An unknown version code is a **404**, not an empty list: "this version does not ' +
      'exist" and "this version has no categories loaded yet" are different facts, and ' +
      'collapsing them would make a client-side typo indistinguishable from content that ' +
      'has not been seeded.',
  })
  @ApiParam({
    name: 'code',
    type: String,
    description: 'A test version code, e.g. `v2008` or `v2025`.',
  })
  @ApiDataResponse(CivicsCategoryDto, {
    isArray: true,
    description: 'The version’s categories, in render order',
  })
  @ApiResponse({ status: 404, description: 'Unknown test version code' })
  listCategories(
    @Param('code') code: string,
  ): Promise<CivicsCategoryResponse[]> {
    return this.civicsService.listCategories(code);
  }

  @Get('questions')
  @Auth()
  @ApiOperation({
    summary: 'List civics questions',
    description:
      'Paginated question summaries — `number`, `prompt`, `categoryId`, `seniorEligible` ' +
      'and `dynamicScope`. **No answers**: those are resolved per caller and belong on ' +
      'the detail route.\n\n' +
      '**`testVersionCode` defaults to the caller\'s own resolved test version.** ' +
      'Omitting it does not mean "every version" — a learner studying the 2025 test has ' +
      'no use for the 2008 bank. Only a caller who has not finished orientation, and so ' +
      'has no resolved version, sees the whole bank.\n\n' +
      '`seniorEligible` is an explicit filter with no implicit default: a learner ' +
      'claiming the 65/20 accommodation is still entitled to browse the full bank.\n\n' +
      'There is no `userId` and no `stateCode` parameter, and an unknown query parameter ' +
      'is a 400 rather than a silently ignored one.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'testVersionCode', required: false, type: String })
  @ApiQuery({ name: 'categoryId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'seniorEligible', required: false, type: Boolean })
  @ApiDataResponse(CivicsQuestionSummaryDto, {
    pagination: 'flat',
    description: 'A page of question summaries',
  })
  listQuestions(
    @CurrentUser('id') userId: string,
    @Query() query: CivicsQuestionQueryDto,
  ) {
    return this.civicsService.listQuestions(userId, query);
  }

  @Get('questions/:id')
  @Auth()
  @ApiOperation({
    summary: 'Get one question, with its answers resolved for the caller',
    description:
      "One question plus its category and the answers that are correct **now**, for " +
      '**this caller**.\n\n' +
      'Only current answers are ever returned: a superseded answer is closed rather than ' +
      'deleted, so that a past practice attempt stays explicable, and it is unreachable ' +
      'through this API.\n\n' +
      'How `answers` is populated depends on the question\'s `dynamicScope`:\n\n' +
      '- `none` — every simultaneously correct alternative, in slot order. "Name one ' +
      'branch of the government" returns three.\n' +
      '- `national` — the single current answer. "Who is the President" returns one.\n' +
      '- `state` — the single current answer for the caller\'s own state, read from ' +
      'their learner profile.\n\n' +
      '**`answerResolution: "state_required"` is the case a client must handle.** A ' +
      '`state`-scope question asked by a learner with no state set returns the question ' +
      'with `answers: []` and `verifiedAt: null` — never a 404, never another state\'s ' +
      'answer, never a guess. Render a prompt to set their state.\n\n' +
      '`verifiedAt` is the most recent human verification across the resolved answers — ' +
      'what "current as of …" renders from.\n\n' +
      'There is no `stateCode` parameter. The state comes from the caller\'s profile ' +
      'and nowhere else.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiDataResponse(CivicsQuestionDetailDto, {
    description: 'The question, its category, and the answers resolved for the caller',
  })
  @ApiResponse({ status: 404, description: 'Unknown question id' })
  getQuestion(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CivicsQuestionDetail> {
    return this.civicsService.getQuestion(userId, id);
  }
}
