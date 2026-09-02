import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { AiSettingsService } from './ai-settings.service';
import { AiConnectionTestService } from './ai-connection-test.service';
import { AiTestResultDto } from './dto/ai-test-result.dto';
import { OpenAiProvider } from './providers/openai.provider';
import type { AiCapabilityFamily } from './ai-model-roles';
import { AI_CAPABILITY_FAMILIES, capabilityForRole } from './ai-model-roles';
import { AiModelCatalogResponseDto } from './dto/ai-model-catalog.dto';
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
//   GET  /api/ai-settings/models   system_settings:read
//   POST /api/ai-settings/test     system_settings:WRITE
//
// The TEST endpoint is gated on WRITE, not read. It is a side-effecting
// operation that causes the system to originate an outbound request on the
// organisation's credential; `:read` is held by anyone who may look at
// settings, and looking is not calling.
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
  constructor(
    private readonly aiSettings: AiSettingsService,
    // The one concrete provider. Injected here rather than resolved inside the
    // service because `AiSettingsService` must not depend on a provider — see
    // `AiModule`'s constructor for why that cycle is a boot failure. The
    // controller is a leaf and can hold both.
    //
    // A SECOND PROVIDER WOULD BE A MAP HERE, keyed by `AI_PROVIDER_KINDS`, in
    // the shape `EmailTestSendService` already uses — a `Record` rather than a
    // `switch`, so adding a kind fails to compile until it is wired.
    private readonly openai: OpenAiProvider,
    private readonly connectionTest: AiConnectionTestService,
  ) {}

  /**
   * The provider matching the stored configuration, or `null` when none is
   * selected.
   *
   * One provider today, so this is a single comparison. It exists as a method
   * rather than inline so the second provider is one edit here rather than a
   * grep across route handlers.
   */
  private async selectedProvider() {
    const settings = await this.aiSettings
      .get()
      // A corrupt row is not a reason to fail the catalog endpoint: the admin
      // page is where a corrupt row gets repaired. `describeForAdmin` reports
      // the problem alongside.
      .catch(() => null);

    return settings?.provider === 'openai' ? this.openai : null;
  }

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

  @Get('models')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List bindable models and the model roles (Admin only)',
    description:
      'Returns the provider’s model catalog, classified by capability family and filtered ' +
      'for binding, together with the **model-role registry** the admin page renders one ' +
      'select per.\n\n' +
      'The catalog is fetched server-side on the stored server key — the browser cannot ' +
      'hold that key, and no part of it appears in this response.\n\n' +
      '**The generation floor applies to the text families only.** Transcription, TTS and ' +
      'embedding models use entirely different naming, so a numeric floor would empty those ' +
      'lists rather than filter them. A model whose generation cannot be parsed is not ' +
      'dropped — it appears under `showAll`.\n\n' +
      '`notConfigured: true` means no server key is stored, which is the state of every ' +
      'fresh install and **not** an error. A provider refusal arrives in `error`, verbatim ' +
      'and redacted, with HTTP 200 — the roles are still returned so the page can render.',
  })
  @ApiQuery({
    name: 'showAll',
    required: false,
    description:
      'Escape hatch. `true` disables the generation floor and includes every family, ' +
      'including model ids this application does not recognise. It exists because model ' +
      'naming is not ours to control: a filter that cannot be switched off eventually ' +
      'locks an admin out of selecting a model that exists.',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    description:
      'Restrict the catalog to the capability family this role needs, for a single ' +
      'select. Unknown roles are ignored rather than rejected.',
  })
  @ApiQuery({
    name: 'family',
    required: false,
    description:
      'Restrict the catalog to one capability family directly. `role` takes precedence.',
  })
  @ApiResponse({
    status: 200,
    description: 'The filtered catalog and the model-role registry',
    type: AiModelCatalogResponseDto,
  })
  async listModels(
    @Query('showAll') showAll?: string,
    @Query('role') role?: string,
    @Query('family') family?: string,
  ) {
    return this.aiSettings.describeCatalog(await this.selectedProvider(), {
      // `role` first: it is what the page actually has, and resolving it here
      // means the web never has to know the role -> family mapping. An unknown
      // role yields `undefined`, i.e. "every family", rather than a 400 — a
      // stale client asking about a removed role should see a full list, not
      // an error page.
      family: resolveFamily(role, family),
      // Only the literal string 'true' engages it. A bare `Boolean(showAll)`
      // would make `?showAll=false` engage the hatch, which is the opposite of
      // what it says.
      showAll: showAll === 'true',
    });
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

  @Post('test')
  @Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test the saved AI configuration (Admin only)',
    description:
      'Authenticates the stored **server** key with the configured provider, then checks ' +
      'that each wired role’s bound model is actually reachable on it.\n\n' +
      '**There is no target parameter.** It tests the saved configuration — a free-text ' +
      'model id or base URL would make this a call-arbitrary-endpoint primitive on the ' +
      'organisation’s credential.\n\n' +
      '**This returns HTTP 200 even when the test failed.** A refused connection is a ' +
      'successful diagnosis, and it is the reason this endpoint exists — read the ' +
      '`success` field, and show `error`, which carries the provider’s actual message with ' +
      'any credential redacted. Treating 200 as “AI works” reports success for every ' +
      'misconfiguration there is.\n\n' +
      '`authenticated` is reported separately from `success`: a key that authenticates but ' +
      'cannot reach a bound model is a different problem with a different fix, and told ' +
      'only “the test failed” an admin would replace a perfectly good key.\n\n' +
      'The master switch is honoured — testing while AI is off reports that rather than ' +
      'calling out anyway. Every attempt is audited, including refusals.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The outcome of the attempt. Check `success`; on failure `error` holds the ' +
      "provider's verbatim message and `roles` holds per-role reachability.",
    type: AiTestResultDto,
  })
  async testConnection(@CurrentUser('id') userId: string) {
    // Nothing from the request reaches the provider — there is no body, and no
    // parameter for one.
    return this.connectionTest.runTest(userId);
  }
}

/**
 * Resolve the capability family to filter by, from a role key or a family name.
 *
 * A free function rather than a method: it touches no state, and keeping it out
 * of the class makes it directly testable without standing up DI.
 *
 * Returns `undefined` — meaning "every family" — for anything unrecognised.
 * Rejecting instead would turn a stale client asking about a removed role into
 * an error page, when a full list is a perfectly useful answer.
 */
function resolveFamily(
  role?: string,
  family?: string,
): AiCapabilityFamily | undefined {
  if (role) {
    const fromRole = capabilityForRole(role);
    if (fromRole) return fromRole;
  }

  return (AI_CAPABILITY_FAMILIES as readonly string[]).includes(family ?? '')
    ? (family as AiCapabilityFamily)
    : undefined;
}
