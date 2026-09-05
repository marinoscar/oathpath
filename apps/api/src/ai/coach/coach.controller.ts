import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../../auth/decorators/auth.decorator';
import {
  CoachPersonasResponseDto,
  type CoachPersonasResponse,
} from '../dto/coach-personas.dto';
import { AI_COACH_PERSONAS } from './personas';

// =============================================================================
// CoachController (issue #320, epic #305 "The Coach's personality")
// =============================================================================
//
//   GET /api/ai/coach/personas   @Auth(), no permissions
//
// The four voices a learner may ask their coach to speak in. One route, one
// read of a constant, no database and no provider call.
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS
// -----------------------------------------------------------------------------
//
// Every authenticated learner owns their own coach preference, exactly as they
// own their own voice preference (`/settings/voice`) and their own AI key, and
// no route here accepts a user id — there is no parameter naming anybody, so
// there is nothing for an ownership check to check.
//
// There is no "may choose a coach" privilege in this product's authorization
// model, and inventing one would leave a Viewer — the DEFAULT role, the one
// every learner gets on first login — unable to change how the application
// talks to them. That is the identical posture, for the identical reason, that
// `AiUserKeyController`, `AiSpeechController` and the per-user settings
// controller all take: gating a route every learner must use to use the
// product at all makes the product unusable for the role the gate was meant to
// restrict.
//
// This list is not sensitive in either direction. It is four labels and four
// sentences of product copy, identical for every caller on the deployment, and
// it reveals nothing about the administrator's AI configuration, the
// organisation's credential, or any other learner.
//
// -----------------------------------------------------------------------------
// A PROJECTION, NOT A SPREAD
// -----------------------------------------------------------------------------
//
// `AI_COACH_PERSONAS` entries carry FIVE fields and this route serves FOUR.
// `promptFragment` — the prose appended to a grader's or a tutor's system
// message — is server-side only, and the exclusion is written as an explicit
// object literal naming the four fields rather than as a `delete` or a
// spread-minus, so that a sixth field added to `CoachPersonaDef` next year is
// served by NOTHING until somebody writes it in here on purpose. A
// spread-minus-delete defaults the other way and would ship it the day it was
// added.
//
// The reaction bank (`reaction-lines.ts`) is not served either, and for a
// reason beyond size: `docs/specs/coach-personality.md` §7's determinism
// guarantee lives in `select-line.ts`, server-side, and a client holding the
// bank is a client that could pick its own line — reintroducing exactly the
// "two reactions to one event" defect that function exists to prevent.
//
// -----------------------------------------------------------------------------
// WHY IT IS ITS OWN CONTROLLER
// -----------------------------------------------------------------------------
//
// The same reason `AiUserKeyController` is separate from `AiSettingsController`
// (see that file's header): these routes are `@Auth()` with no permissions, and
// a route added to the wrong file is then a visibly wrong FILE rather than a
// missing decorator nobody notices. This one is narrower still — it reads no
// credential and injects no service at all.
// =============================================================================

@ApiTags('Coach')
@Controller('ai/coach')
export class CoachController {
  @Get('personas')
  @Auth()
  @ApiOperation({
    summary: 'The coach personas a learner can choose between',
    description:
      'The four voices `/settings/coach` renders as cards, in the order it renders them ' +
      '(`supportive`, the default, first).\n\n' +
      'Each entry carries the `key` to store in `coach.persona`, a `label`, a `description` ' +
      'of what choosing it changes, and one `sampleLine` in that voice so a learner can read ' +
      'what they are picking before they pick it.\n\n' +
      '**Four fields, never five.** The prompt fragment each persona appends to an AI ' +
      "system message is server-side only and is never returned, and neither is the curated " +
      'reaction bank — selection from it is deterministic and happens on the server, so the ' +
      'same attempt shows the same line live and on re-read.\n\n' +
      'No permission gates this: every authenticated learner chooses their own coach, and ' +
      'there is no parameter naming a user. The list is identical for every caller.',
  })
  @ApiResponse({
    status: 200,
    description: 'The available coach personas',
    type: CoachPersonasResponseDto,
  })
  getPersonas(): CoachPersonasResponse {
    return {
      // EXPLICIT, FIELD BY FIELD. See the header — this is the projection that
      // keeps `promptFragment` off the wire, and it is written so that adding a
      // field to the registry does not silently add it here.
      personas: AI_COACH_PERSONAS.map((persona) => ({
        key: persona.key,
        label: persona.label,
        description: persona.description,
        sampleLine: persona.sampleLine,
      })),
    };
  }
}
