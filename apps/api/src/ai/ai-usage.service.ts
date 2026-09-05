import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { Clock } from '../common/clock/clock';
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

  /**
   * One entry per UTC calendar day from `since` through today, ascending.
   *
   * ZERO-FILLED, NOT SPARSE — a day with no calls still gets an entry with
   * `calls: 0, totalTokens: 0` rather than being omitted. The chart this
   * feeds needs to render a real gap in activity as a gap, not as a
   * shorter axis that quietly skips the days nothing happened.
   */
  timeline: AiUsageTimelinePoint[];
}

/** One row of a breakdown. */
export interface AiUsageBreakdown {
  key: string;
  calls: number;
  totalTokens: number;
}

/** One day of the usage trend. */
export interface AiUsageTimelinePoint {
  /** UTC calendar date, `YYYY-MM-DD`. */
  date: string;

  calls: number;

  /**
   * Summed known token counts for this day.
   *
   * Same null-exclusion rule as the summary total: a call with unknown usage
   * still increments `calls` but contributes nothing here. There is no
   * per-day `callsWithUnknownUsage` — that caveat is already tracked once,
   * at the top level, and a second copy per day would not add information.
   */
  totalTokens: number;
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Only for "today", the upper bound of `timeline`. Per CLAUDE.md's
    // clock rule: never a bare `new Date()`, so an `X-Test-Clock`-pinned
    // instant governs where the timeline ends exactly as it governs every
    // other "now" in this codebase.
    private readonly clock: Clock,
  ) {}

  /**
   * Record one call. NEVER THROWS, NEVER REJECTS.
   *
   * See the header: a failed usage write must not fail the request that
   * produced it.
   *
   * -------------------------------------------------------------------------
   * IT RETURNS THE ROW ID, AND THAT IS WHY IT IS NOT `void` (issue #96)
   * -------------------------------------------------------------------------
   *
   * It was `Promise<void>` — the row was written and the id discarded, because
   * nothing needed to point at it. Issue #110 adds
   * `practice_attempts.ai_usage_event_id`, a foreign key from a graded attempt
   * to the exact call that graded it, and a caller cannot write that key from
   * an id this method threw away. Recovering it afterwards would mean guessing
   * — "the most recent row for this user, this model, around this time" — which
   * is a race against the user's own next call and wrong precisely when a
   * learner is answering quickly.
   *
   * `null` means THE WRITE FAILED, not "no row". The distinction is
   * load-bearing for the caller: an attempt whose grading call could not be
   * recorded still happened and must still be saved, with a null FK, rather
   * than being rejected because bookkeeping was unavailable. That is the same
   * trade the swallowed catch below already makes, extended one step outward.
   *
   * @param record token counts included. `null` in any count means UNKNOWN and
   *        is stored as NULL — never coerced to 0, which would be a claim, and
   *        a false one that understates consumption.
   * @returns the `ai_usage_events` row id, or `null` when the write failed.
   */
  async record(record: AiUsageRecord): Promise<string | null> {
    try {
      // `select: { id: true }` rather than the default full row: the id is the
      // only thing any caller wants back, and every other column is either
      // already in hand at the call site or something this table exists to
      // keep away from the rest of the app.
      const row = await this.prisma.aiUsageEvent.create({
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
        select: { id: true },
      });

      return row.id;
    } catch (err) {
      // Logged, not raised. The user id and the model are enough to find the
      // gap; nothing about the content of the call is available here to leak.
      this.logger.error(
        `Failed to record AI usage for user ${record.userId} (${record.model}/${record.roleKey}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );

      // NULL, NOT A THROW. See the doc comment: the caller links to this id if
      // it can and carries on without it if it cannot.
      return null;
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
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return summarise(rows, since, this.clock.now());
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
  createdAt: Date;
}

/** Keep a requested window inside sane bounds. See `describeForUser`. */
export function clampWindow(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_USAGE_WINDOW_DAYS;
  return Math.min(Math.max(Math.trunc(days), 1), MAX_USAGE_WINDOW_DAYS);
}

/**
 * Total the rows and build the two breakdowns plus the daily timeline.
 *
 * NULLS ARE SKIPPED, NOT ZEROED, and `callsWithUnknownUsage` counts them. A
 * total that silently absorbed unknowns as zero would be a number this data
 * does not support, and there would be nothing on screen to say so.
 *
 * A PURE FUNCTION, DELIBERATELY — `since` and `now` (the timeline's lower and
 * upper bound) both arrive as parameters rather than being read from a clock
 * in here, so this stays testable with plain fixtures and no DI. The one
 * caller that needs a real "now" (`describeForUser`) is the one that injects
 * `Clock` and passes it in.
 */
export function summarise(
  rows: UsageRowForSummary[],
  since: Date,
  now: Date,
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
    timeline: buildTimeline(rows, since, now),
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

/** A `Date` reduced to its UTC calendar day, `YYYY-MM-DD`. */
function toUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * One `AiUsageTimelinePoint` per UTC day from `since` through `now`,
 * inclusive, ascending, WITH ZERO-ACTIVITY DAYS PRESENT.
 *
 * Built in two passes rather than one: first every day in the range is
 * seeded at zero, so the shape of the output does not depend on which days
 * happen to have rows; then the rows are folded in on top. A single pass
 * that only created an entry when a row arrived would produce a sparse map
 * the frontend would have to fill in itself — exactly the gap this function
 * exists to close.
 *
 * `since`/`now` are UTC calendar days, not the caller's local timezone.
 * Unlike the interview countdown or the streak engine, a token-usage trend
 * has no "whose day is this" question to answer — every row's `createdAt` is
 * an instant, not a learner-local event — so bucketing by UTC calendar date
 * is a simpler, equally correct choice, and it is why this reaches for
 * `Date`/`toISOString` rather than `Clock.calendarDateIn`.
 */
function buildTimeline(
  rows: UsageRowForSummary[],
  since: Date,
  now: Date,
): AiUsageTimelinePoint[] {
  const byDay = new Map<string, { calls: number; totalTokens: number }>();

  // Seed every day in the window, oldest to newest, so a day with no rows
  // still ends up in the map and therefore in the output.
  const sinceKey = toUtcDateKey(since);
  const nowKey = toUtcDateKey(now);
  for (
    let cursor = Date.parse(`${sinceKey}T00:00:00.000Z`);
    cursor <= Date.parse(`${nowKey}T00:00:00.000Z`);
    cursor += 24 * 60 * 60 * 1000
  ) {
    byDay.set(toUtcDateKey(new Date(cursor)), { calls: 0, totalTokens: 0 });
  }

  for (const row of rows) {
    const key = toUtcDateKey(row.createdAt);
    // Defensive: every row is already `createdAt >= since` by the caller's
    // own query, and `now` is read after that query runs, so `key` should
    // always be in the seeded range. `?? { calls: 0, totalTokens: 0 }` means
    // an unseeded day still gets counted rather than silently dropped if
    // that ever stops being true.
    const entry = byDay.get(key) ?? { calls: 0, totalTokens: 0 };
    entry.calls += 1;
    entry.totalTokens += row.totalTokens ?? 0;
    byDay.set(key, entry);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, ...value }));
}
