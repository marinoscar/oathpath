import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccountResetService } from './account-reset.service';
import { AccountDataSummaryDto } from './dto/account-data-summary.dto';
import { AccountResetResultDto } from './dto/account-reset-result.dto';
import { ResetAccountDto } from './dto/reset-account.dto';

// =============================================================================
// AccountController — self-service account data reset (issue #270)
// =============================================================================
//
// The "Danger zone": a preview and a destructive action, both over the
// caller's OWN account:
//
//   GET  /api/account/data-summary   @Auth(), no permissions
//   POST /api/account/reset          @Auth(), no permissions
//
// -----------------------------------------------------------------------------
// NO ROUTE ACCEPTS A USER ID. THAT IS THE SECURITY BOUNDARY.
// -----------------------------------------------------------------------------
//
// Every method resolves the account from `@CurrentUser('id')` and from
// nowhere else. There is no path parameter, no query parameter and no body
// field naming a user — the same structural discipline
// `ai-user-key.controller.ts` states for the caller's own AI key, applied
// here to the caller's own DATA. Widening this to a "reset ANY user's data"
// admin action is a signature change with a visible diff at every call site
// it would need to touch, not a query-string edit.
//
// An ADMIN cannot reset another user's data through this controller either.
// That is enforced by the same property, structurally: there is no
// permission check to relax, because there is no parameter naming a target
// for a relaxed check to admit.
//
// -----------------------------------------------------------------------------
// `@Auth()` WITH NO PERMISSIONS
// -----------------------------------------------------------------------------
//
// Like the user-settings, notification-preferences, and AI-key controllers:
// every authenticated user owns their own data, and erasing it is a choice
// only its owner can make about themselves. Gating this with a permission
// string would be inventing an authorization rule this product does not
// have — "may erase OWN data" is not a privilege, it is what being the
// account holder already means.
//
// -----------------------------------------------------------------------------
// WHY THIS IS ITS OWN MODULE, NOT A ROUTE BOLTED ONTO `UsersModule`
// -----------------------------------------------------------------------------
//
// `UsersModule` is the ADMIN surface over OTHER people's accounts —
// `GET/PATCH /api/users/:id`, gated on `users:read`/`users:write`, resolving
// a target from a path parameter every route on that controller carries.
// This controller is the opposite shape on every axis: no permission, no
// target parameter, self-service only. Sharing a module would put a
// `@Auth()`-with-no-permissions route next to a dozen `users:*`-gated ones,
// which is precisely the "the gate is visible per file, not per decorator"
// argument `AiModule`'s own header already makes for keeping
// `AiUserKeyController` separate from `AiSettingsController`.
// =============================================================================

@ApiTags('Account')
@Controller('account')
export class AccountController {
  constructor(private readonly accountReset: AccountResetService) {}

  @Get('data-summary')
  @Auth()
  @ApiOperation({
    summary: 'Preview what a data reset would touch',
    description:
      'Row counts, per table, for everything `POST /api/account/reset` would ' +
      'erase for **you** — plus the exact confirmation phrase each scope ' +
      'requires. Read-only: this runs `count`, never `delete`, and calling it ' +
      'any number of times changes nothing.\n\n' +
      'This is what the "Danger zone" screen renders before a caller commits ' +
      'to anything, so the confirmation dialog can say something concrete — ' +
      '"142 practice attempts, 3 mock interviews, ..." — instead of an ' +
      'abstract warning.',
  })
  @ApiResponse({
    status: 200,
    description: 'Per-table row counts for your own data, and the two reset phrases.',
    type: AccountDataSummaryDto,
  })
  async getDataSummary(@CurrentUser('id') userId: string) {
    return this.accountReset.summarize(userId);
  }

  @Post('reset')
  @Auth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Erase your own data — irreversible',
    description:
      'Erases every row this application holds about **you**: practice and ' +
      'mock interview history, readiness and progress, English attempts, ' +
      'recorded AI usage, notifications, personal access tokens, device ' +
      'sessions, your learner profile, your app settings, and any files you ' +
      'uploaded. **This cannot be undone.**\n\n' +
      '`scope` picks how much: `data` keeps your stored AI key; ' +
      '`data_and_key` erases that too. Your account itself — your sign-in, ' +
      'your roles, your email address — is untouched either way; this is a ' +
      'data reset, not an account deletion.\n\n' +
      '`confirmationPhrase` must match the scope\'s exact phrase from ' +
      '`GET /api/account/data-summary` (`DELETE MY DATA` for `data`, ' +
      '`DELETE EVERYTHING` for `data_and_key`), **verified here on the ' +
      'server** — a disabled button on the client is not the control, this ' +
      'check is. Nothing is deleted on a mismatch.\n\n' +
      'You will receive an email confirming what was erased. That ' +
      'notification cannot be turned off.',
  })
  @ApiResponse({
    status: 200,
    description: 'What was actually deleted, and whether your AI key was removed.',
    type: AccountResetResultDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'The confirmation phrase did not match the selected scope. Nothing was deleted.',
  })
  async reset(
    @CurrentUser('id') userId: string,
    @Body() dto: ResetAccountDto,
  ) {
    return this.accountReset.reset(userId, dto.scope, dto.confirmationPhrase);
  }
}
