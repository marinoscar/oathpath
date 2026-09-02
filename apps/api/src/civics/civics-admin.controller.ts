import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiDataResponse } from '../common/decorators/api-data-response.decorator';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { CivicsAdminService } from './civics-admin.service';
import { CivicsDynamicAnswerQueryDto } from './dto/civics-dynamic-answer-query.dto';
import {
  CivicsDynamicAnswerItemDto,
  CivicsDynamicAnswerUpdateResultDto,
  type CivicsDynamicAnswerUpdateResult,
} from './dto/civics-dynamic-answer.dto';
import { UpdateCivicsDynamicAnswerDto } from './dto/update-civics-dynamic-answer.dto';

// =============================================================================
// CivicsAdminController (issue #117, epic #51)
// =============================================================================
//
//   GET /api/civics/dynamic-answers    system_settings:read
//   PUT /api/civics/dynamic-answers    system_settings:write
//
// -----------------------------------------------------------------------------
// `system_settings:*` — REUSED, NEVER INVENTED
// -----------------------------------------------------------------------------
//
// This is `email-settings.controller.ts`'s reasoning applied unchanged, and
// civics-content.md §9 states it for these two routes by name. A new
// `civics:read` / `civics:write` pair would cost a seed change, a re-seed, and
// every existing Admin role being updated — for a page that is administering
// system configuration by any reasonable reading. `roles.constants.ts` is a
// CLOSED set and this issue adds nothing to it.
//
// The read/write SPLIT is kept, also mirroring `EmailSettingsController`:
// looking at who the current Speaker of the House is recorded to be is not the
// same privilege as changing it.
//
// -----------------------------------------------------------------------------
// A SEPARATE CONTROLLER FROM `CivicsController`, ON PURPOSE
// -----------------------------------------------------------------------------
//
// `CivicsController`'s four routes are `@Auth()` with NO permission, because
// civics content is what every learner studies (§8). These two are gated. Two
// opposite postures in one file is how a route ends up with the wrong one
// after a refactor that moved a decorator, and the OpenAPI tag split keeps the
// API reference sectioned the way the product is — the same reason
// `EmailSettingsController` is not a method on `SystemSettingsController`.
//
// -----------------------------------------------------------------------------
// THE WRITE IS `PUT`, AND IT IS NOT AN UPDATE
// -----------------------------------------------------------------------------
//
// `PUT` because the request declares what the answer for a slot IS, and
// resubmitting the same body converges on the same served answer. What happens
// underneath is civics-content.md §4's close-then-open transaction, never an
// edit: there is no route here that takes an answer id, because an answer row
// a learner may already have been graded against is not editable by anybody,
// through any surface. See `CivicsAdminService` for why.
//
// This surface deliberately CANNOT change a question's prompt, its category,
// its `dynamicScope`, or any `none`-scope answer. Those are content, changed
// by a reviewed PR and a reseed (§6-§7).
// =============================================================================

@ApiTags('Civics Admin')
@Controller('civics/dynamic-answers')
export class CivicsAdminController {
  constructor(private readonly civicsAdmin: CivicsAdminService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List the dynamic civics answers (Admin only)',
    description:
      'Every `national`- and `state`-scope question with the answer that is currently **open** ' +
      'for it — the row a correction would close. `none`-scope questions are not listed and are ' +
      'not addressable through this surface at all: a static answer changes through a reviewed ' +
      'content change, not a runtime edit.\n\n' +
      '**The page is over questions, not answer rows.** A `state`-scope question carries up to ' +
      '56 answers, one per state and territory, and they are one editable unit. `total` counts ' +
      'questions.\n\n' +
      '**`missingStateCodes` is the gap list.** A `state`-scope question with no open answer for ' +
      'a given state names it here — that state\'s learners currently have an unanswerable ' +
      'question, and this is where that becomes visible.\n\n' +
      '**Open is not the same as what a learner is served right now.** A correction entered ' +
      'ahead of time opens a row whose `effectiveFrom` is in the future, while the row it closed ' +
      'stays correct until then; both dates are returned so that state of affairs is legible.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'testVersionCode', required: false, type: String })
  @ApiQuery({
    name: 'dynamicScope',
    required: false,
    enum: ['national', 'state'],
  })
  @ApiQuery({ name: 'stateCode', required: false, type: String })
  @ApiDataResponse(CivicsDynamicAnswerItemDto, {
    pagination: 'flat',
    description: 'A page of dynamic questions with their open answers',
  })
  listDynamicAnswers(@Query() query: CivicsDynamicAnswerQueryDto) {
    return this.civicsAdmin.listDynamicAnswers(query);
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Correct a dynamic civics answer (Admin only)',
    description:
      'Records a new answer for one slot — one question, and for a `state`-scope question one ' +
      'state. The currently open row is **closed** (its `effective_to` set to this correction\'s ' +
      '`effectiveFrom`) and a **new** row is opened, both in a single transaction. Nothing is ' +
      'edited in place and nothing is deleted: the superseded row stays readable, so an answer a ' +
      'learner was graded against last month can still be explained.\n\n' +
      '`sourceNote` is **required** — the citation the new text and its date come from. ' +
      '`verifiedAt` is stamped by the server at write time: it records that a human confirmed ' +
      'this text, and the human is the caller.\n\n' +
      '`effectiveFrom` should be the real-world date of the change, from the same citation ' +
      '(`2027-01-03` or a full ISO timestamp). Omitted, the server clock stands in — the honest ' +
      'value when no precise date is knowable, such as correcting a transcription mistake that ' +
      'was never true.\n\n' +
      '**A `none`-scope question is a 400.** So is a `stateCode` on a `national` question, and a ' +
      'missing one on a `state` question.\n\n' +
      'Every accepted correction writes a `civics:dynamic_answer_update` audit row carrying the ' +
      'old and new text in full — a civics answer is public exam content, so the diff itself is ' +
      'what an auditor needs.',
  })
  @ApiDataResponse(CivicsDynamicAnswerUpdateResultDto, {
    description: 'The closed row and the newly opened one',
  })
  @ApiResponse({
    status: 400,
    description:
      'A `none`-scope question, a state mismatch, a missing `sourceNote`, or an `effectiveFrom` ' +
      'earlier than the answer being replaced',
  })
  @ApiResponse({ status: 404, description: 'Unknown question id' })
  updateDynamicAnswer(
    @CurrentUser('id') userId: string,
    @Body() body: UpdateCivicsDynamicAnswerDto,
  ): Promise<CivicsDynamicAnswerUpdateResult> {
    return this.civicsAdmin.updateDynamicAnswer(userId, body);
  }
}
