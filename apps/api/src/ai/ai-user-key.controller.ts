import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AiUserKeyService } from './ai-user-key.service';
import { AiStatusService } from './ai-status.service';
import { AiStatusResponseDto } from './dto/ai-status.dto';
import { AiTestResultDto } from './dto/ai-test-result.dto';
import {
  AiUserKeyStatusDto,
  UpdateAiUserKeyDto,
} from './dto/ai-user-key.dto';

// =============================================================================
// AiUserKeyController (issue #35, epic #25)
// =============================================================================
//
// The caller's OWN OpenAI key:
//
//   GET    /api/ai/key        @Auth(), no permissions
//   PUT    /api/ai/key        @Auth(), no permissions
//   DELETE /api/ai/key        @Auth(), no permissions
//   POST   /api/ai/key/test   @Auth(), no permissions
//
// and, on the sibling `/api/ai` path, the availability gate:
//
//   GET    /api/ai/status     @Auth(), no permissions
//
// -----------------------------------------------------------------------------
// NO ROUTE ACCEPTS A USER ID. THAT IS THE SECURITY BOUNDARY.
// -----------------------------------------------------------------------------
//
// Every method resolves the credential address from `@CurrentUser('id')` and
// from nowhere else. There is no path parameter, no query parameter and no
// body field naming a user, so a user cannot read, write, test or delete
// another's key by any input at all — and widening that is a signature change
// with a visible diff, not a query-string edit.
//
// An ADMIN cannot read any user's key either. That is enforced by the same
// property, structurally, rather than by a permission check a later refactor
// could relax. `CredentialsService.list('ai-user')` — which would enumerate
// every user's key metadata — is never called from this module, and
// `CredentialsModule` still has no controller of its own.
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS
// -----------------------------------------------------------------------------
//
// Like the user-settings and notification-preferences controllers: every
// authenticated user owns their own credentials. Gating these would leave a
// Viewer unable to use the app at all, since a user without a key is hard-
// blocked (#39) — the gate would make the product unusable for the role it
// was meant to restrict.
//
// It would also be inventing an authorization rule the product does not have.
// The per-user settings card (#42) declares no `permission` for exactly this
// reason, mirroring what these routes enforce.
// =============================================================================

@ApiTags('AI')
@Controller('ai')
export class AiUserKeyController {
  constructor(
    private readonly userKeys: AiUserKeyService,
    private readonly status: AiStatusService,
  ) {}

  @Get('status')
  @Auth()
  @ApiOperation({
    summary: 'Is AI available to you?',
    description:
      'Returns **two independent facts**, and deliberately no combined flag:\n\n' +
      '- `userKeyConfigured` — you have a key saved. `false` **hard-blocks** you into the ' +
      'key setup screen, framed as a first-run step rather than an error.\n' +
      '- `systemReady` — your administrator has chosen a provider, bound the models, and ' +
      'turned AI on. `false` does **not** block you: you get into the app, and AI surfaces ' +
      'explain themselves at the point of use.\n\n' +
      'Merging these would tell a user blocked by missing *administrator* configuration to ' +
      'add a key they already have — which is the single most confusing thing this surface ' +
      'could do.\n\n' +
      'Cheap by design: no outbound provider call is ever made on this path, because the ' +
      'client consults it on every navigation and a provider outage must not lock every ' +
      'user out of an application that has nothing wrong with it.\n\n' +
      'Reports nothing about the server key, the provider, or the bound model ids — only ' +
      'which of the app’s own capabilities are unconfigured.',
  })
  @ApiResponse({
    status: 200,
    description: 'The two availability facts',
    type: AiStatusResponseDto,
  })
  async getStatus(@CurrentUser('id') userId: string) {
    return this.status.describe(userId);
  }

  @Get('key')
  @Auth()
  @ApiOperation({
    summary: 'Describe your own stored AI key',
    description:
      'Whether a key is saved for **you**, its masked hint, and when it last changed. ' +
      '**The key itself is never returned** — not even to its owner. It is unreadable ' +
      'through the API by design; a lost key is replaced from the provider, not read back ' +
      'from here.\n\n' +
      'There is no parameter naming a user: the address is resolved from your session.',
  })
  @ApiResponse({
    status: 200,
    description: 'Your stored-key status',
    type: AiUserKeyStatusDto,
  })
  async getKey(@CurrentUser('id') userId: string) {
    return this.userKeys.describe(userId);
  }

  @Put('key')
  @Auth()
  @ApiOperation({
    summary: 'Save or replace your own AI key',
    description:
      'Stores the key against **your** account. `apiKey` is **write-only**: send it to ' +
      'set or rotate the key, and **omit it or send it empty to keep the stored one**.\n\n' +
      'The value is stored byte-for-byte, untrimmed — a key whose surrounding whitespace ' +
      'is significant is a real key, and altering it would produce an authentication ' +
      'failure with no visible cause.\n\n' +
      'Erasing a stored key is `DELETE`, deliberately a separate action.',
  })
  @ApiResponse({
    status: 200,
    description: 'Your updated stored-key status',
    type: AiUserKeyStatusDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'A blank key was submitted with nothing stored yet. "Blank preserves" describes an ' +
      'existing value; with nothing stored there is nothing to preserve.',
  })
  async setKey(
    @Body() dto: UpdateAiUserKeyDto,
    @CurrentUser('id') userId: string,
  ) {
    await this.userKeys.set(userId, dto.apiKey);

    // Return the status rather than an empty 200: the client needs the new
    // hint and timestamp to render the field, and a second round trip for
    // something the write already knows is a race with itself.
    return this.userKeys.describe(userId);
  }

  @Delete('key')
  @Auth()
  @ApiOperation({
    summary: 'Remove your own AI key',
    description:
      'The only way to erase a stored key, deliberately separate from `PUT` so that ' +
      'destroying a credential is always something you asked for by name rather than a ' +
      'consequence of clearing a field and saving.\n\n' +
      '**Idempotent** — removing when nothing is stored is a success, not a 404. Your goal ' +
      'is "there is no key here", and that goal is already met.\n\n' +
      'Note that removing your key re-arms the first-run gate: you will be returned to the ' +
      'key setup screen, because every AI feature runs on your own key.',
  })
  @ApiResponse({
    status: 200,
    description: 'Your stored-key status, now unconfigured',
    type: AiUserKeyStatusDto,
  })
  async deleteKey(@CurrentUser('id') userId: string) {
    await this.userKeys.remove(userId);
    return this.userKeys.describe(userId);
  }

  @Post('key/test')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test your own AI key against the models this app uses',
    description:
      'Authenticates **your** stored key, then checks that each wired role’s bound model ' +
      'is actually reachable on it — and reports the result **per role**.\n\n' +
      'This is reachability, not validity, and the distinction matters: your administrator ' +
      'binds model ids using the *server* key, and your key may sit in a different ' +
      'organisation or tier with no access to those models. A check that only asked ' +
      '"is this key valid" would pass for a key that cannot run a single request this app ' +
      'makes.\n\n' +
      '**This returns HTTP 200 even when the test failed.** Read `success`; `authenticated` ' +
      'tells you whether the key itself was accepted, which is a different problem from a ' +
      'model it cannot reach.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The outcome. Check `success`; `roles` carries per-role reachability and `error` ' +
      "the provider's verbatim message.",
    type: AiTestResultDto,
  })
  async testKey(@CurrentUser('id') userId: string) {
    return this.userKeys.test(userId);
  }
}
