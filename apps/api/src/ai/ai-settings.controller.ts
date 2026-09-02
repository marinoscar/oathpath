import { Body, Controller, Get, Headers, Put } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { AiSettingsService } from './ai-settings.service';
import { AiSettingsResponseDto } from './dto/ai-settings-response.dto';
import { UpdateAiSettingsDto } from './dto/update-ai-settings.dto';

// =============================================================================
// AiSettingsController (issue #30, epic #25)
// =============================================================================
//
// The HTTP surface behind `/admin/settings/ai`:
//
//   GET  /api/ai-settings          system_settings:read
//   PUT  /api/ai-settings          system_settings:write
//
// #31 adds `/models` and #32 adds `/test` to this same controller.
//
// `system_settings:*` RATHER THAN A NEW `ai_settings:*` PAIR, deliberately.
// The permission set is seeded (see prisma/seed.ts) and a new string means a
// migration plus a re-seed plus every existing Admin role being updated, for a
// page that is administering system configuration by any reading. This is the
// same conclusion `email-settings.controller.ts` reached, and the registry
// card (#33) mirrors the same strings.
//
// -----------------------------------------------------------------------------
// A SEPARATE CONTROLLER, NOT A ROUTE ON SystemSettingsController
// -----------------------------------------------------------------------------
//
// Same reasoning as the separate `system_settings` row (see
// ai-settings.schema.ts): the two surfaces write different rows and must not
// be able to clobber each other, and the model bindings stay out of
// `GET /api/system-settings`' response for free. It also keeps the OpenAPI tag
// — and therefore the API reference — split the way the settings pages are.
// =============================================================================

@ApiTags('AI Settings')
@Controller('ai-settings')
export class AiSettingsController {
  constructor(private readonly aiSettings: AiSettingsService) {}

  @Get()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'Get AI settings (Admin only)',
    description:
      'Returns the AI configuration together with `apiKeyStatus`, a masked, non-secret ' +
      'description of the stored server OpenAI key. **The key itself is never returned ' +
      'by this or any other endpoint** — it is held in the encrypted credential store ' +
      'and is unreadable through the API by design. Submitting the key field empty on ' +
      '`PUT` preserves the stored value.\n\n' +
      'This is the **server** key, used only to fetch the model catalog and to prove ' +
      'connectivity. Inference runs on each user’s own key — see `/api/ai/key`.',
  })
  @ApiResponse({
    status: 200,
    description: 'AI settings and stored-key status',
    type: AiSettingsResponseDto,
  })
  async getSettings() {
    return this.aiSettings.describeForAdmin();
  }

  @Put()
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @ApiOperation({
    summary: 'Replace AI settings (Admin only)',
    description:
      'Replaces the AI configuration. `apiKey` is **write-only**: send it to set or ' +
      'rotate the server key, and **omit it or send it empty to keep the stored one**. ' +
      'There is no way to erase a stored key through this endpoint.\n\n' +
      'Selecting a provider while no key is stored and none is submitted is rejected ' +
      'with a 409, rather than saving a configuration that cannot do anything.',
  })
  @ApiHeader({
    name: 'If-Match',
    description:
      'Expected `version` for optimistic concurrency. Use `0` to assert that nothing ' +
      'is stored yet. Omit to overwrite unconditionally.',
    required: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Updated AI settings',
    type: AiSettingsResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({
    status: 409,
    description: 'Version conflict, or a provider selected with no key stored',
  })
  async replaceSettings(
    @Body() dto: UpdateAiSettingsDto,
    @CurrentUser('id') userId: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    // `Number.isInteger` rather than a bare `parseInt`: `parseInt('abc')` is
    // NaN, and `NaN !== currentVersion` is always true, so a malformed header
    // would turn every save into a 409 that no amount of reloading fixes. An
    // unparseable If-Match is treated as absent instead, matching the header's
    // own "omit to overwrite unconditionally" semantics.
    const parsed = ifMatch !== undefined ? Number.parseInt(ifMatch, 10) : NaN;
    const expectedVersion = Number.isInteger(parsed) ? parsed : undefined;

    return this.aiSettings.update(dto, userId, expectedVersion);
  }
}
