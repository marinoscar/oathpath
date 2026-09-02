import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AiUsageService,
  DEFAULT_USAGE_WINDOW_DAYS,
  MAX_USAGE_WINDOW_DAYS,
} from './ai-usage.service';
import { AiUsageResponseDto } from './dto/ai-usage.dto';

// =============================================================================
// AiUsageController (issue #37, epic #25)
// =============================================================================
//
//   GET /api/ai/usage    @Auth(), no permissions
//
// CALLER-SCOPED, AND THE ROUTE TAKES NO USER ID. Same rule as
// `AiUserKeyController`, same reason: a user's consumption is their own, and
// widening that must be a signature change with a visible diff rather than a
// query-string edit. `days` is the only parameter, and it is a display
// preference.
//
// A SEPARATE CONTROLLER from the key one, even though both are `/api/ai/*`,
// because they answer to different services and this one is read-only. A
// controller that both holds credentials and reports history is a controller
// where a future "usage for user X" route looks like it belongs.
// =============================================================================

@ApiTags('AI')
@Controller('ai/usage')
export class AiUsageController {
  constructor(private readonly usage: AiUsageService) {}

  @Get()
  @Auth()
  @ApiOperation({
    summary: 'Your own recorded AI usage',
    description:
      'Token counts and call counts for **your** account over a window, with breakdowns ' +
      'by model and by the role each call served.\n\n' +
      '**This is recorded usage, not a bill.** Token counts are not dollars, this ' +
      'application carries no price table, and `callsWithUnknownUsage` counts calls whose ' +
      'consumption was never reported — a call that fails mid-stream records nothing rather ' +
      'than zero, because zero would be a claim. The authoritative figure is your own ' +
      'OpenAI dashboard.\n\n' +
      'Returns only your own rows. There is no parameter naming a user.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    description:
      `Window size in days. Defaults to ${DEFAULT_USAGE_WINDOW_DAYS}, clamped to ` +
      `1-${MAX_USAGE_WINDOW_DAYS}. An unparseable value falls back to the default rather ` +
      'than erroring — it is a display preference, and a 400 here would break the page ' +
      'over a query string.',
  })
  @ApiResponse({
    status: 200,
    description: 'Your recorded usage over the window',
    type: AiUsageResponseDto,
  })
  async getUsage(
    @CurrentUser('id') userId: string,
    @Query('days') days?: string,
  ) {
    const parsed = days !== undefined ? Number.parseInt(days, 10) : NaN;

    return this.usage.describeForUser(
      userId,
      // `Number.isInteger` rather than a bare parseInt: `parseInt('abc')` is
      // NaN, and NaN would flow into date arithmetic and produce an Invalid
      // Date whose comparison silently matches nothing — an empty page with no
      // error. The service clamps the range; this only has to reject garbage.
      Number.isInteger(parsed) ? parsed : DEFAULT_USAGE_WINDOW_DAYS,
    );
  }
}
