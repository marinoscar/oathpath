import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { AiUsage } from './ai.types';

// =============================================================================
// AiUsageService — recording and reading per-user AI consumption (issue #37)
// =============================================================================
//
// Every user brings their own OpenAI key and pays for their own consumption
// (epic #25, decision 4). Per-user visibility is the entire reason BYOK was
// chosen over a shared server key, and this is where that visibility comes
// from.
//
// -----------------------------------------------------------------------------
// RECORDING NEVER FAILS THE ORIGINATING REQUEST
// -----------------------------------------------------------------------------
//
// A usage write that throws is logged and swallowed — the same never-throw
// posture `BaseAiProvider` already takes for delivery. The user asked for a
// tutor explanation, not for bookkeeping; failing their request because an
// accounting row could not be written would trade the thing they wanted for
// the thing they did not ask about.
//
// The cost of that choice is an under-count on a database hiccup, which is
// visible in the logs and is the right side of the trade.
//
// -----------------------------------------------------------------------------
// WHAT IS NEVER RECORDED
// -----------------------------------------------------------------------------
//
// No prompt text, no completion text, no API key, no key hint. This table is
// written on every AI call, so it is the highest-volume place in the schema; a
// column holding what a learner typed during interview practice would make it
// the most sensitive one too, for a reader that does not exist. The `record`
// signature below has no parameter that could carry any of it.
// =============================================================================

/** How far back `GET /api/ai/usage` looks when the caller does not say. */
export const DEFAULT_USAGE_WINDOW_DAYS = 30;

/** The furthest back it will look. Bounds an unindexed-looking scan. */
export const MAX_USAGE_WINDOW_DAYS = 365;

/** One recorded call, as the provider hands it over. */
export interface AiUsageRecord {
  userId: string;
  provider: string;
  model: string;
  roleKey: string;
  usage: AiUsage;
  latencyMs: number | null;
  success: boolean;
  errorCode: string | null;
}

/** Totals plus the two breakdowns the page renders. */
export interface AiUsageSummary {
  /** Inclusive lower bound of the window, as an ISO string. */
  since: string;

  /** Every call in the window, successful or not. */
  calls: number;

  /** Calls that completed. `calls - successfulCalls` failed. */
  successfulCalls: number;

  /**
   * Summed token counts over the window.
   *
   * NULL COUNTS ARE EXCLUDED FROM THE SUM, NOT COUNTED AS ZERO — a mid-stream
   * failure records "unknown", and folding that into a total as 0 would state
   * a number this data does not support.
   */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;

  /**
   * Calls whose token counts are unknown.
   *
   * SURFACED, NOT HIDDEN. It is the honest caveat on every figure above: a
   * summary with 40 unaccounted calls is a different thing from one with none,
   * and the page says so rather than presenting a total as complete.
   */
  callsWithUnknownUsage: number;

  byModel: AiUsageBreakdown[];
  byRole: AiUsageBreakdown[];
}

/** One row of a breakdown. */
export interface AiUsageBreakdown {
  key: string;
  calls: number;
  totalTokens: number;
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one call. NEVER THROWS, NEVER REJECTS.
   *
   * See the header: a failed usage write must not fail the request that
   * produced it.
   *
   * @param record token counts included. `null` in any count means UNKNOWN and
   *        is stored as NULL — never coerced to 0, which would be a claim, and
   *        a false one that understates consumption.
   */
  async record(record: AiUsageRecord): Promise<void> {
    try {
      await this.prisma.aiUsageEvent.create({
        data: {
          userId: record.userId,
          provider: record.provider,
          model: record.model,
          roleKey: record.roleKey,
          // Passed through as-is. `null` is the value, not a missing one.
          promptTokens: record.usage.promptTokens,
          completionTokens: record.usage.completionTokens,
          totalTokens: record.usage.totalTokens,
          latencyMs: record.latencyMs,
          success: record.success,
          errorCode: record.errorCode,
        },
      });
    } catch (err) {
      // Logged, not raised. The user id and the model are enough to find the
      // gap; nothing about the content of the call is available here to leak.
      this.logger.error(
        `Failed to record AI usage for user ${record.userId} (${record.model}/${record.roleKey}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * The caller's own usage over a window.
   *
   * CALLER-SCOPED WITH NO USER ID PARAMETER ON THE ROUTE — the controller
   * passes the authenticated principal and nothing else, exactly as the key
   * routes do.
   *
   * @param days window size. Clamped to [1, {@link MAX_USAGE_WINDOW_DAYS}]; an
   *        out-of-range or unparseable value falls back to the default rather
   *        than erroring, because this is a display preference and a 400 here
   *        would break the page over a query string.
   */
  async describeForUser(
    userId: string,
    days: number = DEFAULT_USAGE_WINDOW_DAYS,
  ): Promise<AiUsageSummary> {
    const window = clampWindow(days);
    const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000);

    // Served by `@@index([userId, createdAt(sort: Desc)])`.
    const rows = await this.prisma.aiUsageEvent.findMany({
      where: { userId, createdAt: { gte: since } },
      select: {
        model: true,
        roleKey: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        success: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return summarise(rows, since);
  }
}

// -----------------------------------------------------------------------------
// Pure helpers — exported for direct testing
// -----------------------------------------------------------------------------

/** One row as the summary needs it. */
export interface UsageRowForSummary {
  model: string;
  roleKey: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  success: boolean;
}

/** Keep a requested window inside sane bounds. See `describeForUser`. */
export function clampWindow(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_USAGE_WINDOW_DAYS;
  return Math.min(Math.max(Math.trunc(days), 1), MAX_USAGE_WINDOW_DAYS);
}

/**
 * Total the rows and build the two breakdowns.
 *
 * NULLS ARE SKIPPED, NOT ZEROED, and `callsWithUnknownUsage` counts them. A
 * total that silently absorbed unknowns as zero would be a number this data
 * does not support, and there would be nothing on screen to say so.
 */
export function summarise(
  rows: UsageRowForSummary[],
  since: Date,
): AiUsageSummary {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let successfulCalls = 0;
  let callsWithUnknownUsage = 0;

  const byModel = new Map<string, { calls: number; totalTokens: number }>();
  const byRole = new Map<string, { calls: number; totalTokens: number }>();

  for (const row of rows) {
    if (row.success) successfulCalls += 1;

    if (row.totalTokens === null) callsWithUnknownUsage += 1;

    promptTokens += row.promptTokens ?? 0;
    completionTokens += row.completionTokens ?? 0;
    totalTokens += row.totalTokens ?? 0;

    bump(byModel, row.model, row.totalTokens ?? 0);
    bump(byRole, row.roleKey, row.totalTokens ?? 0);
  }

  return {
    since: since.toISOString(),
    calls: rows.length,
    successfulCalls,
    promptTokens,
    completionTokens,
    totalTokens,
    callsWithUnknownUsage,
    byModel: toBreakdown(byModel),
    byRole: toBreakdown(byRole),
  };
}

function bump(
  into: Map<string, { calls: number; totalTokens: number }>,
  key: string,
  tokens: number,
): void {
  const entry = into.get(key) ?? { calls: 0, totalTokens: 0 };
  entry.calls += 1;
  entry.totalTokens += tokens;
  into.set(key, entry);
}

/** Heaviest first, then by key, so the order is stable across renders. */
function toBreakdown(
  from: Map<string, { calls: number; totalTokens: number }>,
): AiUsageBreakdown[] {
  return [...from.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));
}
